import { prisma } from '../../db/client.js';
import { Prisma } from '../../generated/prisma/index.js';
import { POSTING_RULES } from './posting-rules.js';
import { nextDocNumber, nextEntryNumber } from './document-numbering.js';
import { assertPeriodOpen } from './period-lock.js';
import { findFiscalYearForDate } from './fiscal-year.js';
import { AR_ACCOUNT_CODE } from './chart-of-accounts.js';
import { notFound, businessRule, internal } from './errors.js';
import { add, sub, eq, dec, isZero } from '../money.js';

// A receipt has no draft phase — it create-and-posts in one step, same as a
// manual JV (§6 worked example 3). Unlike postDocument/postManualEntry it
// accepts an already-open `tx`: when called with an Idempotency-Key, the
// route wraps this in runIdempotent()'s own transaction so the idempotency
// key row and the payment land in the SAME commit (§6 idempotency_keys —
// "two systems that can disagree about whether a payment happened").
// Called directly (no key), it opens its own transaction like every other
// posting entry point.
export async function postReceipt(actor, input, tx = prisma) {
  const run = async (tx) => {
    const { partyId, docDate: docDateStr, depositAccountId, amount: amountInput, referenceNo, notes, allocations: allocationInputs = [] } = input;

    const docDate = new Date(docDateStr);
    const amount = dec(amountInput);

    const [party, depositAccount] = await Promise.all([
      tx.party.findFirst({ where: { id: partyId, organizationId: actor.organizationId } }),
      tx.account.findFirst({ where: { id: depositAccountId, organizationId: actor.organizationId } }),
    ]);
    if (!party) throw notFound('Party not found');
    if (!depositAccount) throw notFound('Deposit account not found');

    const fiscalYear = await findFiscalYearForDate(tx, actor.organizationId, docDate);
    const period = await assertPeriodOpen(tx, { organizationId: actor.organizationId, docDate });

    // Lock every target invoice in id order (not input order) — the same
    // rule payment_allocations follows in §5, so two concurrent receipts
    // touching the same two invoices in opposite order never deadlock.
    const invoiceIds = [...new Set(allocationInputs.map((a) => a.invoiceId))].sort();
    let invoicesById = new Map();
    if (invoiceIds.length > 0) {
      const locked = await tx.$queryRaw`
        SELECT * FROM "Document"
        WHERE id IN (${Prisma.join(invoiceIds)}) AND "organizationId" = ${actor.organizationId}
        ORDER BY id
        FOR UPDATE
      `;
      invoicesById = new Map(locked.map((d) => [d.id, d]));
      for (const id of invoiceIds) {
        if (!invoicesById.has(id)) throw notFound(`Invoice ${id} not found`);
      }
    }

    let allocatedTotal = dec(0);
    for (const a of allocationInputs) {
      const invoice = invoicesById.get(a.invoiceId);
      const allocAmount = dec(a.amount);
      if (invoice.docType !== 'INVOICE') {
        throw businessRule('not_an_invoice', `Document ${invoice.id} is not an invoice`);
      }
      if (!['POSTED', 'PARTIALLY_PAID'].includes(invoice.status)) {
        throw businessRule('invoice_not_open', `Invoice ${invoice.id} is not open for allocation (status ${invoice.status})`);
      }
      if (allocAmount.gt(invoice.outstandingAmount)) {
        throw businessRule('over_allocation', `Allocation ${allocAmount} exceeds invoice ${invoice.id} outstanding ${invoice.outstandingAmount}`);
      }
      allocatedTotal = add(allocatedTotal, allocAmount);
    }
    if (allocatedTotal.gt(amount)) {
      throw businessRule('over_allocation', `Total allocations ${allocatedTotal} exceed receipt amount ${amount}`);
    }

    const arAccount = await tx.account.findFirst({ where: { organizationId: actor.organizationId, code: AR_ACCOUNT_CODE } });
    if (!arAccount) throw internal(`Accounts Receivable account (${AR_ACCOUNT_CODE}) not found for this organization`);

    const yearLabel = fiscalYear.label.split('/')[0];
    const docNo = await nextDocNumber(tx, {
      organizationId: actor.organizationId, docType: 'RECEIPT', fiscalYearId: fiscalYear.id, prefix: 'RCP', yearLabel,
    });
    const entryNumber = await nextEntryNumber(tx, { organizationId: actor.organizationId, fiscalYearId: fiscalYear.id, yearLabel });

    const journalLines = POSTING_RULES.receipt({
      depositAccountId: depositAccount.id, arAccountId: arAccount.id, partyId: party.id, amount,
    });

    const debits = journalLines.reduce((total, l) => add(total, l.debit), dec(0));
    const credits = journalLines.reduce((total, l) => add(total, l.credit), dec(0));
    if (!eq(debits, credits)) {
      throw internal(`Unbalanced receipt entry: debits ${debits} vs credits ${credits}`);
    }

    const outstandingOnReceipt = sub(amount, allocatedTotal);

    const documentDraft = await tx.document.create({
      data: {
        organizationId: actor.organizationId, fiscalYearId: fiscalYear.id,
        docType: 'RECEIPT', docNo, docDate, partyId: party.id,
        referenceNo: referenceNo ?? null, notes: notes ?? null,
        grandTotal: amount, allocatedAmount: allocatedTotal, outstandingAmount: outstandingOnReceipt,
        status: 'POSTED', createdById: actor.userId, postedAt: new Date(), postedById: actor.userId,
      },
    });

    const journalEntry = await tx.journalEntry.create({
      data: {
        organizationId: actor.organizationId, periodId: period.id, entryNumber,
        documentType: 'receipt', entryDate: docDate, description: `Customer Receipt ${docNo}`,
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

    // postDocument()'s invoice/credit-note path links this back in the same
    // create call; a receipt creates document and entry in the opposite
    // order (create-and-post, no draft), so the link is a second write.
    // Without it, every join from JournalEntry back to its source Document
    // — the general ledger's "click a number, land on the source doc" and
    // the bank matcher's doc_no/party-name reference pass (§7/§8.2) — misses
    // every receipt.
    const document = await tx.document.update({
      where: { id: documentDraft.id },
      data: { journalEntryId: journalEntry.id },
    });

    const allocations = [];
    for (const a of allocationInputs) {
      const invoice = invoicesById.get(a.invoiceId);
      const allocAmount = dec(a.amount);
      const newOutstanding = sub(invoice.outstandingAmount, allocAmount);

      await tx.paymentAllocation.create({
        data: {
          organizationId: actor.organizationId, paymentDocumentId: document.id, targetDocumentId: invoice.id,
          amount: allocAmount, createdById: actor.userId,
        },
      });

      await tx.document.update({
        where: { id: invoice.id },
        data: {
          outstandingAmount: newOutstanding,
          allocatedAmount: add(invoice.allocatedAmount, allocAmount),
          status: isZero(newOutstanding) ? 'PAID' : 'PARTIALLY_PAID',
          version: { increment: 1 },
        },
      });

      allocations.push({ invoiceId: invoice.id, amount: allocAmount.toFixed(2), invoiceOutstandingAfter: newOutstanding.toFixed(2) });
    }

    return { document, journalEntry, allocations };
  };

  return tx === prisma ? prisma.$transaction(run, { isolationLevel: 'ReadCommitted' }) : run(tx);
}
