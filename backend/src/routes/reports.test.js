import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { prisma } from '../db/client.js';
import { resetDb, seedRoles, makeUserWithOrg } from '../test/helpers.js';

let owner, salesAccount, party, fiscalYear;

beforeAll(async () => {
  await resetDb();
  await seedRoles();

  owner = await makeUserWithOrg(app, 'owner@reports.test', 'Reports Test Co');

  fiscalYear = await prisma.fiscalYear.create({
    data: { organizationId: owner.orgId, label: '2082/83', startDate: new Date('2025-07-16'), endDate: new Date('2026-07-15') },
  });
  await prisma.accountingPeriod.create({
    data: { fiscalYearId: fiscalYear.id, label: 'Shrawan', startDate: new Date('2025-07-16'), endDate: new Date('2025-08-15'), isOpen: true },
  });
  await prisma.accountingPeriod.create({
    data: { fiscalYearId: fiscalYear.id, label: 'Bhadra', startDate: new Date('2025-08-16'), endDate: new Date('2025-09-15'), isOpen: true },
  });
  await prisma.accountingPeriod.create({
    data: { fiscalYearId: fiscalYear.id, label: 'Ashwin', startDate: new Date('2025-09-16'), endDate: new Date('2025-10-15'), isOpen: true },
  });
  await prisma.accountingPeriod.create({
    data: { fiscalYearId: fiscalYear.id, label: 'Kartik', startDate: new Date('2025-10-16'), endDate: new Date('2025-11-15'), isOpen: true },
  });

  await prisma.accountingPeriod.create({
    data: { fiscalYearId: fiscalYear.id, label: 'Mangsir', startDate: new Date('2025-11-16'), endDate: new Date('2025-12-15'), isOpen: true },
  });

  await prisma.account.create({ data: { organizationId: owner.orgId, code: '1100', name: 'Accounts Receivable', type: 'ASSET', isControlAccount: true } });
  await prisma.account.create({ data: { organizationId: owner.orgId, code: '1020', name: 'Bank — Nabil', type: 'ASSET', isBankAccount: true } });
  salesAccount = await prisma.account.create({ data: { organizationId: owner.orgId, code: '4100', name: 'Sales Revenue', type: 'REVENUE' } });
  party = await prisma.party.create({ data: { organizationId: owner.orgId, type: 'CUSTOMER', code: 'CUS-001', name: 'Himalayan Trek Supplies', creditDays: 30 } });
});

afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

async function postInvoice(docDate, amount) {
  const created = await request(app).post('/api/v1/invoices').set(owner.headers).send({
    partyId: party.id, docDate,
    lines: [{ accountId: salesAccount.id, description: 'Goods', quantity: 1, unitPrice: amount }],
  });
  await request(app).post(`/api/v1/invoices/${created.body.id}/post`).set(owner.headers).send();
  return created.body.id;
}

