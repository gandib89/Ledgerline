import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { authenticate } from '../middleware/authenticate.js';
import { resolveTenant } from '../middleware/resolve-tenant.js';
import { authorize } from '../middleware/authorize.js';
import { createPartySchemas } from '../../../shared/party-schema.js';
import { serializeTaxCode } from './day3-contracts.js';
import { notFound } from '../lib/accounting/errors.js';
import { createFiscalYearWithPeriods, nextFiscalYearWindow } from '../lib/orgs/starter-kit.js';

const router = Router();

// Every route below is tenant-scoped: the extension injects organizationId
// from request context, so no handler here ever writes a where-clause for it.
router.use(authenticate, resolveTenant);

const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'];
const PAGE_SIZE = 20;
const { createPartySchema, updatePartySchema } = createPartySchemas(z);

function serializeAccount(account) {
  return {
    id: account.id,
    code: account.code,
    name: account.name,
    type: account.type,
    isControlAccount: account.isControlAccount,
    isBankAccount: account.isBankAccount,
    isActive: account.isActive,
  };
}

// The contract speaks lowercase (customer/supplier/both); Prisma's enum is
// uppercase. Translate at the boundary, both directions.
function serializeParty(party) {
  return {
    id: party.id,
    type: party.type.toLowerCase(),
    code: party.code,
    name: party.name,
    email: party.email,
    phone: party.phone,
    creditDays: party.creditDays,
    isActive: party.isActive,
  };
}

function asDate(value) {
  return value.toISOString().slice(0, 10);
}

router.get('/accounts', authorize('report.view'), async (req, res, next) => {
  try {
    const type = z.enum(ACCOUNT_TYPES).optional().parse(req.query.type);
    const accounts = await prisma.account.findMany({
      where: type ? { type } : {},
      orderBy: { code: 'asc' },
    });
    res.json(accounts.map(serializeAccount));
  } catch (err) {
    next(err);
  }
});

const createAccountSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(ACCOUNT_TYPES),
}).strict();

router.post('/accounts', authorize('org.manage'), async (req, res, next) => {
  try {
    const data = createAccountSchema.parse(req.body);
    const account = await prisma.account.create({ data });

    req.auditEntry = {
      action: 'account.create',
      entityType: 'Account',
      entityId: account.id,
      before: null,
      after: serializeAccount(account),
    };

    res.status(201).json(serializeAccount(account));
  } catch (err) {
    next(err);
  }
});

// Roles are global reference data (seed.js: "not tenant data"), but this
// list only exists to populate the role picker on the add-member form, so
// it's gated the same as that write (org.manage) rather than left open.
router.get('/roles', authorize('org.manage'), async (req, res, next) => {
  try {
    const roles = await prisma.role.findMany({ orderBy: { name: 'asc' } });
    res.json(roles.map((role) => ({ id: role.id, name: role.name })));
  } catch (err) {
    next(err);
  }
});

const listPartiesSchema = z.object({
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
});

