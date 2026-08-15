import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { authenticate } from '../middleware/authenticate.js';
import { resolveTenant } from '../middleware/resolve-tenant.js';
import { authorize } from '../middleware/authorize.js';
import { postReceipt } from '../lib/accounting/receipt-service.js';
import { runIdempotent } from '../lib/idempotency/run-idempotent.js';
import { notFound } from '../lib/accounting/errors.js';
import { serializeJournalEntry } from './journal-entries.js';

const router = Router();

router.use(authenticate, resolveTenant);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function actorFrom(req) {
  return { userId: req.userId, organizationId: req.organizationId, roleId: req.roleId };
}

function serializeReceipt(doc) {
  return {
    id: doc.id,
    docType: 'receipt',
    docNo: doc.docNo,
    docDate: doc.docDate.toISOString().slice(0, 10),
    partyId: doc.partyId,
    status: doc.status.toLowerCase(),
    referenceNo: doc.referenceNo,
    notes: doc.notes,
    grandTotal: doc.grandTotal.toFixed(2),
    allocatedAmount: doc.allocatedAmount.toFixed(2),
    outstandingAmount: doc.outstandingAmount.toFixed(2),
    journalEntryId: doc.journalEntryId,
  };
}

function serializeResult(result) {
  return {
    receipt: serializeReceipt(result.document),
    journalEntry: serializeJournalEntry(result.journalEntry),
    allocations: result.allocations,
  };
}

const allocationSchema = z.object({
  invoiceId: z.string().uuid(),
  amount: z.coerce.number().positive(),
}).strict();

const createReceiptSchema = z.object({
  partyId: z.string().uuid(),
  docDate: z.string().regex(DATE_RE),
  depositAccountId: z.string().uuid(),
  amount: z.coerce.number().positive(),
  referenceNo: z.string().optional(),
  notes: z.string().optional(),
  allocations: z.array(allocationSchema).default([]),
}).strict();

// No separate approval step — receipts post immediately on create, gated by
// payment.create alone (§5 permission matrix has no distinct "payment.post"
// code; cash received is a fact, not a decision the way posting an invoice
// to the ledger is).
router.post('/receipts', authorize('payment.create'), async (req, res, next) => {
  try {
    const input = createReceiptSchema.parse(req.body);
    const actor = actorFrom(req);
    const key = req.headers['idempotency-key'];

    let status;
    let body;
    let replayed = false;

    if (key) {
      const outcome = await runIdempotent(
        { key, endpoint: 'POST /receipts', requestBody: req.body },
        async (tx) => {
          const result = await postReceipt(actor, input, tx);
          return { status: 201, body: serializeResult(result) };
        }
      );
      replayed = outcome.replayed;
      status = outcome.status;
      body = outcome.body;
    } else {
      const result = await postReceipt(actor, input);
      status = 201;
      body = serializeResult(result);
    }

    if (replayed) {
      res.set('Idempotent-Replay', 'true');
    } else {
      req.auditEntry = {
        action: 'receipt.posted',
        entityType: 'Document',
        entityId: body.receipt.id,
        before: null,
        after: { docNo: body.receipt.docNo, allocations: body.allocations },
      };
    }

    res.status(status).json(body);
  } catch (err) {
    next(err);
  }
});

router.get('/receipts/:id', authorize('report.view'), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const doc = await prisma.document.findFirst({ where: { id, docType: 'RECEIPT' } });
    if (!doc) throw notFound('Receipt not found');

    const allocations = await prisma.paymentAllocation.findMany({ where: { paymentDocumentId: id } });

    res.json({
      ...serializeReceipt(doc),
      allocations: allocations.map((a) => ({
        invoiceId: a.targetDocumentId,
        amount: a.amount.toFixed(2),
        allocatedAt: a.allocatedAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