describe('GET /reports/ar-aging', () => {
  // "Today" is Nepal's today; pin the clock (Date only, so DB timers still run).
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2025-11-15T06:00:00Z'));
  });
  afterAll(() => vi.useRealTimers());

  async function postReceipt(docDate, amount, allocations = []) {
    const bank = await prisma.account.findFirstOrThrow({ where: { organizationId: owner.orgId, code: '1020' } });
    const res = await request(app).post('/api/v1/receipts').set(owner.headers).send({
      partyId: party.id, docDate, depositAccountId: bank.id, amount, allocations,
    });
    expect(res.status).toBe(201);
    return res.body;
  }

  it('buckets open invoices, nets partial and unapplied receipts, and reconciles to AR (1100)', async () => {
    await postInvoice('2025-11-10', 1000); // due 2025-12-10 -> not yet due -> current
    const overdue = await postInvoice('2025-10-01', 2000); // due 2025-10-31 -> 15 days overdue -> 1-30
    await postInvoice('2025-07-20', 3000); // due 2025-08-19 -> 88 days overdue -> 61-90
    await postReceipt('2025-11-12', 500, [{ invoiceId: overdue, amount: 500 }]); // partial: 1-30 bucket 2000 -> 1500
    await postReceipt('2025-11-13', 800); // unapplied advance: reduces what the customer owes

    const res = await request(app).get('/api/v1/reports/ar-aging').set(owner.headers);
    expect(res.status).toBe(200);
    expect(res.body.asOf).toBe('2025-11-15');

    const row = res.body.rows.find((r) => r.partyId === party.id);
    expect(row.buckets.current).toBe('1000.00');
    expect(row.buckets.d1_30).toBe('1500.00');
    expect(row.buckets.d61_90).toBe('3000.00');
    expect(row.unapplied).toBe('-800.00');
    expect(row.total).toBe('4700.00'); // 5500 open invoices - 800 unapplied

    expect(res.body.totals.grandTotal).toBe('4700.00');
    expect(res.body.integrity.arControlBalance).toBe('4700.00');
    expect(res.body.integrity.balanced).toBe(true);
  });

  it('ignores documents whose Posting Date is after today', async () => {
    const before = await request(app).get('/api/v1/reports/ar-aging').set(owner.headers);
    await postInvoice('2025-11-20', 7000); // postingDate in the future
    const after = await request(app).get('/api/v1/reports/ar-aging').set(owner.headers);

    expect(after.body.totals.grandTotal).toBe(before.body.totals.grandTotal);
    expect(after.body.integrity.balanced).toBe(true);
  });

  it('rejects the asOf query parameter', async () => {
    const res = await request(app).get('/api/v1/reports/ar-aging?asOf=').set(owner.headers);
    expect(res.status).toBe(400);
    const dated = await request(app).get('/api/v1/reports/ar-aging').query({ asOf: '2025-11-15' }).set(owner.headers);
    expect(dated.status).toBe(400);
  });

  it('adds back allocations from future-dated receipts so the total still equals AR (1100)', async () => {
    const holeParty = await prisma.party.create({ data: { organizationId: owner.orgId, type: 'CUSTOMER', code: 'CUS-HOLE', name: 'Future Receipt Customer', creditDays: 30 } });
    const created = await request(app).post('/api/v1/invoices').set(owner.headers).send({
      partyId: holeParty.id, docDate: '2025-10-20',
      lines: [{ accountId: salesAccount.id, description: 'Goods', quantity: 1, unitPrice: 2500 }],
    });
    await request(app).post(`/api/v1/invoices/${created.body.id}/post`).set(owner.headers).send();
    const bank = await prisma.account.findFirstOrThrow({ where: { organizationId: owner.orgId, code: '1020' } });
    // Receipt dated after today, already allocated 1000 to the invoice: the ledger does not see it yet.
    const receipt = await request(app).post('/api/v1/receipts').set(owner.headers).send({
      partyId: holeParty.id, docDate: '2025-11-20', depositAccountId: bank.id, amount: 1200, allocations: [{ invoiceId: created.body.id, amount: 1000 }],
    });
    expect(receipt.status).toBe(201);

    const res = await request(app).get('/api/v1/reports/ar-aging').set(owner.headers);
    const row = res.body.rows.find((r) => r.partyId === holeParty.id);
    expect(row.buckets.current).toBe('2500.00'); // 2500 - 1000 allocated, + 1000 added back
    expect(row.unapplied).toBe('0.00'); // the 200 remainder belongs to a future receipt
    expect(row.total).toBe('2500.00');
    expect(res.body.integrity.balanced).toBe(true);
  });

  it("never includes another organization's documents", async () => {
    const other = await makeUserWithOrg(app, 'other@reports.test', 'Other Co');
    await prisma.account.create({ data: { organizationId: other.orgId, code: '1100', name: 'Accounts Receivable', type: 'ASSET', isControlAccount: true } });
    const otherParty = await prisma.party.create({ data: { organizationId: other.orgId, type: 'CUSTOMER', code: 'CUS-901', name: 'Other Customer' } });
    const otherFy = await prisma.fiscalYear.create({
      data: { organizationId: other.orgId, label: '2082/83', startDate: new Date('2025-07-16'), endDate: new Date('2026-07-15') },
    });
    await prisma.document.create({
      data: {
        organizationId: other.orgId, fiscalYearId: otherFy.id, docType: 'INVOICE', docDate: new Date('2025-11-01'), postingDate: new Date('2025-11-01'),
        partyId: otherParty.id, status: 'POSTED', grandTotal: 999, outstandingAmount: 999,
      },
    });
    await prisma.document.create({
      data: {
        organizationId: other.orgId, fiscalYearId: otherFy.id, docType: 'RECEIPT', docDate: new Date('2025-11-01'), postingDate: new Date('2025-11-01'),
        partyId: otherParty.id, status: 'POSTED', grandTotal: 333, outstandingAmount: 333,
      },
    });

    const res = await request(app).get('/api/v1/reports/ar-aging').set(owner.headers);
    expect(res.body.rows.find((r) => r.partyId === otherParty.id)).toBeUndefined();
    expect(res.body.integrity.balanced).toBe(true);
  });
});

