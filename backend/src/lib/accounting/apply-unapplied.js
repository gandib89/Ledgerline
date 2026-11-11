import { prisma } from '../../db/client.js';
import { Prisma } from '../../generated/prisma/index.js';
import { notFound, businessRule } from './errors.js';
import { add, sub, dec, isZero } from '../money.js';

// Allocates (part of) an already-posted Receipt's or Supplier Payment's
// Unapplied Amount to open Invoices / Bills. Pure sub-ledger operation: the
// payment's journal entry already moved the whole amount through the Control
// Account, so no journal entry is written and the Aging totals do not move.
// Same optional-`tx` contract as postReceipt (the route passes
// runIdempotent()'s transaction).
//
// Lock order matches reverseEntry's: the payment row first, then every target
// in ONE id-ordered query. Locking payment and targets in a single id-ordered
// query would deadlock with a concurrent reversal of this payment whenever a
// target id sorts before the payment id (reversal holds the payment and wants
// the targets). Two applies on one payment serialize on the payment lock; two
// applies on different payments share targets in id order. No counters are
// touched, so there is nothing to lock after.
export const PAYMENT_KINDS = {
  receipt: {
    paymentType: 'RECEIPT', targetType: 'INVOICE', paymentLabel: 'Receipt', targetLabel: 'Invoice',
    notTarget: 'not_an_invoice', notOpen: 'invoice_not_open',
  },
  supplierPayment: {
    paymentType: 'SUPPLIER_PAYMENT', targetType: 'BILL', paymentLabel: 'Supplier Payment', targetLabel: 'Bill',
    notTarget: 'not_a_bill', notOpen: 'bill_not_open',
  },
};

// allocations: [{ targetId, amount }] with amount a positive 2-decimal string.
export async function applyUnapplied(actor, { kind, paymentId, allocations }, tx = prisma) {
  const k = PAYMENT_KINDS[kind];
  const run = async (tx) => {
    const org = actor.organizationId;
    const targetIds = allocations.map((a) => a.targetId);
    if (new Set(targetIds).size !== targetIds.length) {
      throw businessRule('duplicate_allocation', `Each ${k.targetLabel} can appear only once in a request's allocations`);
    }

    const [payment] = await tx.$queryRaw`
      SELECT * FROM "Document" WHERE id = ${paymentId} AND "organizationId" = ${org} FOR UPDATE
    `;
    if (!payment || payment.docType !== k.paymentType) throw notFound(`${k.paymentLabel} not found`);
    if (payment.status !== 'POSTED') {
      throw businessRule('payment_not_posted', `${k.paymentLabel} ${payment.id} is not posted (status ${payment.status})`);
    }

    const locked = await tx.$queryRaw`
      SELECT * FROM "Document"
      WHERE id IN (${Prisma.join([...targetIds].sort())}) AND "organizationId" = ${org}
      ORDER BY id
      FOR UPDATE
    `;
    const targetsById = new Map(locked.map((d) => [d.id, d]));
    for (const id of targetIds) {
      if (!targetsById.has(id)) throw notFound(`${k.targetLabel} ${id} not found`);
    }

    let total = dec(0);
    for (const a of allocations) {
      const target = targetsById.get(a.targetId);
      const amount = dec(a.amount);
      if (target.docType !== k.targetType) {
        throw businessRule(k.notTarget, `Document ${target.id} is not a${k.targetType === 'INVOICE' ? 'n' : ''} ${k.targetLabel}`);
      }
      if (target.partyId !== payment.partyId) {
        throw businessRule('party_mismatch', `${k.targetLabel} ${target.id} belongs to a different party than the ${k.paymentLabel}`);
      }
      if (!['POSTED', 'PARTIALLY_PAID'].includes(target.status)) {
        throw businessRule(k.notOpen, `${k.targetLabel} ${target.id} is not open for allocation (status ${target.status})`);
      }
      if (amount.gt(target.outstandingAmount)) {
        throw businessRule('over_allocation', `Allocation ${amount} exceeds ${k.targetLabel} ${target.id} outstanding ${target.outstandingAmount}`);
      }
      total = add(total, amount);
    }
    if (total.gt(payment.outstandingAmount)) {
      throw businessRule('over_allocation', `Total allocations ${total} exceed the Unapplied Amount ${payment.outstandingAmount}`);
    }

    // One row per (payment, target): a further allocation to a target this
    // payment already covers adds to that row.
    const existing = await tx.paymentAllocation.findMany({
      where: { organizationId: org, paymentDocumentId: payment.id, targetDocumentId: { in: targetIds } },
    });
    const existingByTarget = new Map(existing.map((e) => [e.targetDocumentId, e]));

    const applied = [];
    for (const a of allocations) {
      const target = targetsById.get(a.targetId);
      const amount = dec(a.amount);
      const newOutstanding = sub(target.outstandingAmount, amount);
      const row = existingByTarget.get(target.id);
      if (row) {
        await tx.paymentAllocation.update({ where: { id: row.id }, data: { amount: add(row.amount, amount) } });
      } else {
        await tx.paymentAllocation.create({
          data: { organizationId: org, paymentDocumentId: payment.id, targetDocumentId: target.id, amount, createdById: actor.userId },
        });
      }
      await tx.document.update({
        where: { id: target.id },
        data: {
          outstandingAmount: newOutstanding,
          allocatedAmount: add(target.allocatedAmount, amount),
          status: isZero(newOutstanding) ? 'PAID' : 'PARTIALLY_PAID',
          version: { increment: 1 },
        },
      });
      applied.push({ targetId: target.id, amount: amount.toFixed(2), targetOutstandingAfter: newOutstanding.toFixed(2) });
    }

    const document = await tx.document.update({
      where: { id: payment.id },
      data: {
        allocatedAmount: add(payment.allocatedAmount, total),
        outstandingAmount: sub(payment.outstandingAmount, total),
        version: { increment: 1 },
      },
    });
    return { document, allocations: applied };
  };

  return tx === prisma ? prisma.$transaction(run, { isolationLevel: 'ReadCommitted' }) : run(tx);
}
