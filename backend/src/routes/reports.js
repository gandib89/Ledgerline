import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { authenticate } from '../middleware/authenticate.js';
import { resolveTenant } from '../middleware/resolve-tenant.js';
import { authorize } from '../middleware/authorize.js';
import { notFound } from '../lib/accounting/errors.js';
import { AR_ACCOUNT_CODE } from '../lib/accounting/chart-of-accounts.js';
import { findFiscalYearForDate } from '../lib/accounting/fiscal-year.js';
import { computeBookBalance } from '../lib/banking/reconciliation-service.js';
import { dec, add, sub, eq, isZero } from '../lib/money.js';

const router = Router();
router.use(authenticate, resolveTenant);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Once reverseEntry() exists, a reversed entry's own lines must NOT drop out
// of a report just because the original got flagged — the offsetting
// reversal entry (itself POSTED) is what makes the pair net to zero. Only
// DRAFT is excluded. Every posted-lines query below filters on this pair.

// Every report is a pure function of journal_lines WHERE status = 'posted'
// (§8) — no cached total, no denormalised balance, no invoice's own numbers.
router.get('/reports/trial-balance', authorize('report.view'), async (req, res, next) => {
  try {
    const query = z.object({
      asOf: z.string().regex(DATE_RE).optional(),
      from: z.string().regex(DATE_RE).optional(),
    }).parse(req.query);

    const asOf = query.asOf ?? new Date().toISOString().slice(0, 10);
    const from = query.from ?? '1900-01-01';

    const rows = await prisma.$queryRaw`
      SELECT a.code, a.name, a.type,
             SUM(jl.debit)  AS total_debit,
             SUM(jl.credit) AS total_credit
      FROM "JournalLine" jl
      JOIN "JournalEntry" je ON je.id = jl."journalEntryId"
      JOIN "Account" a       ON a.id = jl."accountId"
      WHERE jl."organizationId" = ${req.organizationId}
        AND je.status IN ('POSTED', 'REVERSED')
        AND je."entryDate" BETWEEN ${from}::date AND ${asOf}::date
      GROUP BY a.id, a.code, a.name, a.type
      HAVING SUM(jl.debit) <> 0 OR SUM(jl.credit) <> 0
      ORDER BY a.code
    `;

    let totalDebit = dec(0);
    let totalCredit = dec(0);

    const serializedRows = rows.map((r) => {
      const debit = dec(r.total_debit);
      const credit = dec(r.total_credit);
      totalDebit = add(totalDebit, debit);
      totalCredit = add(totalCredit, credit);

      return {
        code: r.code,
        name: r.name,
        type: r.type,
        totalDebit: debit.toFixed(2),
        totalCredit: credit.toFixed(2),
        debitBalance: (debit.gt(credit) ? sub(debit, credit) : dec(0)).toFixed(2),
        creditBalance: (credit.gt(debit) ? sub(credit, debit) : dec(0)).toFixed(2),
      };
    });

    const difference = sub(totalDebit, totalCredit);

    // The response carries its own integrity proof — the UI renders
    // integrity.balanced as a green check beside the totals (§8.1).
    res.json({
      asOf,
      rows: serializedRows,
      totals: { debit: totalDebit.toFixed(2), credit: totalCredit.toFixed(2) },
      integrity: { balanced: isZero(difference), difference: difference.toFixed(2) },
    });
  } catch (err) {
    next(err);
  }
});

const AGING_BUCKETS = [
  { key: 'current', label: 'Current', min: -Infinity, max: 0 },
  { key: 'd1_30', label: '1-30 days', min: 1, max: 30 },
  { key: 'd31_60', label: '31-60 days', min: 31, max: 60 },
  { key: 'd61_90', label: '61-90 days', min: 61, max: 90 },
  { key: 'd90_plus', label: '90+ days', min: 91, max: Infinity },
];

function bucketFor(daysOverdue) {
  return AGING_BUCKETS.find((b) => daysOverdue >= b.min && daysOverdue <= b.max).key;
}