describe('GET /reports/ap-aging', () => {
  let expenseAccount, supplierA, supplierB, supplierC, bank;
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2025-11-15T06:00:00Z'));
    await prisma.account.create({ data: { organizationId: owner.orgId, code: '2100', name: 'Accounts Payable', type: 'LIABILITY', isControlAccount: true } });
    expenseAccount = await prisma.account.create({ data: { organizationId: owner.orgId, code: '5100', name: 'Office Supplies', type: 'EXPENSE' } });
    bank = await prisma.account.findFirstOrThrow({ where: { organizationId: owner.orgId, code: '1020' } });
    const mk = (code, name, creditDays) => prisma.party.create({ data: { organizationId: owner.orgId, type: 'SUPPLIER', code, name, creditDays } });
    supplierA = await mk('SUP-A', 'Alpha Stationers', 30);
    supplierB = await mk('SUP-B', 'Beta Traders', 15);
    supplierC = await mk('SUP-C', 'Gamma Supplies', 30);
  });
  afterAll(() => vi.useRealTimers());

  let refSeq = 0;
  async function postBill(partyId, docDate, amount, postingDate) {
    refSeq += 1;
    const created = await request(app).post('/api/v1/bills').set(owner.headers).send({
      partyId, docDate, referenceNo: `AP-${refSeq}`, ...(postingDate ? { postingDate } : {}),
      lines: [{ accountId: expenseAccount.id, description: 'Goods', quantity: 1, unitPrice: amount }],
    });
    expect(created.status).toBe(201);
    const posted = await request(app).post(`/api/v1/bills/${created.body.id}/post`).set(owner.headers).send();
    expect(posted.status).toBe(200);
    return created.body.id;
  }
  async function payBill(partyId, docDate, amount, allocations = []) {
    refSeq += 1;
    const res = await request(app).post('/api/v1/supplier-payments').set(owner.headers).set('Idempotency-Key', `ap-aging-${refSeq}`).send({
      partyId, docDate, paidFromAccountId: bank.id, amount, allocations,
    });
    expect(res.status).toBe(201);
    return res.body.supplierPayment.id;
  }
  const getAging = () => request(app).get('/api/v1/reports/ap-aging').set(owner.headers);

  it('buckets open Bills from the Due Date, nets partial and unapplied payments, and reconciles to AP (2100)', async () => {
    await postBill(supplierA.id, '2025-11-10', 1000); // due 2025-12-10 -> current
    const overdue = await postBill(supplierA.id, '2025-10-01', 2000); // due 2025-10-31 -> 15 days overdue -> 1-30
    await postBill(supplierA.id, '2025-07-20', 3000, '2025-11-05'); // late Bill: due 2025-08-19 -> 88 days overdue -> 61-90
    await postBill(supplierB.id, '2025-09-01', 4000); // due 2025-09-16 -> 60 days overdue -> 31-60
    await postBill(supplierB.id, '2025-11-20', 7000); // future Posting Date -> excluded
    await payBill(supplierA.id, '2025-11-12', 500, [{ billId: overdue, amount: 500 }]); // 2000 -> 1500
    await payBill(supplierA.id, '2025-11-13', 800); // unapplied advance

    const res = await getAging();
    expect(res.status).toBe(200);
    expect(res.body.asOf).toBe('2025-11-15');

    const a = res.body.rows.find((r) => r.partyId === supplierA.id);
    expect(a.buckets).toEqual({ current: '1000.00', d1_30: '1500.00', d31_60: '0.00', d61_90: '3000.00', d90_plus: '0.00' });
    expect(a.unapplied).toBe('-800.00');
    expect(a.total).toBe('4700.00'); // 5500 open Bills - 800 unapplied
    expect(a.invoices).toHaveLength(3);

    const b = res.body.rows.find((r) => r.partyId === supplierB.id);
    expect(b.buckets).toEqual({ current: '0.00', d1_30: '0.00', d31_60: '4000.00', d61_90: '0.00', d90_plus: '0.00' });
    expect(b.unapplied).toBe('0.00');
    expect(b.total).toBe('4000.00');

    expect(res.body.totals.grandTotal).toBe('8700.00');
    expect(res.body.integrity.apControlBalance).toBe('8700.00');
    expect(res.body.integrity.balanced).toBe(true);
  });

  it('adds back allocations from future-dated payments so the total still equals AP (2100)', async () => {
    const bill = await postBill(supplierC.id, '2025-10-25', 2500); // due 2025-11-24 -> current
    // Payment dated after today, already allocated 1000 to the Bill: the ledger does not see it yet.
    await payBill(supplierC.id, '2025-11-20', 1200, [{ billId: bill, amount: 1000 }]);

    const res = await getAging();
    const row = res.body.rows.find((r) => r.partyId === supplierC.id);
    expect(row.buckets.current).toBe('2500.00'); // 2500 - 1000 allocated, + 1000 added back
    expect(row.unapplied).toBe('0.00'); // the 200 remainder belongs to a future payment
    expect(row.total).toBe('2500.00');
    expect(res.body.integrity.balanced).toBe(true);
  });

  it('keeps a Bill that a future-dated payment settles in full, and counts allocations to a future-dated Bill as unapplied', async () => {
    const paidLater = await postBill(supplierC.id, '2025-10-26', 600); // due 2025-11-25 -> current
    await payBill(supplierC.id, '2025-11-21', 600, [{ billId: paidLater, amount: 600 }]); // Bill becomes PAID, payment in the future
    const futureBill = await postBill(supplierC.id, '2025-11-22', 900); // future Posting Date
    await payBill(supplierC.id, '2025-11-14', 1000, [{ billId: futureBill, amount: 400 }]); // earlier payment, 400 applied to a future Bill

    const res = await getAging();
    const row = res.body.rows.find((r) => r.partyId === supplierC.id);
    expect(row.buckets.current).toBe('3100.00'); // 2500 + 600
    expect(row.unapplied).toBe('-1000.00'); // 600 outstanding + 400 applied to a Bill the ledger does not see yet
    expect(row.total).toBe('2100.00');
    expect(res.body.integrity.balanced).toBe(true);
  });

  it('rejects the asOf query parameter', async () => {
    expect((await request(app).get('/api/v1/reports/ap-aging?asOf=').set(owner.headers)).status).toBe(400);
    expect((await request(app).get('/api/v1/reports/ap-aging').query({ asOf: '2025-11-15' }).set(owner.headers)).status).toBe(400);
  });

  it("never includes another organization's Bills or payments", async () => {
    const other = await makeUserWithOrg(app, 'other-ap@reports.test', 'Other AP Co');
    await prisma.account.create({ data: { organizationId: other.orgId, code: '2100', name: 'Accounts Payable', type: 'LIABILITY', isControlAccount: true } });
    const otherSupplier = await prisma.party.create({ data: { organizationId: other.orgId, type: 'SUPPLIER', code: 'SUP-901', name: 'Other Supplier' } });
    const otherFy = await prisma.fiscalYear.create({
      data: { organizationId: other.orgId, label: '2082/83', startDate: new Date('2025-07-16'), endDate: new Date('2026-07-15') },
    });
    const mkDoc = (docType, amount, postingDate = '2025-11-01') => prisma.document.create({
      data: {
        organizationId: other.orgId, fiscalYearId: otherFy.id, docType, docDate: new Date(postingDate), postingDate: new Date(postingDate),
        partyId: otherSupplier.id, status: 'POSTED', grandTotal: amount, outstandingAmount: amount,
        ...(docType === 'BILL' ? { referenceNo: 'THEIRS-1' } : {}),
      },
    });
    const otherBill = await mkDoc('BILL', 999);
    await mkDoc('SUPPLIER_PAYMENT', 333);
    // a future-dated payment of org B allocated to org B's Bill
    const otherFuture = await mkDoc('SUPPLIER_PAYMENT', 100, '2025-11-25');
    await prisma.paymentAllocation.create({ data: { organizationId: other.orgId, paymentDocumentId: otherFuture.id, targetDocumentId: otherBill.id, amount: 100 } });

    const res = await getAging();
    expect(res.body.rows.find((r) => r.partyId === otherSupplier.id)).toBeUndefined();
    expect(res.body.rows.flatMap((r) => r.invoices).find((i) => i.id === otherBill.id)).toBeUndefined();
    expect(res.body.integrity.balanced).toBe(true);
  });
});

