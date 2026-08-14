import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { authenticate } from '../middleware/authenticate.js';
import { resolveTenant } from '../middleware/resolve-tenant.js';
import { authorize } from '../middleware/authorize.js';
import { createPartySchemas } from '../../../shared/party-schema.js';

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

export default router;
