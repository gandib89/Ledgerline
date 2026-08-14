import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { authenticate } from '../middleware/authenticate.js';
import { resolveTenant } from '../middleware/resolve-tenant.js';
import { authorize } from '../middleware/authorize.js';
import { dec, add, sub, isZero } from '../lib/money.js';

const router = Router();
router.use(authenticate, resolveTenant);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
        AND je.status = 'POSTED'
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

export default router;
