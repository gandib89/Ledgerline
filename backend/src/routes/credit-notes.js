import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { authenticate } from '../middleware/authenticate.js';
import { resolveTenant } from '../middleware/resolve-tenant.js';
import { authorize } from '../middleware/authorize.js';
import { postCreditNote } from '../lib/accounting/credit-note-service.js';
import { notFound } from '../lib/accounting/errors.js';
import { serializeJournalEntry } from './journal-entries.js';

const router = Router();

router.use(authenticate, resolveTenant);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

function serializeCreditNote(doc) {
  return {
    id: doc.id,
    docType: 'credit_note',
    docNo: doc.docNo,
    docDate: doc.docDate.toISOString().slice(0, 10),
    partyId: doc.partyId,
    parentDocumentId: doc.parentDocumentId,
    status: doc.status.toLowerCase(),
    referenceNo: doc.referenceNo,
    notes: doc.notes,
    subtotal: doc.subtotal.toFixed(2),
    discountAmount: doc.discountAmount.toFixed(2),
    taxableAmount: doc.taxableAmount.toFixed(2),
    taxAmount: doc.taxAmount.toFixed(2),
    grandTotal: doc.grandTotal.toFixed(2),
    journalEntryId: doc.journalEntryId,
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

const createCreditNoteSchema = z.object({
  invoiceId: z.string().uuid(),
  docDate: z.string().regex(DATE_RE),
  referenceNo: z.string().optional(),
  notes: z.string().optional(),
  lines: z.array(lineInputSchema).min(1),
}).strict();

// Correcting a posted invoice is the same trust tier as posting one — reuses
// invoice.post rather than a new permission code (§5 permission matrix has
// no distinct credit-note code).
router.post('/credit-notes', authorize('invoice.post'), async (req, res, next) => {
  try {
    const input = createCreditNoteSchema.parse(req.body);
    const result = await postCreditNote(actorFrom(req), input);

    req.auditEntry = {
      action: 'credit_note.posted',
      entityType: 'Document',
      entityId: result.document.id,
      before: null,
      after: { docNo: result.document.docNo, invoiceId: result.invoice.id, invoiceOutstandingAfter: result.invoice.outstandingAmount.toFixed(2) },
    };

    res.status(201).json({
      creditNote: serializeCreditNote(result.document),
      journalEntry: serializeJournalEntry(result.journalEntry),
      invoiceOutstandingAfter: result.invoice.outstandingAmount.toFixed(2),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/credit-notes/:id', authorize('report.view'), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const doc = await prisma.document.findFirst({ where: { id, docType: 'CREDIT_NOTE' }, include: { lines: true } });
    if (!doc) throw notFound('Credit note not found');
    res.json(serializeCreditNote(doc));
  } catch (err) {
    next(err);
  }
});

export default router;