// Query Document, not JournalLine — the subledger view, not the ledger view
// (§5's doc_open_by_party partial index is built exactly for this filter).
router.get('/reports/ar-aging', authorize('report.view'), async (req, res, next) => {
  try {
    const query = z.object({ asOf: z.string().regex(DATE_RE).optional() }).parse(req.query);
    const asOf = query.asOf ?? new Date().toISOString().slice(0, 10);
    const asOfDate = new Date(asOf);

    const openInvoices = await prisma.document.findMany({
      where: { organizationId: req.organizationId, docType: 'INVOICE', status: { in: ['POSTED', 'PARTIALLY_PAID'] }, outstandingAmount: { gt: 0 } },
      include: { party: true },
    });

    const byParty = new Map();
    let grandTotal = dec(0);

    for (const doc of openInvoices) {
      const dueDate = doc.dueDate ?? doc.docDate;
      const daysOverdue = Math.floor((asOfDate - dueDate) / (1000 * 60 * 60 * 24));
      const bucket = bucketFor(daysOverdue);
      const outstanding = dec(doc.outstandingAmount);

      if (!byParty.has(doc.partyId)) {
        byParty.set(doc.partyId, {
          partyId: doc.partyId,
          partyName: doc.party?.name ?? null,
          buckets: Object.fromEntries(AGING_BUCKETS.map((b) => [b.key, dec(0)])),
          total: dec(0),
          invoices: [],
        });
      }
      const row = byParty.get(doc.partyId);
      row.buckets[bucket] = add(row.buckets[bucket], outstanding);
      row.total = add(row.total, outstanding);
      row.invoices.push({ id: doc.id, docNo: doc.docNo, dueDate: dueDate.toISOString().slice(0, 10), outstandingAmount: outstanding.toFixed(2), bucket });

      grandTotal = add(grandTotal, outstanding);
    }

    // Same account-balance query style as trial balance, filtered to AR —
    // the response is self-checking (Σ bucket totals should equal this,
    // mirrors INV-3) without a second round trip from the frontend.
    const [arRow] = await prisma.$queryRaw`
      SELECT COALESCE(SUM(jl.debit), 0) AS total_debit, COALESCE(SUM(jl.credit), 0) AS total_credit
      FROM "JournalLine" jl
      JOIN "JournalEntry" je ON je.id = jl."journalEntryId"
      JOIN "Account" a ON a.id = jl."accountId"
      WHERE jl."organizationId" = ${req.organizationId}
        AND a.code = ${AR_ACCOUNT_CODE}
        AND je.status IN ('POSTED', 'REVERSED')
        AND je."entryDate" <= ${asOf}::date
    `;
    const arControlBalance = sub(dec(arRow.total_debit), dec(arRow.total_credit));

    res.json({
      asOf,
      buckets: AGING_BUCKETS.map((b) => ({ key: b.key, label: b.label })),
      rows: [...byParty.values()].map((row) => ({
        partyId: row.partyId,
        partyName: row.partyName,
        buckets: Object.fromEntries(Object.entries(row.buckets).map(([k, v]) => [k, v.toFixed(2)])),
        total: row.total.toFixed(2),
        invoices: row.invoices,
      })),
      totals: { grandTotal: grandTotal.toFixed(2) },
      integrity: { arControlBalance: arControlBalance.toFixed(2), balanced: eq(grandTotal, arControlBalance) },
    });
  } catch (err) {
    next(err);
  }
});

// account drill-down with running balance — clickable rows carry the
// source document via a LEFT JOIN on Document.journalEntryId, so the
// frontend can link a line back to the invoice/receipt/credit note that
// produced it without a second round trip.
router.get('/reports/general-ledger', authorize('report.view'), async (req, res, next) => {
  try {
    const query = z.object({
      accountId: z.string().uuid(),
      from: z.string().regex(DATE_RE).optional(),
      to: z.string().regex(DATE_RE).optional(),
    }).parse(req.query);

    const account = await prisma.account.findFirst({ where: { id: query.accountId, organizationId: req.organizationId } });
    if (!account) throw notFound('Account not found');

    const from = query.from ?? '1900-01-01';
    const to = query.to ?? new Date().toISOString().slice(0, 10);
    const debitNormal = ['ASSET', 'EXPENSE'].includes(account.type);

    const [opening] = await prisma.$queryRaw`
      SELECT COALESCE(SUM(jl.debit), 0) AS total_debit, COALESCE(SUM(jl.credit), 0) AS total_credit
      FROM "JournalLine" jl
      JOIN "JournalEntry" je ON je.id = jl."journalEntryId"
      WHERE jl."organizationId" = ${req.organizationId} AND jl."accountId" = ${query.accountId}
        AND je.status IN ('POSTED', 'REVERSED') AND je."entryDate" < ${from}::date
    `;
    let balance = debitNormal
      ? sub(dec(opening.total_debit), dec(opening.total_credit))
      : sub(dec(opening.total_credit), dec(opening.total_debit));
    const openingBalance = balance;

    const rows = await prisma.$queryRaw`
      SELECT je."entryDate" AS entry_date, je."entryNumber" AS entry_number, je.description AS entry_description,
             jl.debit, jl.credit, jl.description AS line_description, jl."journalEntryId" AS journal_entry_id,
             d.id AS source_document_id, d."docType" AS source_doc_type, d."docNo" AS source_doc_no
      FROM "JournalLine" jl
      JOIN "JournalEntry" je ON je.id = jl."journalEntryId"
      LEFT JOIN "Document" d ON d."journalEntryId" = je.id
      WHERE jl."organizationId" = ${req.organizationId} AND jl."accountId" = ${query.accountId}
        AND je.status IN ('POSTED', 'REVERSED')
        AND je."entryDate" BETWEEN ${from}::date AND ${to}::date
      ORDER BY je."entryDate" ASC, je."entryNumber" ASC
    `;

    const lines = rows.map((r) => {
      const debit = dec(r.debit);
      const credit = dec(r.credit);
      balance = debitNormal ? add(balance, sub(debit, credit)) : add(balance, sub(credit, debit));
      return {
        entryDate: r.entry_date.toISOString().slice(0, 10),
        entryNumber: r.entry_number,
        description: r.line_description ?? r.entry_description,
        debit: debit.toFixed(2),
        credit: credit.toFixed(2),
        runningBalance: balance.toFixed(2),
        journalEntryId: r.journal_entry_id,
        sourceDocumentId: r.source_document_id,
        sourceDocType: r.source_doc_type ? r.source_doc_type.toLowerCase() : null,
        sourceDocNo: r.source_doc_no,
      };
    });

    res.json({
      account: { id: account.id, code: account.code, name: account.name, type: account.type },
      from, to,
      openingBalance: openingBalance.toFixed(2),
      lines,
      closingBalance: balance.toFixed(2),
    });
  } catch (err) {
    next(err);
  }
});

