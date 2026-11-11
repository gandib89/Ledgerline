import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { authenticate } from '../middleware/authenticate.js';
import { resolveTenant } from '../middleware/resolve-tenant.js';
import { authorize } from '../middleware/authorize.js';
import { createDraftBill, updateDraftBill, previewBill } from '../lib/invoices/bill-service.js';
import { deleteDraftDocument } from '../lib/accounting/delete-draft.js';
import { postDocument } from '../lib/accounting/post-document.js';
import { getBillPaymentHistory } from '../lib/accounting/payment-history.js';
import { notFound } from '../lib/accounting/errors.js';
import { serializeJournalEntry } from './journal-entries.js';
import { serializeInvoice } from './invoices.js';

const router = Router();

router.use(authenticate, resolveTenant);

const PAGE_SIZE = 20;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = ['draft', 'posted', 'partially_paid', 'paid', 'reversed'];

function actorFrom(req) {
  return { userId: req.userId, organizationId: req.organizationId, roleId: req.roleId };
}

// A Bill serializes like an Invoice plus its Posting Date. Supplier Reference
// is the document's referenceNo, kept under that name.
function serializeBill(doc) {
  return {
    ...serializeInvoice(doc),
    docType: 'bill',
    postingDate: doc.postingDate.toISOString().slice(0, 10),
  };
}

const lineInputSchema = z.object({
  accountId: z.string().uuid(),
  description: z.string().min(1),
  quantity: z.coerce.number().positive(),
  unitPrice: z.coerce.number().min(0),
  discountPct: z.coerce.number().min(0).max(100).optional(),
  taxCodeId: z.string().uuid().optional(),
}).strict();

const createBillSchema = z.object({
  partyId: z.string().uuid(),
  referenceNo: z.string(),
  docDate: z.string().regex(DATE_RE),
  postingDate: z.string().regex(DATE_RE).optional(),
  dueDate: z.string().regex(DATE_RE).optional(),
  notes: z.string().optional(),
  lines: z.array(lineInputSchema).min(1),
}).strict();

const updateBillSchema = z.object({
  version: z.number().int().min(0),
  partyId: z.string().uuid().optional(),
  referenceNo: z.string().optional(),
  docDate: z.string().regex(DATE_RE).optional(),
  postingDate: z.string().regex(DATE_RE).optional(),
  dueDate: z.string().regex(DATE_RE).optional(),
  notes: z.string().optional(),
  lines: z.array(lineInputSchema).min(1),
}).strict();

const previewSchema = z.object({ lines: z.array(lineInputSchema).min(1) }).strict();

router.post('/bills/preview', authorize('bill.create'), async (req, res, next) => {
  try {
    const { lines, totals } = await previewBill(actorFrom(req), previewSchema.parse(req.body));
    res.json({
      lines: lines.map((l) => ({
        lineNo: l.lineNo,
        taxableAmount: l.taxableAmount.toFixed(2),
        taxAmount: l.taxAmount.toFixed(2),
        lineTotal: l.lineTotal.toFixed(2),
      })),
      totals: {
        subtotal: totals.subtotal.toFixed(2),
        discountAmount: totals.discountAmount.toFixed(2),
        taxableAmount: totals.taxableAmount.toFixed(2),
        taxAmount: totals.taxAmount.toFixed(2),
        grandTotal: totals.grandTotal.toFixed(2),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/bills', authorize('bill.create'), async (req, res, next) => {
  try {
    const doc = await createDraftBill(actorFrom(req), createBillSchema.parse(req.body));
    req.auditEntry = { action: 'bill.created', entityType: 'Document', entityId: doc.id, before: null, after: serializeBill(doc) };
    res.status(201).json(serializeBill(doc));
  } catch (err) {
    next(err);
  }
});

router.get('/bills', authorize('report.view'), async (req, res, next) => {
  try {
    const query = z.object({
      status: z.enum(STATUSES).optional(),
      partyId: z.string().uuid().optional(),
      page: z.coerce.number().int().min(1).default(1),
    }).parse(req.query);

    const docs = await prisma.document.findMany({
      where: {
        organizationId: req.organizationId,
        docType: 'BILL',
        ...(query.status ? { status: query.status.toUpperCase() } : {}),
        ...(query.partyId ? { partyId: query.partyId } : {}),
      },
      orderBy: [{ docDate: 'desc' }, { createdAt: 'desc' }],
      skip: (query.page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    });
    res.json(docs.map(serializeBill));
  } catch (err) {
    next(err);
  }
});

router.get('/bills/:id', authorize('report.view'), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const doc = await prisma.document.findFirst({
      where: { id, organizationId: req.organizationId, docType: 'BILL' },
      include: { lines: true },
    });
    if (!doc) throw notFound('Bill not found');
    res.json(serializeBill(doc));
  } catch (err) {
    next(err);
  }
});

router.get('/bills/:id/payments', authorize('report.view'), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    res.json(await getBillPaymentHistory(prisma, req.organizationId, id));
  } catch (err) {
    next(err);
  }
});

router.patch('/bills/:id', authorize('bill.create'), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const { version, ...input } = updateBillSchema.parse(req.body);
    const doc = await updateDraftBill(actorFrom(req), id, version, input);
    req.auditEntry = { action: 'bill.updated', entityType: 'Document', entityId: doc.id, before: null, after: serializeBill(doc) };
    res.json(serializeBill(doc));
  } catch (err) {
    next(err);
  }
});

router.delete('/bills/:id', authorize('bill.create'), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const doc = await deleteDraftDocument(actorFrom(req), id, 'BILL', 'Bill');
    req.auditEntry = { action: 'bill.deleted', entityType: 'Document', entityId: doc.id, before: serializeBill(doc), after: null };
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.post('/bills/:id/post',authorize('bill.post'), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const entry = await postDocument(id, actorFrom(req));
    const [doc, fullEntry] = await Promise.all([
      prisma.document.findFirstOrThrow({ where: { id, organizationId: req.organizationId }, include: { lines: true } }),
      prisma.journalEntry.findFirstOrThrow({ where: { id: entry.id, organizationId: req.organizationId }, include: { lines: true } }),
    ]);

    req.auditEntry = {
      action: 'bill.posted',
      entityType: 'Document',
      entityId: doc.id,
      before: null,
      after: { docNo: doc.docNo, journalEntryId: doc.journalEntryId },
    };

    res.json({ bill: serializeBill(doc), journalEntry: serializeJournalEntry(fullEntry) });
  } catch (err) {
    next(err);
  }
});

export default router;