describe('GET /reports/general-ledger', () => {
  it('computes a running balance in date order and links back to the source document', async () => {
    const account = await prisma.account.findFirstOrThrow({ where: { organizationId: owner.orgId, code: '4100' } });

    // Other tests in this file post to the same revenue account, so this
    // asserts against the report's own opening balance rather than assuming
    // isolation — the point under test is that lines accumulate correctly
    // ON TOP of whatever came before, in date order.
    const before = await request(app)
      .get('/api/v1/reports/general-ledger')
      .query({ accountId: account.id, from: '2025-10-22', to: '2025-10-31' })
      .set(owner.headers);
    const opening = Number(before.body.openingBalance);

    const invoiceId1 = await postInvoice('2025-10-25', 500);
    const invoiceId2 = await postInvoice('2025-10-26', 750);

    const res = await request(app)
      .get('/api/v1/reports/general-ledger')
      .query({ accountId: account.id, from: '2025-10-22', to: '2025-10-31' })
      .set(owner.headers);

    expect(res.status).toBe(200);
    expect(res.body.account.code).toBe('4100');
    expect(res.body.lines).toHaveLength(2);
    expect(res.body.lines[0].runningBalance).toBe((opening + 500).toFixed(2));
    expect(res.body.lines[1].runningBalance).toBe((opening + 1250).toFixed(2));
    expect(res.body.closingBalance).toBe((opening + 1250).toFixed(2));
    expect(res.body.lines[0].sourceDocType).toBe('invoice');
    expect([res.body.lines[0].sourceDocumentId, res.body.lines[1].sourceDocumentId]).toEqual(
      expect.arrayContaining([invoiceId1, invoiceId2])
    );
  });
});

