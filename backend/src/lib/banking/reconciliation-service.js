import { prisma } from '../../db/client.js';
import { postDocument } from '../accounting/post-document.js';
import { findFiscalYearForDate } from '../accounting/fiscal-year.js';
import { notFound, businessRule, conflict } from '../accounting/errors.js';
import { sub, dec, isZero } from '../money.js';

async function loadStatementLine(tx, organizationId, statementLineId) {
  const line = await tx.bankStatementLine.findFirst({ where: { id: statementLineId, organizationId } });
  if (!line) throw notFound('Statement line not found');
  return line;
}

// RECON-4: user picks any candidate from a searchable list — a full manual
// override, not re-scored. Locked to the line's own bank GL account so a
// statement line can't be pointed at an unrelated ledger.
export async function manualMatchLine(actor, statementLineId, journalLineId) {
  return prisma.$transaction(async (tx) => {
    const line = await loadStatementLine(tx, actor.organizationId, statementLineId);
    if (['RECONCILED', 'IGNORED'].includes(line.status)) {
      throw businessRule('line_not_matchable', `Statement line is already ${line.status.toLowerCase()}`);
    }

    const bankAccount = await tx.bankAccount.findFirstOrThrow({ where: { id: line.bankAccountId } });
    const journalLine = await tx.journalLine.findFirst({
      where: { id: journalLineId, organizationId: actor.organizationId, accountId: bankAccount.accountId },
    });
    if (!journalLine) throw notFound('Journal line not found on this bank account');

    try {
      return await tx.bankStatementLine.update({
        where: { id: line.id },
        data: { status: 'MATCHED', matchedJournalLineId: journalLine.id, matchConfidence: 1.0, matchedBy: 'MANUAL', matchedAt: new Date() },
      });
    } catch (err) {
      if (err.code === 'P2002') throw conflict('journal_line_already_matched', 'That journal line is already matched to another statement line');
      throw err;
    }
  });
}

// RECON-5: the line is a real transaction never recorded (bank charges,
// interest, a direct debit) — the user picks an account and the system
// posts a normal journal entry through postDocument(), the same engine
// every invoice goes through (§7 resolution path 2), then auto-matches the
// new bank-side line back to the statement line. Direction must agree with
// §7's rule: a statement debit (money out) is a CREDIT on the bank account,
// and vice versa.
//
// A real Document + two DocumentLine rows first (draft), then postDocument()
// posts it — same two-step shape postDocument expects from every caller.
// quantity/unitPrice/taxableAmount/lineTotal carry the line amount as a
// placeholder; postDocument's BANK_ADJUSTMENT branch reads debit/credit
// instead and ignores them (§ DocumentLine — only sale-line-shaped docs use
// the qty/rate columns for real).
export async function createEntryFromLine(actor, statementLineId, { accountId, narration }) {
  return prisma.$transaction(async (tx) => {
    const line = await loadStatementLine(tx, actor.organizationId, statementLineId);
    if (line.status !== 'UNMATCHED' && line.status !== 'SUGGESTED') {
      throw businessRule('line_not_matchable', `Statement line is already ${line.status.toLowerCase()}`);
    }

    const bankAccount = await tx.bankAccount.findFirstOrThrow({ where: { id: line.bankAccountId } });
    const isBankDebit = dec(line.credit).gt(0); // statement credit -> bank account debit
    const amount = isBankDebit ? line.credit : line.debit;
    const lineDescription = narration ?? `Bank statement: ${line.description}`;

    const fiscalYear = await findFiscalYearForDate(tx, actor.organizationId, line.txnDate);

    const draft = await tx.document.create({
      data: {
        organizationId: actor.organizationId,
        fiscalYearId: fiscalYear.id,
        docType: 'BANK_ADJUSTMENT',
        docDate: line.txnDate,
        grandTotal: amount,
        status: 'DRAFT',
        createdById: actor.userId,
        lines: {
          create: [
            {
              lineNo: 1, description: lineDescription, accountId: bankAccount.accountId,
              quantity: 1, unitPrice: amount, taxableAmount: amount, lineTotal: amount,
              debit: isBankDebit ? amount : 0, credit: isBankDebit ? 0 : amount,
            },
            {
              lineNo: 2, description: lineDescription, accountId,
              quantity: 1, unitPrice: amount, taxableAmount: amount, lineTotal: amount,
              debit: isBankDebit ? 0 : amount, credit: isBankDebit ? amount : 0,
            },
          ],
        },
      },
    });

    const entry = await postDocument(draft.id, actor, tx);

    const bankLine = entry.lines
      ? entry.lines.find((l) => l.accountId === bankAccount.accountId)
      : await tx.journalLine.findFirstOrThrow({ where: { journalEntryId: entry.id, accountId: bankAccount.accountId } });

    const updated = await tx.bankStatementLine.update({
      where: { id: line.id },
      data: { status: 'MATCHED', matchedJournalLineId: bankLine.id, matchConfidence: 1.0, matchedBy: 'AUTO', matchedAt: new Date() },
    });

    return { statementLine: updated, journalEntry: entry };
  });
}

