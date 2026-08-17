import { prisma } from '../../db/client.js';
import { notFound, businessRule } from '../accounting/errors.js';
import { fileSha256, parseAndValidateStatement, rowHash } from './csv.js';
import { matchStatementLines } from './matching-engine.js';
import { dec } from '../money.js';

function summarize(decisions) {
  return decisions.reduce(
    (acc, d) => {
      if (d.status === 'MATCHED') acc.autoMatched++;
      else if (d.status === 'SUGGESTED') acc.suggested++;
      else acc.unmatched++;
      return acc;
    },
    { autoMatched: 0, suggested: 0, unmatched: 0 }
  );
}

// The import pipeline (§7): hash-idempotent upload, strict all-or-nothing
// parse, insert, then run the matcher synchronously in the same transaction
// so the response already reflects auto-matched/suggested/unmatched.
//
// Same optional-tx pattern as postReceipt/postDocument: called bare it opens
// its own transaction; called with a tx (from the route's runIdempotent
// wrapper, when the caller sent an Idempotency-Key) the idempotency-key row
// and the statement land in the same commit — the exact reasoning behind
// idempotency_keys living in Postgres, not Redis (§6).
export async function importStatement(actor, { bankAccountId, fileName, csvContent, columnMapping }, tx = prisma) {
  const run = async (tx) => {
    const bankAccount = await tx.bankAccount.findFirst({
      where: { id: bankAccountId, organizationId: actor.organizationId },
    });
    if (!bankAccount) throw notFound('Bank account not found');

    const sha256 = fileSha256(csvContent);

    // Re-uploading the same file is idempotent by construction (§7 edge
    // cases, RECON-2): return the ORIGINAL statement, import nothing new.
    const existing = await tx.bankStatement.findFirst({
      where: { bankAccountId, fileSha256: sha256 },
      include: { lines: true },
    });
    if (existing) {
      const counts = existing.lines.reduce(
        (acc, l) => {
          if (l.status === 'MATCHED') acc.autoMatched++;
          else if (l.status === 'SUGGESTED') acc.suggested++;
          else if (l.status === 'UNMATCHED') acc.unmatched++;
          return acc;
        },
        { autoMatched: 0, suggested: 0, unmatched: 0 }
      );
      return { statement: existing, imported: 0, replayed: true, ...counts, lines: existing.lines };
    }

    // All rows are validated before any row is written — a half-imported
    // statement is worse than none (§7 step 5).
    const rows = parseAndValidateStatement(csvContent, columnMapping);
    if (rows.length === 0) throw businessRule('empty_statement', 'CSV has no data rows');

    const txnDates = rows.map((r) => r.txnDate).sort();
    const periodStart = new Date(txnDates[0]);
    const periodEnd = new Date(txnDates[txnDates.length - 1]);
    const lastBalance = [...rows].reverse().find((r) => r.runningBalance != null)?.runningBalance;
    const firstBalance = rows.find((r) => r.runningBalance != null)?.runningBalance;
    if (firstBalance == null || lastBalance == null) {
      throw businessRule('missing_balance_column', 'Statement rows must carry a running balance to derive opening/closing balance');
    }
    const openingBalance = dec(firstBalance).minus(dec(rows[0].credit)).plus(dec(rows[0].debit));
    const closingBalance = dec(lastBalance);

    const statement = await tx.bankStatement.create({
      data: {
        organizationId: actor.organizationId,
        bankAccountId,
        fileName,
        fileSha256: sha256,
        periodStart,
        periodEnd,
        openingBalance,
        closingBalance,
        lineCount: rows.length,
        importedById: actor.userId,
      },
    });

    const lines = [];
    for (const row of rows) {
      const line = await tx.bankStatementLine.create({
        data: {
          organizationId: actor.organizationId,
          statementId: statement.id,
          bankAccountId,
          txnDate: new Date(row.txnDate),
          description: row.description,
          reference: row.reference,
          debit: row.debit,
          credit: row.credit,
          runningBalance: row.runningBalance,
          rowHash: rowHash(row),
          status: 'UNMATCHED',
        },
      });
      lines.push(line);
    }

    const decisions = await matchStatementLines(tx, {
      organizationId: actor.organizationId,
      glAccountId: bankAccount.accountId,
      statementLines: lines,
    });

    const updatedLines = [];
    for (const d of decisions) {
      const updated = await tx.bankStatementLine.update({
        where: { id: d.statementLineId },
        data: {
          status: d.status,
          matchedJournalLineId: d.journalLineId,
          matchConfidence: d.confidence,
          matchedBy: d.matchedBy,
          matchedAt: d.journalLineId ? new Date() : null,
        },
      });
      updatedLines.push(updated);
    }

    const counts = summarize(decisions);
    return { statement, imported: rows.length, replayed: false, ...counts, lines: updatedLines };
  };

  return tx === prisma ? prisma.$transaction(run, { isolationLevel: 'ReadCommitted' }) : run(tx);
}
