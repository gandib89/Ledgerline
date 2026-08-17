import { prisma } from '../../db/client.js';
import { nextEntryNumber } from './document-numbering.js';
import { assertPeriodOpen } from './period-lock.js';
import { findFiscalYearForDate } from './fiscal-year.js';
import { notFound, conflict, businessRule } from './errors.js';
import { add, sub, dec, isZero } from '../money.js';

// Corrects a posting MISTAKE (wrong account, wrong amount) by creating a new
// offsetting entry — never UPDATE/DELETE on the original's lines (§6 worked
// example 5). The one exception is the original's own status column, which
// the Day 4 migration carved a narrow trigger exception for.
export async function reverseEntry(entryId, { reason, reversalDate }, actor) {
  return prisma.$transaction(async (tx) => {
    const [original] = await tx.$queryRaw`
      SELECT * FROM "JournalEntry"
      WHERE id = ${entryId} AND "organizationId" = ${actor.organizationId}
      FOR UPDATE
    `;
    if (!original) throw notFound('Journal entry not found');
    if (original.status !== 'POSTED') {
      throw conflict('already_reversed', `Journal entry ${original.id} is not posted (status ${original.status.toLowerCase()})`);
    }

    const date = reversalDate ? new Date(reversalDate) : new Date();
    const fiscalYear = await findFiscalYearForDate(tx, actor.organizationId, date);
    const period = await assertPeriodOpen(tx, { organizationId: actor.organizationId, docDate: date });

    const originalLines = await tx.journalLine.findMany({
      where: { journalEntryId: original.id },
      orderBy: { lineNumber: 'asc' },
    });

    // RECON-8 / §7 edge cases: a line whose journal entry is reversed must
    // return to 'unmatched' so the reconciliation workspace picks it up
    // again — unless the reconciliation that consumed it has already
    // completed, in which case the DB CHECK on Reconciliation.difference
    // would be violated the moment matched lines flip; block first instead.
    const matchedStatementLines = await tx.bankStatementLine.findMany({
      where: { matchedJournalLineId: { in: originalLines.map((l) => l.id) } },
    });
    if (matchedStatementLines.some((l) => l.status === 'RECONCILED')) {
      throw businessRule('reconciled_period', 'Journal entry has a reconciled bank statement line and cannot be reversed');
    }
    for (const line of matchedStatementLines) {
      await tx.bankStatementLine.update({
        where: { id: line.id },
        data: { status: 'UNMATCHED', matchedJournalLineId: null, matchConfidence: null, matchedBy: null, matchedAt: null },
      });
    }

    // Mechanical debit<->credit swap, not a POSTING_RULES entry — this isn't
    // a rule keyed by document type, it's the same transform for every entry.
    const swappedLines = originalLines.map((l) => ({
      accountId: l.accountId, partyId: l.partyId, description: l.description,
      debit: l.credit, credit: l.debit,
    }));

    const yearLabel = fiscalYear.label.split('/')[0];
    const entryNumber = await nextEntryNumber(tx, { organizationId: actor.organizationId, fiscalYearId: fiscalYear.id, yearLabel });

    const reversal = await tx.journalEntry.create({
      data: {
        organizationId: actor.organizationId, periodId: period.id, entryNumber,
        documentType: 'manual', entryDate: date,
        description: `Reversal of ${original.entryNumber}: ${reason}`,
        status: 'POSTED', sourceId: null, reversalOfId: original.id,
        postedAt: new Date(), postedById: actor.userId,
        lines: {
          create: swappedLines.map((l, i) => ({
            organizationId: actor.organizationId, accountId: l.accountId, partyId: l.partyId,
            debit: l.debit, credit: l.credit, description: l.description, lineNumber: i + 1,
          })),
        },
      },
      include: { lines: true },
    });

    // The one permitted UPDATE on a posted entry — the migration's trigger
    // carve-out only allows this exact status transition, nothing else.
    await tx.$executeRaw`UPDATE "JournalEntry" SET status = 'REVERSED' WHERE id = ${original.id}`;

    let sourceDocument = null;
    if (original.sourceId) {
      const [doc] = await tx.$queryRaw`
        SELECT * FROM "Document" WHERE id = ${original.sourceId} AND "organizationId" = ${actor.organizationId} FOR UPDATE
      `;
      if (doc) sourceDocument = await cascadeReversal(tx, actor, original.documentType, doc);
    }

    return { original: { ...original, status: 'REVERSED' }, reversal, sourceDocument };
  });
}