describe('GET /reports/profit-loss', () => {
  it('computes revenue credits-positive and expense debits-positive over a period', async () => {
    const expenseAccount = await prisma.account.create({ data: { organizationId: owner.orgId, code: '5900', name: 'Misc Expense', type: 'EXPENSE' } });
    const bankAccount = await prisma.account.findFirstOrThrow({ where: { organizationId: owner.orgId, code: '1020' } });

    await postInvoice('2025-11-01', 50000);
    const jvRes = await request(app).post('/api/v1/journal-entries').set(owner.headers).send({
      entryDate: '2025-11-02', narration: 'Office supplies',
      lines: [
        { accountId: expenseAccount.id, debit: 20000 },
        { accountId: bankAccount.id, credit: 20000 },
      ],
    });
    expect(jvRes.status).toBe(201);

    const res = await request(app).get('/api/v1/reports/profit-loss').query({ from: '2025-11-01', to: '2025-11-02' }).set(owner.headers);
    expect(res.status).toBe(200);
    expect(res.body.revenueTotal).toBe('50000.00');
    expect(res.body.expenseTotal).toBe('20000.00');
    expect(res.body.netProfit).toBe('30000.00');
  });
});

describe('GET /reports/balance-sheet', () => {
  it('balances via the computed Current Year Earnings line (§8.4)', async () => {
    // Deliberately not isolated to its own postings — the accounting
    // equation must hold no matter what the rest of this file has already
    // posted, since every entry above balanced by construction.
    const res = await request(app).get('/api/v1/reports/balance-sheet').query({ asOf: '2025-11-05' }).set(owner.headers);
    expect(res.status).toBe(200);
    expect(res.body.integrity.balanced).toBe(true);
    expect(res.body.integrity.difference).toBe('0.00');

    const earningsLine = res.body.equity.find((e) => e.name === 'Current Year Earnings');
    expect(earningsLine).toBeDefined();
    const arLine = res.body.assets.find((a) => a.code === '1100');
    expect(arLine).toBeDefined();
  });
});

