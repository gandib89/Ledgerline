import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { authenticate } from '../middleware/authenticate.js';
import { resolveTenant } from '../middleware/resolve-tenant.js';
import { authorize } from '../middleware/authorize.js';
import { postSupplierPayment } from '../lib/accounting/supplier-payment-service.js';
import { runIdempotent } from '../lib/idempotency/run-idempotent.js';
import { notFound } from '../lib/accounting/errors.js';
import { dec } from '../lib/money.js';
import { serializeJournalEntry } from './journal-entries.js';

const router = Router();

router.use(authenticate, resolveTenant);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function actorFrom(req) {
  return { userId: req.userId, organizationId: req.organizationId, roleId: req.roleId };
}

function serializeSupplierPayment(doc) {
  return {
    id: doc.id,
    docType: 'supplier_payment',
    docNo: doc.docNo,
    docDate: doc.docDate.toISOString().slice(0, 10),
    partyId: doc.partyId,
    status: doc.status.toLowerCase(),
    referenceNo: doc.referenceNo,
    notes: doc.notes,
    grandTotal: doc.grandTotal.toFixed(2),
    allocatedAmount: doc.allocatedAmount.toFixed(2),
    // The Unapplied Amount: what is left of the payment after its allocations.
    outstandingAmount: doc.outstandingAmount.toFixed(2),
    journalEntryId: doc.journalEntryId,
  };
}

// ADR 0002: amounts are decimal strings. Numbers are still accepted (existing
// clients) but are normalised to a string first, so nothing is ever rounded:
// more than 2 decimal places, zero, negatives and exponent forms are rejected.
const moneyAmount = z.union([z.string(), z.number()])
  .transform(String)
  .refine((s) => /^\d+(\.\d{1,2})?$/.test(s) && dec(s).gt(0), 'Must be a positive amount with at most 2 decimal places');

const allocationSchema = z.object({
  billId: z.string().uuid(),
  amount: moneyAmount,
}).strict();

const createSupplierPaymentSchema = z.object({
  partyId: z.string().uuid(),
  docDate: z.string().regex(DATE_RE),
  paidFromAccountId: z.string().uuid(),
  amount: moneyAmount,
  referenceNo: z.string().optional(),
  notes: z.string().optional(),
  allocations: z.array(allocationSchema).default([]),
}).strict();

// Posts immediately on create and requires an Idempotency-Key: a retried
// request must never pay a Supplier twice.
router.post('/supplier-payments', authorize('supplier_payment.create'), async (req, res, next) => {
  try {
    const key = req.headers['idempotency-key'];
    if (!key) {
      const err = new Error('Idempotency-Key header is required');
      err.status = 400;
      err.code = 'idempotency_key_required';
      throw err;
    }
    const input = createSupplierPaymentSchema.parse(req.body);
    const actor = actorFrom(req);

    const outcome = await runIdempotent(
      { key, endpoint: 'POST /supplier-payments', requestBody: req.body },
      async (tx) => {
        const result = await postSupplierPayment(actor, input, tx);
        return {
          status: 201,
          body: {
            supplierPayment: serializeSupplierPayment(result.document),
            journalEntry: serializeJournalEntry(result.journalEntry),
            allocations: result.allocations,
          },
        };
      }
    );

    if (outcome.replayed) {
      res.set('Idempotent-Replay', 'true');
    } else {
      req.auditEntry = {
        action: 'supplier_payment.posted',
        entityType: 'Document',
        entityId: outcome.body.supplierPayment.id,
        before: null,
        after: { docNo: outcome.body.supplierPayment.docNo, allocations: outcome.body.allocations },
      };
    }
    res.status(outcome.status).json(outcome.body);
  } catch (err) {
    next(err);
  }
});

router.get('/supplier-payments/:id', authorize('report.view'), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const doc = await prisma.document.findFirst({ where: { id, organizationId: req.organizationId, docType: 'SUPPLIER_PAYMENT' } });
    if (!doc) throw notFound('Supplier Payment not found');

    const allocations = await prisma.paymentAllocation.findMany({ where: { organizationId: req.organizationId, paymentDocumentId: id } });

    res.json({
      ...serializeSupplierPayment(doc),
      allocations: allocations.map((a) => ({
        billId: a.targetDocumentId,
        amount: a.amount.toFixed(2),
        allocatedAt: a.allocatedAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