// Shared by /reports/profit-loss and the Current Year Earnings line of
// /reports/balance-sheet (§8.4) — REVENUE credits-positive, EXPENSE
// debits-positive, over a date range (a *period* report, unlike the
// point-in-time balance sheet — §8.3's distinction).
async function computeProfitAndLoss(organizationId, from, to) {
  const rows = await prisma.$queryRaw`
    SELECT a.code, a.name, a.type, SUM(jl.debit) AS total_debit, SUM(jl.credit) AS total_credit
    FROM "JournalLine" jl
    JOIN "JournalEntry" je ON je.id = jl."journalEntryId"
    JOIN "Account" a       ON a.id = jl."accountId"
    WHERE jl."organizationId" = ${organizationId}
      AND je.status IN ('POSTED', 'REVERSED')
      AND a.type IN ('REVENUE', 'EXPENSE')
      AND je."entryDate" BETWEEN ${from}::date AND ${to}::date
    GROUP BY a.id, a.code, a.name, a.type
    HAVING SUM(jl.debit) <> 0 OR SUM(jl.credit) <> 0
    ORDER BY a.code
  `;

  const revenue = [];
  const expense = [];
  let revenueTotal = dec(0);
  let expenseTotal = dec(0);

  for (const r of rows) {
    const debit = dec(r.total_debit);
    const credit = dec(r.total_credit);
    if (r.type === 'REVENUE') {
      const amount = sub(credit, debit);
      revenueTotal = add(revenueTotal, amount);
      revenue.push({ code: r.code, name: r.name, amount: amount.toFixed(2) });
    } else {
      const amount = sub(debit, credit);
      expenseTotal = add(expenseTotal, amount);
      expense.push({ code: r.code, name: r.name, amount: amount.toFixed(2) });
    }
  }

  return { revenue, revenueTotal, expense, expenseTotal, netProfit: sub(revenueTotal, expenseTotal) };
}

router.get('/reports/profit-loss', authorize('report.view'), async (req, res, next) => {
  try {
    const query = z.object({ from: z.string().regex(DATE_RE).optional(), to: z.string().regex(DATE_RE).optional() }).parse(req.query);
    const to = query.to ?? new Date().toISOString().slice(0, 10);
    const from = query.from ?? (await findFiscalYearForDate(prisma, req.organizationId, new Date(to))).startDate.toISOString().slice(0, 10);

    const { revenue, revenueTotal, expense, expenseTotal, netProfit } = await computeProfitAndLoss(req.organizationId, from, to);

    res.json({
      from, to,
      revenue, revenueTotal: revenueTotal.toFixed(2),
      expense, expenseTotal: expenseTotal.toFixed(2),
      netProfit: netProfit.toFixed(2),
    });
  } catch (err) {
    next(err);
  }
});

