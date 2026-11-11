import { z } from 'zod';
import { applyUnapplied } from '../lib/accounting/apply-unapplied.js';
import { runIdempotent } from '../lib/idempotency/run-idempotent.js';
import { dec } from '../lib/money.js';

// ADR 0002: decimal strings; numbers are normalised to a string first so
// nothing is ever rounded. Zero, negatives, exponents and >2 decimals fail.
const moneyAmount = z.union([z.string(), z.number()])
  .transform(String)
  .refine((s) => /^\d+(\.\d{1,2})?$/.test(s) && dec(s).gt(0), 'Must be a positive amount with at most 2 decimal places');

// Shared handler for POST /receipts/:id/allocations (idField 'invoiceId') and
// POST /supplier-payments/:id/allocations (idField 'billId').
export function applyUnappliedHandler({ kind, endpoint, idField, serialize, responseKey, auditAction }) {
  const bodySchema = z.object({
    allocations: z.array(z.object({ [idField]: z.string().uuid(), amount: moneyAmount }).strict()).min(1),
  }).strict();
  const outstandingAfterKey = idField === 'invoiceId' ? 'invoiceOutstandingAfter' : 'billOutstandingAfter';

  return async (req, res, next) => {
    try {
      const key = req.headers['idempotency-key'];
      if (!key) {
        const err = new Error('Idempotency-Key header is required');
        err.status = 400;
        err.code = 'idempotency_key_required';
        throw err;
      }
      const paymentId = z.string().uuid().parse(req.params.id);
      const input = bodySchema.parse(req.body);
      const actor = { userId: req.userId, organizationId: req.organizationId, roleId: req.roleId };

      const outcome = await runIdempotent(
        // The payment id is part of the hashed request: the same key and body
        // sent to another payment must not replay this one's result.
        { key, endpoint, requestBody: { paymentId, ...req.body } },
        async (tx) => {
          const result = await applyUnapplied(actor, {
            kind, paymentId, allocations: input.allocations.map((a) => ({ targetId: a[idField], amount: a.amount })),
          }, tx);
          return {
            status: 201,
            body: {
              [responseKey]: serialize(result.document),
              allocations: result.allocations.map((a) => ({ [idField]: a.targetId, amount: a.amount, [outstandingAfterKey]: a.targetOutstandingAfter })),
            },
          };
        }
      );

      if (outcome.replayed) {
        res.set('Idempotent-Replay', 'true');
      } else {
        req.auditEntry = {
          action: auditAction,
          entityType: 'Document',
          entityId: paymentId,
          before: null,
          after: { docNo: outcome.body[responseKey].docNo, allocations: outcome.body.allocations },
        };
      }
      res.status(outcome.status).json(outcome.body);
    } catch (err) {
      next(err);
    }
  };
}
