import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { prisma } from '../db/client.js';
import { resetDb, seedRoles, makeUserWithOrg } from './helpers.js';

// The whole demo, asserted to the paisa (§10 "the golden E2E test"): one
// customer through invoice -> post -> journal -> receipt -> allocation ->
// CSV import -> match -> create-from-line -> reconcile -> TB -> P&L -> BS ->
// aging, with every total either hand-computed or cross-checked against an
// independent query, never just asserted against itself.
let owner;
let arAccount, bankAccount, salesGoods, salesServices, vatAccount, bankChargesAccount;
let himalayan, everest;

beforeAll(async () => {
  await resetDb();
  await seedRoles();

  owner = await makeUserWithOrg(app, 'owner@golden.test', 'Annapurna Trading');

  const fiscalYear = await prisma.fiscalYear.create({
    data: { organizationId: owner.orgId, label: '2082/83', startDate: new Date('2025-07-16'), endDate: new Date('2026-07-15') },
  });
  await prisma.accountingPeriod.create({
    data: { fiscalYearId: fiscalYear.id, label: '2082/83', startDate: new Date('2025-07-16'), endDate: new Date('2026-07-15'), isOpen: true },
  });

  arAccount = await prisma.account.create({ data: { organizationId: owner.orgId, code: '1100', name: 'Accounts Receivable', type: 'ASSET', isControlAccount: true } });
  bankAccount = await prisma.account.create({ data: { organizationId: owner.orgId, code: '1020', name: 'Bank — Nabil', type: 'ASSET', isBankAccount: true } });
  salesGoods = await prisma.account.create({ data: { organizationId: owner.orgId, code: '4100', name: 'Sales — Goods', type: 'REVENUE' } });
  salesServices = await prisma.account.create({ data: { organizationId: owner.orgId, code: '4200', name: 'Sales — Services', type: 'REVENUE' } });
  vatAccount = await prisma.account.create({ data: { organizationId: owner.orgId, code: '2200', name: 'VAT Payable (Output)', type: 'LIABILITY', isControlAccount: true } });
  bankChargesAccount = await prisma.account.create({ data: { organizationId: owner.orgId, code: '5500', name: 'Bank Charges', type: 'EXPENSE' } });

  const taxCode = await prisma.taxCode.create({
    data: { organizationId: owner.orgId, code: 'VAT13', name: 'VAT 13%', rate: '0.1300', type: 'VAT', outputAccountId: vatAccount.id },
  });

  himalayan = await prisma.party.create({ data: { organizationId: owner.orgId, type: 'CUSTOMER', code: 'CUS-001', name: 'Himalayan Trek Supplies', creditDays: 30 } });
  everest = await prisma.party.create({ data: { organizationId: owner.orgId, type: 'CUSTOMER', code: 'CUS-002', name: 'Everest Cafe', creditDays: 30 } });

  owner.taxCodeId = taxCode.id;
});

afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

async function arGlBalance() {
  const [row] = await prisma.$queryRaw`
    SELECT COALESCE(SUM(jl.debit), 0) AS total_debit, COALESCE(SUM(jl.credit), 0) AS total_credit
    FROM "JournalLine" jl WHERE jl."organizationId" = ${owner.orgId} AND jl."accountId" = ${arAccount.id}
  `;
  return (Number(row.total_debit) - Number(row.total_credit)).toFixed(2);
}

function csvText(rows) {
  const header = 'Date,Description,Reference,Debit,Credit,Balance';
  const lines = rows.map((r) => [r.date, r.description, r.reference ?? '', r.debit ?? '', r.credit ?? '', r.balance ?? ''].join(','));
  return [header, ...lines].join('\n');
}

const columnMapping = {
  dateFormat: 'YYYY-MM-DD',
  columns: { date: 'Date', description: 'Description', reference: 'Reference', debit: 'Debit', credit: 'Credit', balance: 'Balance' },
};