describe('PATCH /periods/:id + INV-10: period locking enforced by the database', () => {
  it('locking a period through the real endpoint blocks posting into it', async () => {
    const period = await prisma.accountingPeriod.findFirstOrThrow({ where: { fiscalYearId: fiscalYear.id, label: 'Bhadra' } });

    const lockRes = await request(app).patch(`/api/v1/periods/${period.id}`).set(owner.headers).send({ isOpen: false });
    expect(lockRes.status).toBe(200);
    expect(lockRes.body.isOpen).toBe(false);

    const created = await request(app).post('/api/v1/invoices').set(owner.headers).send({
      partyId: party.id, docDate: '2025-08-20',
      lines: [{ accountId: salesAccount.id, description: 'Goods', quantity: 1, unitPrice: 100 }],
    });
    const postRes = await request(app).post(`/api/v1/invoices/${created.body.id}/post`).set(owner.headers).send();

    expect(postRes.status).toBe(422);
    expect(postRes.body.error.code).toBe('period_locked');

    // Unlock so it doesn't leak into other assertions if this file grows.
    await request(app).patch(`/api/v1/periods/${period.id}`).set(owner.headers).send({ isOpen: true });
  });

  it('rejects locking a period belonging to another organization as not-found', async () => {
    const other = await makeUserWithOrg(app, 'owner@other-reports.test', 'Other Reports Co');
    const otherFiscalYear = await prisma.fiscalYear.create({
      data: { organizationId: other.orgId, label: '2082/83', startDate: new Date('2025-07-16'), endDate: new Date('2026-07-15') },
    });
    const otherPeriod = await prisma.accountingPeriod.create({
      data: { fiscalYearId: otherFiscalYear.id, label: 'Shrawan', startDate: new Date('2025-07-16'), endDate: new Date('2025-08-15'), isOpen: true },
    });

    const res = await request(app).patch(`/api/v1/periods/${otherPeriod.id}`).set(owner.headers).send({ isOpen: false });
    expect(res.status).toBe(404);
  });
});