// The critical mechanic (§8.4): Current Year Earnings is never a stored
// balance, it's Σ(income) − Σ(expense) for the fiscal year to the report
// date, computed at render — without it assets would exceed liabilities +
// equity by exactly the net profit and the sheet would not balance.
router.get('/reports/balance-sheet', authorize('report.view'), async (req, res, next) => {
  try {
    const query = z.object({ asOf: z.string().regex(DATE_RE).optional() }).parse(req.query);
    const asOf = query.asOf ?? new Date().toISOString().slice(0, 10);

    const rows = await prisma.$queryRaw`
      SELECT a.code, a.name, a.type, SUM(jl.debit) AS total_debit, SUM(jl.credit) AS total_credit
      FROM "JournalLine" jl
      JOIN "JournalEntry" je ON je.id = jl."journalEntryId"
      JOIN "Account" a       ON a.id = jl."accountId"
      WHERE jl."organizationId" = ${req.organizationId}
        AND je.status IN ('POSTED', 'REVERSED')
        AND a.type IN ('ASSET', 'LIABILITY', 'EQUITY')
        AND je."entryDate" <= ${asOf}::date
      GROUP BY a.id, a.code, a.name, a.type
      HAVING SUM(jl.debit) <> 0 OR SUM(jl.credit) <> 0
      ORDER BY a.code
    `;

    const assets = [];
    const liabilities = [];
    const equity = [];
    let totalAssets = dec(0);
    let totalLiabilities = dec(0);
    let totalEquity = dec(0);

    for (const r of rows) {
      const debit = dec(r.total_debit);
      const credit = dec(r.total_credit);
      if (r.type === 'ASSET') {
        const amount = sub(debit, credit);
        totalAssets = add(totalAssets, amount);
        assets.push({ code: r.code, name: r.name, amount: amount.toFixed(2) });
      } else if (r.type === 'LIABILITY') {
        const amount = sub(credit, debit);
        totalLiabilities = add(totalLiabilities, amount);
        liabilities.push({ code: r.code, name: r.name, amount: amount.toFixed(2) });
      } else {
        const amount = sub(credit, debit);
        totalEquity = add(totalEquity, amount);
        equity.push({ code: r.code, name: r.name, amount: amount.toFixed(2) });
      }
    }

    const fiscalYear = await findFiscalYearForDate(prisma, req.organizationId, new Date(asOf));
    const { netProfit } = await computeProfitAndLoss(req.organizationId, fiscalYear.startDate.toISOString().slice(0, 10), asOf);
    equity.push({ code: null, name: 'Current Year Earnings', amount: netProfit.toFixed(2) });
    totalEquity = add(totalEquity, netProfit);

    const difference = sub(totalAssets, add(totalLiabilities, totalEquity));

    res.json({
      asOf,
      assets, liabilities, equity,
      totals: { assets: totalAssets.toFixed(2), liabilities: totalLiabilities.toFixed(2), equity: totalEquity.toFixed(2) },
      integrity: { balanced: isZero(difference), difference: difference.toFixed(2) },
    });
  } catch (err) {
    next(err);
  }
});

// Comes free with §7 — the same book/bank/difference the reconciliation
// workspace's sticky footer shows, formatted the way accountants read it
// (§8.6), computed live rather than only at the moment a Reconciliation row
// is created or completed.
router.get('/reports/bank-reconciliation', authorize('report.view'), async (req, res, next) => {
  try {
    const query = z.object({
      bankAccountId: z.string().uuid(),
      statementId: z.string().uuid().optional(),
      asOf: z.string().regex(DATE_RE).optional(),
    }).parse(req.query);

    const bankAccount = await prisma.bankAccount.findFirst({ where: { id: query.bankAccountId, organizationId: req.organizationId } });
    if (!bankAccount) throw notFound('Bank account not found');

    const statement = query.statementId
      ? await prisma.bankStatement.findFirst({ where: { id: query.statementId, organizationId: req.organizationId, bankAccountId: bankAccount.id } })
      : await prisma.bankStatement.findFirst({ where: { organizationId: req.organizationId, bankAccountId: bankAccount.id }, orderBy: { importedAt: 'desc' } });
    if (!statement) throw notFound('No statement imported for this bank account');

    const asOf = query.asOf ?? statement.periodEnd.toISOString().slice(0, 10);

    const bookBalance = await computeBookBalance(prisma, { organizationId: req.organizationId, glAccountId: bankAccount.accountId, asOfDate: asOf });
    const bankBalance = dec(statement.closingBalance);
    const difference = sub(bankBalance, bookBalance);

    const lines = await prisma.bankStatementLine.findMany({ where: { statementId: statement.id } });
    const counts = { autoMatched: 0, manualMatched: 0, suggested: 0, unmatched: 0, ignored: 0 };
    for (const l of lines) {
      if (['MATCHED', 'RECONCILED'].includes(l.status)) {
        if (l.matchedBy === 'MANUAL') counts.manualMatched++; else counts.autoMatched++;
      } else if (l.status === 'SUGGESTED') counts.suggested++;
      else if (l.status === 'IGNORED') counts.ignored++;
      else counts.unmatched++;
    }

    res.json({
      asOf,
      bankAccountId: bankAccount.id,
      statementId: statement.id,
      bankBalance: bankBalance.toFixed(2),
      bookBalance: bookBalance.toFixed(2),
      difference: difference.toFixed(2),
      integrity: { balanced: isZero(difference) },
      counts: { ...counts, matched: counts.autoMatched + counts.manualMatched, total: lines.length },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