router.get('/parties', authorize('report.view'), async (req, res, next) => {
  try {
    const { search, page } = listPartiesSchema.parse(req.query);
    const parties = await prisma.party.findMany({
      where: search ? { name: { contains: search, mode: 'insensitive' } } : {},
      orderBy: { code: 'asc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    });
    res.json(parties.map(serializeParty));
  } catch (err) {
    next(err);
  }
});

router.post('/parties', authorize('org.manage'), async (req, res, next) => {
  try {
    const { type, ...rest } = createPartySchema.parse(req.body);
    const party = await prisma.party.create({
      data: { ...rest, type: type.toUpperCase() },
    });

    req.auditEntry = {
      action: 'party.create',
      entityType: 'Party',
      entityId: party.id,
      before: null,
      after: serializeParty(party),
    };

    res.status(201).json(serializeParty(party));
  } catch (err) {
    next(err);
  }
});

router.get('/tax-codes', authorize('report.view'), async (req, res, next) => {
  try {
    const taxCodes = await prisma.taxCode.findMany({
      where: { isActive: true },
      orderBy: { code: 'asc' },
    });
    res.json(taxCodes.map(serializeTaxCode));
  } catch (err) {
    next(err);
  }
});

router.patch('/parties/:id', authorize('org.manage'), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const parsed = updatePartySchema.parse(req.body);
    const before = await prisma.party.findFirst({ where: { id } });

    if (!before) {
      const err = new Error('Party not found');
      err.status = 404;
      err.code = 'party_not_found';
      throw err;
    }

    const { type, ...rest } = parsed;
    const party = await prisma.party.update({
      where: { id },
      data: { ...rest, ...(type ? { type: type.toUpperCase() } : {}) },
    });

    req.auditEntry = {
      action: 'party.update',
      entityType: 'Party',
      entityId: party.id,
      before: serializeParty(before),
      after: serializeParty(party),
    };

    res.json(serializeParty(party));
  } catch (err) {
    next(err);
  }
});

router.get('/fiscal-years', authorize('report.view'), async (req, res, next) => {
  try {
    const fiscalYears = await prisma.fiscalYear.findMany({ orderBy: { startDate: 'asc' } });
    res.json(fiscalYears.map((fy) => ({
      id: fy.id,
      label: fy.label,
      startDate: asDate(fy.startDate),
      endDate: asDate(fy.endDate),
      isClosed: fy.isClosed,
    })));
  } catch (err) {
    next(err);
  }
});

// A fiscal year only ever gets longer into the future by seeding (starter
// kit) or by rolling forward here — nothing ever advances it automatically,
// so an org that outlives its last fiscal year is stuck posting nothing
// until its owner calls this. AD dates only, same approximation as the
// starter kit (see starter-kit.js) — no real Bikram Sambat conversion.
router.post('/fiscal-years', authorize('org.manage'), async (req, res, next) => {
  try {
    const latest = await prisma.fiscalYear.findFirst({
      where: { organizationId: req.organizationId },
      orderBy: { endDate: 'desc' },
    });
    if (!latest) throw notFound('No existing fiscal year to roll forward from');

    const fiscalYear = await prisma.$transaction((tx) => createFiscalYearWithPeriods(
      tx, req.organizationId, nextFiscalYearWindow(latest),
    ));

    req.auditEntry = {
      action: 'fiscalYear.create',
      entityType: 'FiscalYear',
      entityId: fiscalYear.id,
      before: null,
      after: { label: fiscalYear.label, startDate: asDate(fiscalYear.startDate), endDate: asDate(fiscalYear.endDate) },
    };

    res.status(201).json({
      id: fiscalYear.id,
      label: fiscalYear.label,
      startDate: asDate(fiscalYear.startDate),
      endDate: asDate(fiscalYear.endDate),
      isClosed: fiscalYear.isClosed,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/periods', authorize('report.view'), async (req, res, next) => {
  try {
    const fiscalYearId = z.string().uuid().optional().parse(req.query.fiscalYearId);

    // AccountingPeriod has no organizationId column, so the tenant extension
    // cannot scope it — the filter goes through its parent fiscal year instead.
    const periods = await prisma.accountingPeriod.findMany({
      where: {
        fiscalYear: { organizationId: req.organizationId },
        ...(fiscalYearId ? { fiscalYearId } : {}),
      },
      orderBy: { startDate: 'asc' },
    });

    res.json(periods.map((p) => ({
      id: p.id,
      fiscalYearId: p.fiscalYearId,
      label: p.label,
      startDate: asDate(p.startDate),
      endDate: asDate(p.endDate),
      isOpen: p.isOpen,
    })));
  } catch (err) {
    next(err);
  }
});

const updatePeriodSchema = z.object({ isOpen: z.boolean() }).strict();

// Closing the books is an organizational control, not an accounting action
// — org.manage (Owner-only), same tier as the rest of this file's org-level
// settings. AccountingPeriod has no organizationId column (§ period model),
// so ownership is verified through fiscalYear.organizationId first, same as
// GET /periods above.
router.patch('/periods/:id', authorize('org.manage'), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const { isOpen } = updatePeriodSchema.parse(req.body);

    const existing = await prisma.accountingPeriod.findFirst({
      where: { id, fiscalYear: { organizationId: req.organizationId } },
    });
    if (!existing) throw notFound('Accounting period not found');

    const period = await prisma.accountingPeriod.update({ where: { id }, data: { isOpen } });

    req.auditEntry = {
      action: isOpen ? 'period.unlocked' : 'period.locked',
      entityType: 'AccountingPeriod',
      entityId: period.id,
      before: { isOpen: existing.isOpen },
      after: { isOpen: period.isOpen },
    };

    res.json({
      id: period.id,
      fiscalYearId: period.fiscalYearId,
      label: period.label,
      startDate: asDate(period.startDate),
      endDate: asDate(period.endDate),
      isOpen: period.isOpen,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
