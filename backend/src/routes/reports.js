import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { authenticate } from '../middleware/authenticate.js';
import { resolveTenant } from '../middleware/resolve-tenant.js';
import { authorize } from '../middleware/authorize.js';
import { notFound } from '../lib/accounting/errors.js';
import { AR_ACCOUNT_CODE } from '../lib/accounting/chart-of-accounts.js';
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

export default router;
