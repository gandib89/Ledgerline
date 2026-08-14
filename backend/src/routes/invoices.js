import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { authenticate } from '../middleware/authenticate.js';
import { resolveTenant } from '../middleware/resolve-tenant.js';
import { authorize } from '../middleware/authorize.js';
import { createDraftInvoice, updateDraftInvoice, previewInvoice } from '../lib/invoices/invoice-service.js';
import { postDocument } from '../lib/accounting/post-document.js';
import { notFound } from '../lib/accounting/errors.js';
import { serializeJournalEntry } from './journal-entries.js';

const router = Router();

// Every route below is tenant-scoped: the extension injects organizationId
// from request context, so no handler here ever writes a where-clause for it.
router.use(authenticate, resolveTenant);

const PAGE_SIZE = 20;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = ['draft', 'posted', 'partially_paid', 'paid', 'reversed'];

function actorFrom(req) {
  return { userId: req.userId, organizationId: req.organizationId, roleId: req.roleId };
}

function serializeLine(line) {
  return {
    id: line.id,
    lineNo: line.lineNo,
    description: line.description,
    accountId: line.accountId,
    quantity: line.quantity.toString(),
    unitPrice: line.unitPrice.toFixed(2),
    discountPct: line.discountPct.toFixed(2),
    taxCodeId: line.taxCodeId,
    taxableAmount: line.taxableAmount.toFixed(2),
    taxAmount: line.taxAmount.toFixed(2),
    lineTotal: line.lineTotal.toFixed(2),
  };
}

function serializeInvoice(doc) {
  return {
    id: doc.id,
    docType: 'invoice',
    docNo: doc.docNo,
    docDate: doc.docDate.toISOString().slice(0, 10),
    dueDate: doc.dueDate ? doc.dueDate.toISOString().slice(0, 10) : null,
    partyId: doc.partyId,
    status: doc.status.toLowerCase(),
    referenceNo: doc.referenceNo,
    notes: doc.notes,
    subtotal: doc.subtotal.toFixed(2),
    discountAmount: doc.discountAmount.toFixed(2),
    taxableAmount: doc.taxableAmount.toFixed(2),
    taxAmount: doc.taxAmount.toFixed(2),
    grandTotal: doc.grandTotal.toFixed(2),
    outstandingAmount: doc.outstandingAmount.toFixed(2),
    journalEntryId: doc.journalEntryId,
    version: doc.version,
    lines: doc.lines ? doc.lines.map(serializeLine) : undefined,
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

const createInvoiceSchema = z.object({
  partyId: z.string().uuid(),
  docDate: z.string().regex(DATE_RE),
  dueDate: z.string().regex(DATE_RE).optional(),
  referenceNo: z.string().optional(),
  notes: z.string().optional(),
  lines: z.array(lineInputSchema).min(1),
}).strict();

// version is required — the client must send back the version it last read
// (UPDATE ... WHERE id = ? AND version = ?, §6). lines is required too and
// replaces the set wholesale; the header fields are partial.
const updateInvoiceSchema = z.object({
  version: z.number().int().min(0),
  partyId: z.string().uuid().optional(),
  docDate: z.string().regex(DATE_RE).optional(),
  dueDate: z.string().regex(DATE_RE).optional(),
  referenceNo: z.string().optional(),
  notes: z.string().optional(),
  lines: z.array(lineInputSchema).min(1),
}).strict();

const previewSchema = z.object({ lines: z.array(lineInputSchema).min(1) }).strict();

router.post('/invoices/preview', authorize('invoice.create'), async (req, res, next) => {
  try {
    const input = previewSchema.parse(req.body);
    const { lines, totals } = await previewInvoice(actorFrom(req), input);

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

router.post('/invoices', authorize('invoice.create'), async (req, res, next) => {
  try {
    const input = createInvoiceSchema.parse(req.body);
    const doc = await createDraftInvoice(actorFrom(req), input);

    req.auditEntry = {
      action: 'invoice.create',
      entityType: 'Document',
      entityId: doc.id,
      before: null,
      after: serializeInvoice(doc),
    };

    res.status(201).json(serializeInvoice(doc));
  } catch (err) {
    next(err);
  }
});

router.get('/invoices', authorize('report.view'), async (req, res, next) => {
  try {
    const query = z.object({
      status: z.enum(STATUSES).optional(),
      partyId: z.string().uuid().optional(),
      page: z.coerce.number().int().min(1).default(1),
    }).parse(req.query);

    const docs = await prisma.document.findMany({
      where: {
        docType: 'INVOICE',
        ...(query.status ? { status: query.status.toUpperCase() } : {}),
        ...(query.partyId ? { partyId: query.partyId } : {}),
      },
      orderBy: { docDate: 'desc' },
      skip: (query.page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    });

    res.json(docs.map(serializeInvoice));
  } catch (err) {
    next(err);
  }
});

router.get('/invoices/:id', authorize('report.view'), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const doc = await prisma.document.findFirst({ where: { id, docType: 'INVOICE' }, include: { lines: true } });
    if (!doc) throw notFound('Invoice not found');
    res.json(serializeInvoice(doc));
  } catch (err) {
    next(err);
  }
});

router.patch('/invoices/:id', authorize('invoice.create'), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const { version, ...input } = updateInvoiceSchema.parse(req.body);
    const doc = await updateDraftInvoice(actorFrom(req), id, version, input);

    req.auditEntry = {
      action: 'invoice.update',
      entityType: 'Document',
      entityId: doc.id,
      before: null,
      after: serializeInvoice(doc),
    };

    res.json(serializeInvoice(doc));
  } catch (err) {
    next(err);
  }
});

router.post('/invoices/:id/post', authorize('invoice.post'), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const entry = await postDocument(id, actorFrom(req));
    const [doc, fullEntry] = await Promise.all([
      prisma.document.findUniqueOrThrow({ where: { id }, include: { lines: true } }),
      prisma.journalEntry.findUniqueOrThrow({ where: { id: entry.id }, include: { lines: true } }),
    ]);

    req.auditEntry = {
      action: 'invoice.posted',
      entityType: 'Document',
      entityId: doc.id,
      before: null,
      after: { docNo: doc.docNo, journalEntryId: doc.journalEntryId },
    };

    res.json({ invoice: serializeInvoice(doc), journalEntry: serializeJournalEntry(fullEntry) });
  } catch (err) {
    next(err);
  }
});

export default router;