// An internal transfer already recorded elsewhere — excluded from the
// difference calculation but retained in the record (§7 resolution path 3).
export async function ignoreLine(actor, statementLineId, reason) {
  const line = await loadStatementLine(prisma, actor.organizationId, statementLineId);
  if (['MATCHED', 'RECONCILED'].includes(line.status)) {
    throw businessRule('line_not_matchable', `Statement line is already ${line.status.toLowerCase()}`);
  }
  return prisma.bankStatementLine.update({
    where: { id: line.id },
    data: { status: 'IGNORED', ignoreReason: reason },
  });
}

// Same formula as the report (§7 "Closing a reconciliation") — the ledger's
// own truth, independent of what has or hasn't been matched.
export async function computeBookBalance(tx, { organizationId, glAccountId, asOfDate }) {
  const [row] = await tx.$queryRaw`
    SELECT COALESCE(SUM(jl.debit), 0) AS total_debit, COALESCE(SUM(jl.credit), 0) AS total_credit
    FROM "JournalLine" jl
    JOIN "JournalEntry" je ON je.id = jl."journalEntryId"
    WHERE jl."organizationId" = ${organizationId} AND jl."accountId" = ${glAccountId}
      AND je.status IN ('POSTED', 'REVERSED') AND je."entryDate" <= ${asOfDate}::date
  `;
  return sub(dec(row.total_debit), dec(row.total_credit));
}

export async function createReconciliation(actor, { bankAccountId, statementId, asOfDate: asOfDateStr }) {
  const asOfDate = new Date(asOfDateStr);
  return prisma.$transaction(async (tx) => {
    const bankAccount = await tx.bankAccount.findFirst({ where: { id: bankAccountId, organizationId: actor.organizationId } });
    if (!bankAccount) throw notFound('Bank account not found');
    const statement = await tx.bankStatement.findFirst({ where: { id: statementId, organizationId: actor.organizationId, bankAccountId } });
    if (!statement) throw notFound('Statement not found');

    const bookBalance = await computeBookBalance(tx, { organizationId: actor.organizationId, glAccountId: bankAccount.accountId, asOfDate });
    const bankBalance = dec(statement.closingBalance);
    const unreconciledCount = await tx.bankStatementLine.count({
      where: { statementId, status: { in: ['UNMATCHED', 'SUGGESTED'] } },
    });

    return tx.reconciliation.create({
      data: {
        organizationId: actor.organizationId,
        bankAccountId,
        statementId,
        asOfDate,
        bookBalance,
        bankBalance,
        difference: sub(bankBalance, bookBalance),
        unreconciledCount,
        status: 'IN_PROGRESS',
      },
    });
  });
}

// Recomputed fresh at completion time, not trusted from creation — matches
// and ignores may have happened in between. difference = 0 AND
// unreconciled_count = 0 required; the DB CHECK is the backstop (RECON-7).
export async function completeReconciliation(actor, reconciliationId) {
  return prisma.$transaction(async (tx) => {
    const [reconciliation] = await tx.$queryRaw`
      SELECT * FROM "Reconciliation" WHERE id = ${reconciliationId} AND "organizationId" = ${actor.organizationId} FOR UPDATE
    `;
    if (!reconciliation) throw notFound('Reconciliation not found');
    if (reconciliation.status === 'COMPLETED') {
      throw conflict('already_completed', 'Reconciliation is already completed');
    }

    const bankAccount = await tx.bankAccount.findFirstOrThrow({ where: { id: reconciliation.bankAccountId } });
    const bookBalance = await computeBookBalance(tx, {
      organizationId: actor.organizationId, glAccountId: bankAccount.accountId, asOfDate: reconciliation.asOfDate,
    });
    const bankBalance = dec(reconciliation.bankBalance);
    const difference = sub(bankBalance, bookBalance);
    const unreconciledCount = await tx.bankStatementLine.count({
      where: { statementId: reconciliation.statementId, status: { in: ['UNMATCHED', 'SUGGESTED'] } },
    });

    if (!isZero(difference) || unreconciledCount > 0) {
      throw businessRule('reconciliation_not_balanced', `Difference ${difference.toFixed(2)}, ${unreconciledCount} line(s) still unresolved`);
    }

    await tx.bankStatementLine.updateMany({
      where: { statementId: reconciliation.statementId, status: 'MATCHED' },
      data: { status: 'RECONCILED' },
    });

    return tx.reconciliation.update({
      where: { id: reconciliationId },
      data: {
        status: 'COMPLETED', difference, bookBalance, unreconciledCount: 0,
        completedById: actor.userId, completedAt: new Date(),
      },
    });
  });
}