// Cascade depends on what kind of document (if any) the entry came from —
// each doc type's "undo" is different (§ reverseEntry cascade rules).
async function cascadeReversal(tx, actor, documentType, doc) {
  if (documentType === 'invoice') {
    if (dec(doc.allocatedAmount).gt(0)) {
      throw businessRule('cannot_reverse_invoice_with_activity', `Invoice ${doc.id} has payments applied — issue a credit note instead`);
    }
    const corrections = await tx.document.count({ where: { parentDocumentId: doc.id } });
    if (corrections > 0) {
      throw businessRule('cannot_reverse_invoice_with_activity', `Invoice ${doc.id} has credit notes applied — issue a further correction instead`);
    }
    return tx.document.update({
      where: { id: doc.id },
      data: { status: 'REVERSED', outstandingAmount: 0, version: { increment: 1 } },
    });
  }

  if (documentType === 'receipt') {
    const allocations = await tx.paymentAllocation.findMany({ where: { paymentDocumentId: doc.id } });
    for (const alloc of allocations) {
      const [invoice] = await tx.$queryRaw`
        SELECT * FROM "Document" WHERE id = ${alloc.targetDocumentId} AND "organizationId" = ${actor.organizationId} FOR UPDATE
      `;
      if (!invoice) continue;
      const newOutstanding = add(invoice.outstandingAmount, alloc.amount);
      const newAllocated = sub(invoice.allocatedAmount, alloc.amount);
      await tx.document.update({
        where: { id: invoice.id },
        data: {
          outstandingAmount: newOutstanding,
          allocatedAmount: newAllocated,
          status: isZero(newAllocated) ? 'POSTED' : 'PARTIALLY_PAID',
          version: { increment: 1 },
        },
      });
    }
    await tx.paymentAllocation.deleteMany({ where: { paymentDocumentId: doc.id } });
    return tx.document.update({
      where: { id: doc.id },
      data: { status: 'REVERSED', outstandingAmount: 0, version: { increment: 1 } },
    });
  }

  if (documentType === 'creditNote') {
    const [invoice] = await tx.$queryRaw`
      SELECT * FROM "Document" WHERE id = ${doc.parentDocumentId} AND "organizationId" = ${actor.organizationId} FOR UPDATE
    `;
    if (invoice) {
      const maxOutstanding = sub(invoice.grandTotal, invoice.allocatedAmount);
      const restored = add(invoice.outstandingAmount, doc.grandTotal);
      const newOutstanding = restored.gt(maxOutstanding) ? maxOutstanding : restored;
      await tx.document.update({
        where: { id: invoice.id },
        data: {
          outstandingAmount: newOutstanding,
          status: isZero(newOutstanding) ? (dec(invoice.allocatedAmount).gt(0) ? 'PAID' : 'POSTED') : 'PARTIALLY_PAID',
          version: { increment: 1 },
        },
      });
    }
    return tx.document.update({ where: { id: doc.id }, data: { status: 'REVERSED', version: { increment: 1 } } });
  }

  // A "create entry from line" bank adjustment (§7 resolution path 2) — no
  // allocation, no party ledger to unwind, just the status flip so the
  // source document doesn't stay stuck at POSTED once its entry is reversed.
  // The matched statement line itself is unmatched earlier in reverseEntry,
  // independent of documentType.
  if (documentType === 'bankAdjustment') {
    return tx.document.update({ where: { id: doc.id }, data: { status: 'REVERSED', version: { increment: 1 } } });
  }

  return null;
}
