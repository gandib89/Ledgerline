import { prisma } from '../../db/client.js';
import { Prisma } from '../../generated/prisma/index.js';
import { POSTING_RULES } from './posting-rules.js';
import { nextDocNumber, nextEntryNumber } from './document-numbering.js';
import { assertPeriodOpen } from './period-lock.js';
import { findFiscalYearForDate } from './fiscal-year.js';
import { AP_ACCOUNT_CODE, CASH_IN_HAND_CODE } from './chart-of-accounts.js';
import { notFound, businessRule, internal } from './errors.js';
import { add, sub, eq, dec, isZero } from '../money.js';

// Mirror of postReceipt: a Supplier Payment has no draft phase, it posts on
// create together with its allocations to Bills. Same optional-`tx` contract
// (the route passes runIdempotent()'s transaction so the key and the payment
// commit together). Lock order: target Bills (one ORDER BY id query), then the
// DocumentSeries / EntrySeries counters - the same order reverseEntry uses.
export async function postSupplierPayment(actor, input, tx = prisma) {
  const run = async (tx) => {
    const { partyId, docDate: docDateStr, paidFromAccountId, amount: amountInput, referenceNo, notes, allocations: allocationInputs = [] } = input;

    const docDate = new Date(docDateStr);
    const amount = dec(amountInput);

    const [party, paidFromAccount] = await Promise.all([
      tx.party.findFirst({ where: { id: partyId, organizationId: actor.organizationId } }),
      tx.account.findFirst({ where: { id: paidFromAccountId, organizationId: actor.organizationId } }),
    ]);
    if (!party) throw notFound('Party not found');
    if (!paidFromAccount) throw notFound('Paid-from account not found');
    if (!['SUPPLIER', 'BOTH'].includes(party.type)) {
      throw businessRule('party_not_supplier', `${party.name} is not a Supplier - Supplier Payments can only be made to a Supplier`);
    }
    if (!paidFromAccount.isBankAccount && paidFromAccount.code !== CASH_IN_HAND_CODE) {
      throw businessRule('invalid_paid_from_account', 'A Supplier Payment can only be paid from a bank account or Cash in Hand');
    }

    const billIdList = allocationInputs.map((a) => a.billId);
    if (new Set(billIdList).size !== billIdList.length) {
      throw businessRule('duplicate_allocation', 'Each Bill can appear only once in a payment\'s allocations');
    }

    const fiscalYear = await findFiscalYearForDate(tx, actor.organizationId, docDate);
    const period = await assertPeriodOpen(tx, { organizationId: actor.organizationId, docDate });

    // Lock every target Bill in id order (not input order), in one query, so
    // two payments touching the same Bills in opposite order never deadlock.
    const billIds = [...billIdList].sort();
    let billsById = new Map();
    if (billIds.length > 0) {
      const locked = await tx.$queryRaw`
        SELECT * FROM "Document"
        WHERE id IN (${Prisma.join(billIds)}) AND "organizationId" = ${actor.organizationId}
        ORDER BY id
        FOR UPDATE
      `;
      billsById = new Map(locked.map((d) => [d.id, d]));
      for (const id of billIds) {
        if (!billsById.has(id)) throw notFound(`Bill ${id} not found`);
      }
    }

    let allocatedTotal = dec(0);
    for (const a of allocationInputs) {
      const bill = billsById.get(a.billId);
      const allocAmount = dec(a.amount);
      if (bill.docType !== 'BILL') {
        throw businessRule('not_a_bill', `Document ${bill.id} is not a Bill`);
      }
      if (bill.partyId !== party.id) {
        throw businessRule('party_mismatch', `Bill ${bill.id} belongs to a different Supplier than the payment`);
      }
      if (!['POSTED', 'PARTIALLY_PAID'].includes(bill.status)) {
        throw businessRule('bill_not_open', `Bill ${bill.id} is not open for payment (status ${bill.status})`);
      }
      if (allocAmount.gt(bill.outstandingAmount)) {
        throw businessRule('over_allocation', `Allocation ${allocAmount} exceeds Bill ${bill.id} outstanding ${bill.outstandingAmount}`);
      }
      allocatedTotal = add(allocatedTotal, allocAmount);
    }
    if (allocatedTotal.gt(amount)) {
      throw businessRule('over_allocation', `Total allocations ${allocatedTotal} exceed payment amount ${amount}`);
    }

    const apAccount = await tx.account.findFirst({ where: { organizationId: actor.organizationId, code: AP_ACCOUNT_CODE } });
    if (!apAccount) throw internal(`Accounts Payable account (${AP_ACCOUNT_CODE}) not found for this organization`);

    const yearLabel = fiscalYear.label.split('/')[0];
    const docNo = await nextDocNumber(tx, {
      organizationId: actor.organizationId, docType: 'SUPPLIER_PAYMENT', fiscalYearId: fiscalYear.id, prefix: 'SPAY', yearLabel,
    });
    const entryNumber = await nextEntryNumber(tx, { organizationId: actor.organizationId, fiscalYearId: fiscalYear.id, yearLabel });

    const journalLines = POSTING_RULES.supplierPayment({
      paidFromAccountId: paidFromAccount.id, apAccountId: apAccount.id, partyId: party.id, amount,
    });
    const debits = journalLines.reduce((total, l) => add(total, l.debit), dec(0));
    const credits = journalLines.reduce((total, l) => add(total, l.credit), dec(0));
    if (!eq(debits, credits)) {
      throw internal(`Unbalanced supplier payment entry: debits ${debits} vs credits ${credits}`);
    }

    const documentDraft = await tx.document.create({
      data: {
        organizationId: actor.organizationId, fiscalYearId: fiscalYear.id,
        docType: 'SUPPLIER_PAYMENT', docNo, docDate, postingDate: docDate, partyId: party.id,
        referenceNo: referenceNo ?? null, notes: notes ?? null,
        grandTotal: amount, allocatedAmount: allocatedTotal, outstandingAmount: sub(amount, allocatedTotal),
        status: 'POSTED', createdById: actor.userId, postedAt: new Date(), postedById: actor.userId,
      },
    });

    const journalEntry = await tx.journalEntry.create({
      data: {
        organizationId: actor.organizationId, periodId: period.id, entryNumber,
        documentType: 'supplierPayment', entryDate: docDate, description: `Supplier Payment ${docNo}`,
        status: 'POSTED', sourceId: documentDraft.id, postedAt: new Date(), postedById: actor.userId,
        lines: {
          create: journalLines.map((l) => ({
            organizationId: actor.organizationId, accountId: l.accountId, partyId: l.partyId,
            debit: l.debit, credit: l.credit, description: l.description, lineNumber: l.lineNumber,
          })),
        },
      },
      include: { lines: true },
    });

    // Link back so joins from the entry to its source Document (general
    // ledger drill-down, bank matcher's doc-number pass) find the payment.
    const document = await tx.document.update({
      where: { id: documentDraft.id },
      data: { journalEntryId: journalEntry.id },
    });

    const allocations = [];
    for (const a of allocationInputs) {
      const bill = billsById.get(a.billId);
      const allocAmount = dec(a.amount);
      const newOutstanding = sub(bill.outstandingAmount, allocAmount);

      await tx.paymentAllocation.create({
        data: {
          organizationId: actor.organizationId, paymentDocumentId: document.id, targetDocumentId: bill.id,
          amount: allocAmount, createdById: actor.userId,
        },
      });
      await tx.document.update({
        where: { id: bill.id },
        data: {
          outstandingAmount: newOutstanding,
          allocatedAmount: add(bill.allocatedAmount, allocAmount),
          status: isZero(newOutstanding) ? 'PAID' : 'PARTIALLY_PAID',
          version: { increment: 1 },
        },
      });
      allocations.push({ billId: bill.id, amount: allocAmount.toFixed(2), billOutstandingAfter: newOutstanding.toFixed(2) });
    }

    return { document, journalEntry, allocations };
  };

  return tx === prisma ? prisma.$transaction(run, { isolationLevel: 'ReadCommitted' }) : run(tx);
}
