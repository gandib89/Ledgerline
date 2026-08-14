import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { authenticate } from '../middleware/authenticate.js';
import { resolveTenant } from '../middleware/resolve-tenant.js';
import { authorize } from '../middleware/authorize.js';
import { postManualEntry } from '../lib/accounting/post-manual-entry.js';
import { notFound } from '../lib/accounting/errors.js';

const router = Router();

// Every route below is tenant-scoped, same convention as masters.js.
router.use(authenticate, resolveTenant);

const PAGE_SIZE = 20;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function serializeJournalLine(line) {
  return {
    id: line.id,
    accountId: line.accountId,
    partyId: line.partyId,
    debit: line.debit.toFixed(2),
    credit: line.credit.toFixed(2),
    description: line.description,
    lineNumber: line.lineNumber,
  };
}

export function serializeJournalEntry(entry) {
  return {
    id: entry.id,
    entryNumber: entry.entryNumber,
    documentType: entry.documentType,
    entryDate: entry.entryDate.toISOString().slice(0, 10),
    description: entry.description,
    status: entry.status.toLowerCase(),
    sourceId: entry.sourceId,
    postedAt: entry.postedAt,
    lines: entry.lines ? entry.lines.map(serializeJournalLine) : undefined,
  };
}

const manualLineSchema = z.object({
  accountId: z.string().uuid(),
  debit: z.coerce.number().min(0).default(0),
  credit: z.coerce.number().min(0).default(0),
  partyId: z.string().uuid().optional(),
  description: z.string().optional(),
}).strict();

// A journal line is a debit or a credit, never both, never neither (jl_sign_check)
// — so a JV can never balance with fewer than two lines.
const createManualEntrySchema = z.object({
  entryDate: z.string().regex(DATE_RE),
  narration: z.string().min(1),
  lines: z.array(manualLineSchema).min(2),
}).strict();

router.post('/journal-entries', authorize('journal.post'), async (req, res, next) => {
  try {
    const input = createManualEntrySchema.parse(req.body);
    const actor = { userId: req.userId, organizationId: req.organizationId, roleId: req.roleId };
    const entry = await postManualEntry(actor, input);

    req.auditEntry = {
      action: 'journal_entry.posted',
      entityType: 'JournalEntry',
      entityId: entry.id,
      before: null,
      after: { entryNumber: entry.entryNumber },
    };

    res.status(201).json(serializeJournalEntry(entry));
  } catch (err) {
    next(err);
  }
});

router.get('/journal-entries', authorize('report.view'), async (req, res, next) => {
  try {
    const page = z.coerce.number().int().min(1).default(1).parse(req.query.page);
    const entries = await prisma.journalEntry.findMany({
      orderBy: [{ entryDate: 'desc' }, { entryNumber: 'desc' }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    });
    res.json(entries.map(serializeJournalEntry));
  } catch (err) {
    next(err);
  }
});

router.get('/journal-entries/:id', authorize('report.view'), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const entry = await prisma.journalEntry.findFirst({ where: { id }, include: { lines: true } });
    if (!entry) throw notFound('Journal entry not found');
    res.json(serializeJournalEntry(entry));
  } catch (err) {
    next(err);
  }
});

export default router;