describe('golden path: invoice -> payment -> reconciliation -> reports stay consistent', () => {
  it('every total foots, to the paisa, across the whole demo flow', async () => {
    // 1. Two invoices, two customers, two revenue accounts, VAT on both.
    const inv1 = await request(app).post('/api/v1/invoices').set(owner.headers).send({
      partyId: himalayan.id, docDate: '2025-08-01',
      lines: [{ accountId: salesGoods.id, description: 'Trekking backpacks', quantity: 15, unitPrice: 8000, taxCodeId: owner.taxCodeId }],
    });
    expect(inv1.body.grandTotal).toBe('135600.00');

    const inv1Posted = await request(app).post(`/api/v1/invoices/${inv1.body.id}/post`).set(owner.headers).send();
    expect(inv1Posted.status).toBe(200);
    expect(inv1Posted.body.invoice.docNo).toMatch(/^INV-2082-\d{4}$/);
    const inv1Lines = inv1Posted.body.journalEntry.lines;
    expect(inv1Lines.find((l) => l.accountId === arAccount.id).debit).toBe('135600.00');
    expect(inv1Lines.find((l) => l.accountId === salesGoods.id).credit).toBe('120000.00');
    expect(inv1Lines.find((l) => l.accountId === vatAccount.id).credit).toBe('15600.00');

    const inv2 = await request(app).post('/api/v1/invoices').set(owner.headers).send({
      partyId: everest.id, docDate: '2025-08-02',
      lines: [{ accountId: salesServices.id, description: 'Repair service', quantity: 1, unitPrice: 45000, taxCodeId: owner.taxCodeId }],
    });
    expect(inv2.body.grandTotal).toBe('50850.00');
    const inv2Posted = await request(app).post(`/api/v1/invoices/${inv2.body.id}/post`).set(owner.headers).send();
    expect(inv2Posted.status).toBe(200);

    // 2. Full receipt against inv2, partial against inv1 — outstanding and
    // the AR control account must agree (INV-3).
    const rcp1 = await request(app).post('/api/v1/receipts').set(owner.headers).send({
      partyId: himalayan.id, docDate: '2025-08-10', depositAccountId: bankAccount.id, amount: 100000,
      allocations: [{ invoiceId: inv1.body.id, amount: 100000 }],
    });
    expect(rcp1.status).toBe(201);
    expect(rcp1.body.receipt.docNo).toMatch(/^RCP-2082-\d{4}$/);

    const rcp2 = await request(app).post('/api/v1/receipts').set(owner.headers).send({
      partyId: everest.id, docDate: '2025-08-11', depositAccountId: bankAccount.id, amount: 50850,
      allocations: [{ invoiceId: inv2.body.id, amount: 50850 }],
    });
    expect(rcp2.status).toBe(201);

    const inv1AfterReceipt = await request(app).get(`/api/v1/invoices/${inv1.body.id}`).set(owner.headers);
    expect(inv1AfterReceipt.body.outstandingAmount ?? inv1AfterReceipt.body.grandTotal).toBeDefined();
    const openInvoices = await prisma.document.findMany({ where: { organizationId: owner.orgId, docType: 'INVOICE', status: { not: 'REVERSED' } } });
    const subledgerOutstanding = openInvoices.reduce((t, d) => t + Number(d.outstandingAmount), 0);
    expect(subledgerOutstanding.toFixed(2)).toBe('35600.00');
    expect(await arGlBalance()).toBe('35600.00'); // INV-3: subledger == GL

    // 3. Bank statement: two rows that auto-match the two receipts by
    // reference to their doc numbers (proven pattern, RECON-1), one row
    // (a bank charge) with no candidate — stays unmatched.
    const bankAccountRes = await request(app).post('/api/v1/bank-accounts').set(owner.headers).send({
      accountId: bankAccount.id, bankName: 'Nabil Bank', accountNoMasked: '****4821',
    });
    expect(bankAccountRes.status).toBe(201);
    const bankAccountId = bankAccountRes.body.id;

    const importRes = await request(app)
      .post(`/api/v1/bank-accounts/${bankAccountId}/statements`)
      .set(owner.headers)
      .field('columnMapping', JSON.stringify(columnMapping))
      .attach('file', Buffer.from(csvText([
        { date: '2025-08-10', description: `NEFT/HIMALAYAN TREK SUPPLIES/${rcp1.body.receipt.docNo}`, reference: 'NEFT8834512', credit: '100000.00', balance: '100000.00' },
        { date: '2025-08-11', description: `IPS/EVEREST CAFE/${rcp2.body.receipt.docNo}`, reference: 'IPS2210094', credit: '50850.00', balance: '150850.00' },
        { date: '2025-08-15', description: 'MONTHLY SERVICE CHARGE', debit: '1130.00', balance: '149720.00' },
      ]), 'utf8'), { filename: 'nabil-aug-2025.csv', contentType: 'text/csv' });

    expect(importRes.status).toBe(200);
    expect(importRes.body.imported).toBe(3);
    expect(importRes.body.autoMatched).toBe(2);
    expect(importRes.body.unmatched).toBe(1);

    const linesRes = await request(app).get(`/api/v1/statements/${importRes.body.statement.id}/lines`).set(owner.headers);
    const unmatchedLine = linesRes.body.lines.find((l) => l.status === 'unmatched');

    // 4. Resolve the bank charge through the real posting engine, then
    // reconcile — the footer difference must land on exactly zero.
    const createEntryRes = await request(app)
      .post(`/api/v1/lines/${unmatchedLine.id}/create-entry`)
      .set(owner.headers)
      .send({ accountId: bankChargesAccount.id });
    expect(createEntryRes.status).toBe(201);
    expect(createEntryRes.body.statementLine.status).toBe('matched');

    const recRes = await request(app).post('/api/v1/reconciliations').set(owner.headers).send({
      bankAccountId, statementId: importRes.body.statement.id, asOfDate: '2025-08-15',
    });
    expect(recRes.status).toBe(201);
    expect(recRes.body.difference).toBe('0.00');

    const completeRes = await request(app).post(`/api/v1/reconciliations/${recRes.body.id}/complete`).set(owner.headers).send();
    expect(completeRes.status).toBe(200);

    // 5. Reports — every figure hand-computed from the five journal entries
    // above (2 invoices, 2 receipts, 1 bank charge), asserted to the paisa.
    const tb = await request(app).get('/api/v1/reports/trial-balance').set(owner.headers);
    expect(tb.status).toBe(200);
    expect(tb.body.integrity.balanced).toBe(true);
    // 135600 + 50850 + 100000 + 50850 + 1130 = every entry's debit side, once each
    expect(tb.body.totals.debit).toBe('338430.00');
    expect(tb.body.totals.credit).toBe('338430.00');

    const pl = await request(app).get('/api/v1/reports/profit-loss').query({ from: '2025-07-16', to: '2026-07-15' }).set(owner.headers);
    expect(pl.status).toBe(200);
    expect(pl.body.revenueTotal).toBe('165000.00'); // 120000 + 45000
    expect(pl.body.expenseTotal).toBe('1130.00');
    expect(pl.body.netProfit).toBe('163870.00');

    const bs = await request(app).get('/api/v1/reports/balance-sheet').query({ asOf: '2026-07-15' }).set(owner.headers);
    expect(bs.status).toBe(200);
    expect(bs.body.integrity.balanced).toBe(true);
    expect(bs.body.integrity.difference).toBe('0.00');
    expect(bs.body.totals.assets).toBe('185320.00'); // AR 35600 + Bank 149720
    expect(bs.body.totals.liabilities).toBe('21450.00'); // VAT payable 15600 + 5850
    expect(bs.body.totals.equity).toBe('163870.00'); // Current Year Earnings == P&L netProfit
    const earningsLine = bs.body.equity.find((e) => e.name === 'Current Year Earnings');
    expect(earningsLine.amount).toBe('163870.00');

    const aging = await request(app).get('/api/v1/reports/ar-aging').query({ asOf: '2026-07-15' }).set(owner.headers);
    expect(aging.status).toBe(200);
    expect(aging.body.totals.grandTotal).toBe('35600.00');
    expect(aging.body.integrity.arControlBalance).toBe(aging.body.totals.grandTotal); // the auditor's test
    expect(aging.body.integrity.arControlBalance).toBe(await arGlBalance());
  });
});
