import { prisma } from '../../db/client.js';
import { POSTING_RULES } from './posting-rules.js';
import { resolveLines, toDocumentLineData } from './document-lines.js';
import { sumLines } from './line-math.js';
import { nextDocNumber, nextEntryNumber } from './document-numbering.js';
import { assertPeriodOpen } from './period-lock.js';
import { findFiscalYearForDate } from './fiscal-year.js';
import { AR_ACCOUNT_CODE } from './chart-of-accounts.js';
import { notFound, businessRule, internal } from './errors.js';
import { add, sub, eq, dec, isZero } from '../money.js';

// A credit note has no draft phase — it create-and-posts in one step, same
// as a receipt (§6 worked example 4). Always has its own transaction; Day 4
// only wires idempotency for receipts (IDEM-1..3 targets payments), so
// unlike postReceipt this doesn't accept an external tx.
export async function postCreditNote(actor, { invoiceId, docDate: docDateStr, referenceNo, notes, lines: lineInputs }) {
  return prisma.$transaction(async (tx) => {
    const [invoice] = await tx.$queryRaw`
      SELECT * FROM "Document"
      WHERE id = ${invoiceId} AND "organizationId" = ${actor.organizationId}
      FOR UPDATE
    `;
    if (!invoice || invoice.docType !== 'INVOICE') throw notFound('Invoice not found');
    if (!['POSTED', 'PARTIALLY_PAID'].includes(invoice.status)) {
      throw businessRule('invoice_not_open', `Invoice ${invoice.id} is not open for a credit note (status ${invoice.status})`);
    }

    const docDate = new Date(docDateStr);
    const resolved = await resolveLines(tx, actor.organizationId, lineInputs);
    const totals = sumLines(resolved);

    // A credit note against an already-fully-paid invoice would need a
    // customer refund — out of scope for Day 4 (§ scope decision). The
    // Document.outstandingAmount >= 0 invariant makes this the safe default.
    if (totals.grandTotal.gt(invoice.outstandingAmount)) {
      throw businessRule('credit_exceeds_outstanding', `Credit note ${totals.grandTotal} exceeds invoice outstanding ${invoice.outstandingAmount}`);
    }

    const fiscalYear = await findFiscalYearForDate(tx, actor.organizationId, docDate);
    const period = await assertPeriodOpen(tx, { organizationId: actor.organizationId, docDate });

    const arAccount = await tx.account.findFirst({ where: { organizationId: actor.organizationId, code: AR_ACCOUNT_CODE } });
    if (!arAccount) throw internal(`Accounts Receivable account (${AR_ACCOUNT_CODE}) not found for this organization`);

    const yearLabel = fiscalYear.label.split('/')[0];
    const docNo = await nextDocNumber(tx, {
      organizationId: actor.organizationId, docType: 'CREDIT_NOTE', fiscalYearId: fiscalYear.id, prefix: 'CN', yearLabel,
    });
    const entryNumber = await nextEntryNumber(tx, { organizationId: actor.organizationId, fiscalYearId: fiscalYear.id, yearLabel });

    const creditNote = await tx.document.create({
      data: {
        organizationId: actor.organizationId, fiscalYearId: fiscalYear.id,
        docType: 'CREDIT_NOTE', docNo, docDate, partyId: invoice.partyId, parentDocumentId: invoice.id,
        referenceNo: referenceNo ?? null, notes: notes ?? null,
        subtotal: totals.subtotal, discountAmount: totals.discountAmount, taxableAmount: totals.taxableAmount,
        taxAmount: totals.taxAmount, grandTotal: totals.grandTotal, outstandingAmount: 0,
        status: 'POSTED', createdById: actor.userId, postedAt: new Date(), postedById: actor.userId,
        lines: { create: resolved.map(toDocumentLineData) },
      },
    });

    // Re-read the just-created lines with their tax code's output account —
    // resolveLines' return shape carries taxCodeId, not the resolved
    // account, same two-step pattern postDocument uses for invoices.
    const creditNoteLines = await tx.documentLine.findMany({
      where: { documentId: creditNote.id }, include: { taxCode: true }, orderBy: { lineNo: 'asc' },
    });

    const journalLines = POSTING_RULES.creditNote({
      partyId: invoice.partyId, arAccountId: arAccount.id, grandTotal: totals.grandTotal,
      lines: creditNoteLines.map((l) => ({
        accountId: l.accountId, taxableAmount: l.taxableAmount, taxAmount: l.taxAmount,
        taxAccountId: l.taxCode?.outputAccountId ?? null, description: l.description,
      })),
    });

    const debits = journalLines.reduce((total, l) => add(total, l.debit), dec(0));
    const credits = journalLines.reduce((total, l) => add(total, l.credit), dec(0));
    if (!eq(debits, credits)) {
      throw internal(`Unbalanced credit note entry: debits ${debits} vs credits ${credits}`);
    }

    const journalEntry = await tx.journalEntry.create({
      data: {
        organizationId: actor.organizationId, periodId: period.id, entryNumber,
        documentType: 'creditNote', entryDate: docDate, description: `Credit Note ${docNo} vs ${invoice.docNo}`,
        status: 'POSTED', sourceId: creditNote.id, postedAt: new Date(), postedById: actor.userId,
        lines: {
          create: journalLines.map((l) => ({
            organizationId: actor.organizationId, accountId: l.accountId, partyId: l.partyId,
            debit: l.debit, credit: l.credit, description: l.description, lineNumber: l.lineNumber,
          })),
        },
      },
      include: { lines: true },
    });

    const newOutstanding = sub(invoice.outstandingAmount, totals.grandTotal);
    const updatedInvoice = await tx.document.update({
      where: { id: invoice.id },
      data: {
        outstandingAmount: newOutstanding,
        status: isZero(newOutstanding) ? 'PAID' : 'PARTIALLY_PAID',
        version: { increment: 1 },
      },
    });

    return { document: { ...creditNote, lines: creditNoteLines }, journalEntry, invoice: updatedInvoice };
  });
}
