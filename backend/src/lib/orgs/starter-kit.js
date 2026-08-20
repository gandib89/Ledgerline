// plan §5 (line 80): "Chart of Accounts, seeded (~28 accounts, 5 types) —
// seeded, not user-built." Every new organization gets this same starter
// kit — the standard COA, one fiscal year (2082/83, per the plan's own
// AD-only date compromise, §"Bikram Sambat"), and the VAT13 tax code —
// instead of a chart-of-accounts editor. Shared by prisma/seed.js (demo
// orgs) and POST /orgs (organizations users create through the app), so
// both paths produce an identically-shaped organization.

const ACCOUNTS = [
  ['1010', 'Cash in Hand', 'ASSET'],
  ['1020', 'Bank — Nabil Bank Current', 'ASSET', { isBankAccount: true }],
  ['1030', 'Bank — NIC Asia Savings', 'ASSET', { isBankAccount: true }],
  ['1100', 'Accounts Receivable', 'ASSET', { isControlAccount: true }],
  ['1200', 'Prepaid Expenses', 'ASSET'],
  ['1300', 'Fixed Assets — Equipment', 'ASSET'],
  ['1310', 'Accum. Depreciation — Equip.', 'ASSET'],
  ['2100', 'Accounts Payable', 'LIABILITY', { isControlAccount: true }],
  ['2200', 'VAT Payable (Output)', 'LIABILITY', { isControlAccount: true }],
  ['2210', 'VAT Receivable (Input)', 'ASSET', { isControlAccount: true }],
  ['2300', 'TDS Payable', 'LIABILITY'],
  ['2400', 'Accrued Expenses', 'LIABILITY'],
  ['3100', "Owner's Capital", 'EQUITY'],
  ['3200', 'Retained Earnings', 'EQUITY'],
  ['3900', 'Current Year Earnings', 'EQUITY'],
  ['4100', 'Sales Revenue — Goods', 'REVENUE'],
  ['4200', 'Sales Revenue — Services', 'REVENUE'],
  ['4300', 'Discount Given', 'REVENUE'],
  ['4900', 'Other Income', 'REVENUE'],
  ['5100', 'Cost of Sales', 'EXPENSE'],
  ['5200', 'Salaries & Wages', 'EXPENSE'],
  ['5300', 'Rent Expense', 'EXPENSE'],
  ['5400', 'Utilities', 'EXPENSE'],
  ['5500', 'Bank Charges', 'EXPENSE'],
  ['5600', 'Professional Fees', 'EXPENSE'],
  ['5700', 'Depreciation Expense', 'EXPENSE'],
  ['5900', 'Other Expenses', 'EXPENSE'],
];

const PERIOD_LABELS = [
  'Shrawan', 'Bhadra', 'Ashwin', 'Kartik', 'Mangsir', 'Poush',
  'Magh', 'Falgun', 'Chaitra', 'Baisakh', 'Jestha', 'Ashadh',
];

// Shared by the starter kit (first fiscal year, fixed 2082/83) and the
// POST /fiscal-years rollover (next fiscal year, computed) — same record
// shape either way: one FiscalYear plus its 12 AccountingPeriods.
export async function createFiscalYearWithPeriods(tx, organizationId, { label, startDate, endDate }) {
  const fiscalYear = await tx.fiscalYear.upsert({
    where: { organizationId_label: { organizationId, label } },
    update: {},
    create: { organizationId, label, startDate, endDate },
  });

  const cursor = new Date(fiscalYear.startDate);
  for (const periodLabel of PERIOD_LABELS) {
    const start = new Date(cursor);
    const end = new Date(cursor);
    end.setMonth(end.getMonth() + 1);
    end.setDate(end.getDate() - 1);

    await tx.accountingPeriod.upsert({
      where: { fiscalYearId_label: { fiscalYearId: fiscalYear.id, label: periodLabel } },
      update: {},
      create: {
        fiscalYearId: fiscalYear.id,
        label: periodLabel,
        startDate: start,
        endDate: end,
        isOpen: true,
      },
    });

    cursor.setMonth(cursor.getMonth() + 1);
  }

  return fiscalYear;
}

// The plan's own anchor fiscal year (Section 14's curated demo dates).
// Demo orgs (prisma/seed.js) always get exactly this one. Real onboarding
// (POST /orgs/:id/starter-kit) needs whichever fiscal year actually covers
// today instead — an org created after 2026-07-16 with only this window
// could never post anything, dated today, ever.
const ANCHOR_FISCAL_YEAR = { label: '2082/83', startDate: new Date('2025-07-17'), endDate: new Date('2026-07-16') };

// "2082/83" -> "2083/84": bump both halves by one year. Every fiscal year
// this app ever creates already follows this shape, so no format
// validation is needed here.
export function nextFiscalYearLabel(label) {
  const nextMajor = Number(label.split('/')[0]) + 1;
  return `${nextMajor}/${String(nextMajor + 1).slice(-2)}`;
}

// The window immediately following the given one — same span (roughly a
// year), no gap. Used both to roll an org's fiscal year forward (from its
// latest DB row) and to walk the anchor forward in-memory to find today's
// window (below).
export function nextFiscalYearWindow({ label, endDate }) {
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() + 1);
  const nextEndDate = new Date(startDate);
  nextEndDate.setFullYear(nextEndDate.getFullYear() + 1);
  nextEndDate.setDate(nextEndDate.getDate() - 1);
  return { label: nextFiscalYearLabel(label), startDate, endDate: nextEndDate };
}

// Walks forward from the anchor fiscal year until it finds the window that
// contains referenceDate — the fiscal year a brand-new org should start
// with today, rather than always the plan's fixed 2025-07-17 anchor.
export function currentFiscalYearWindow(referenceDate = new Date()) {
  let window = ANCHOR_FISCAL_YEAR;
  while (referenceDate > window.endDate) {
    window = nextFiscalYearWindow(window);
  }
  return window;
}

async function provisionFiscalYearAndPeriods(tx, organizationId, window) {
  await createFiscalYearWithPeriods(tx, organizationId, window);
}

async function provisionAccounts(tx, organizationId) {
  for (const [code, name, type, flags = {}] of ACCOUNTS) {
    await tx.account.upsert({
      where: { organizationId_code: { organizationId, code } },
      update: {},
      create: { organizationId, code, name, type, ...flags },
    });
  }
}

async function provisionTaxCodes(tx, organizationId) {
  const outputAccount = await tx.account.findUniqueOrThrow({
    where: { organizationId_code: { organizationId, code: '2200' } },
  });

  await tx.taxCode.upsert({
    where: { organizationId_code: { organizationId, code: 'VAT13' } },
    update: {
      name: 'VAT 13%',
      rate: '0.1300',
      type: 'VAT',
      outputAccountId: outputAccount.id,
      isActive: true,
    },
    create: {
      organizationId,
      code: 'VAT13',
      name: 'VAT 13%',
      rate: '0.1300',
      type: 'VAT',
      outputAccountId: outputAccount.id,
    },
  });
}

export const STARTER_ACCOUNT_COUNT = ACCOUNTS.length;

export async function provisionStarterKit(tx, organizationId, fiscalYearWindow = ANCHOR_FISCAL_YEAR) {
  await provisionFiscalYearAndPeriods(tx, organizationId, fiscalYearWindow);
  await provisionAccounts(tx, organizationId);
  await provisionTaxCodes(tx, organizationId);
}
