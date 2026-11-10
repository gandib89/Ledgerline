import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { prisma } from '../db/client.js';
import { resetDb, seedRoles, makeUserWithOrg } from '../test/helpers.js';

let owner, clerk, viewer, other;
let expense, ap, cash, bank, supplier, supplier2, customer, vat13;
let otherSupplier, otherBank, otherBill;

async function addMember(roles, email, roleName) {
  await request(app).post('/api/v1/auth/register').send({ email, password: 'password123' });
  await request(app)
    .post(`/api/v1/orgs/${owner.orgId}/members`)
    .set(owner.headers)
    .send({ email, roleId: roles[roleName].id });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: 'password123' });
  return { Authorization: `Bearer ${login.body.accessToken}`, 'X-Organization-Id': owner.orgId };
}

async function seedOrg(orgId) {
  const fy = await prisma.fiscalYear.create({
    data: { organizationId: orgId, label: '2082/83', startDate: new Date('2025-07-16'), endDate: new Date('2026-07-15') },
  });
  await prisma.accountingPeriod.create({
    data: { fiscalYearId: fy.id, label: 'Shrawan', startDate: new Date('2025-07-16'), endDate: new Date('2025-08-15'), isOpen: true },
  });
  const acc = (code, name, type, extra = {}) => prisma.account.create({ data: { organizationId: orgId, code, name, type, ...extra } });
  const exp = await acc('5100', 'Office Supplies', 'EXPENSE');
  const apAcc = await acc('2100', 'Accounts Payable', 'LIABILITY', { isControlAccount: true });
  const vatInAcc = await acc('2210', 'VAT Receivable (Input)', 'ASSET', { isControlAccount: true });
  const cashAcc = await acc('1010', 'Cash in Hand', 'ASSET');
  const bankAcc = await acc('1020', 'Bank - Nabil', 'ASSET', { isBankAccount: true });
  const tax = await prisma.taxCode.create({
    data: { organizationId: orgId, code: 'VAT13', name: 'VAT 13%', rate: '0.1300', type: 'VAT', inputAccountId: vatInAcc.id },
  });
  const sup = await prisma.party.create({ data: { organizationId: orgId, type: 'SUPPLIER', code: 'SUP-001', name: 'Kathmandu Stationers', creditDays: 30 } });
  return { fy, exp, apAcc, vatInAcc, cashAcc, bankAcc, tax, sup };
}

beforeAll(async () => {
  await resetDb();
  const roles = await seedRoles();

  owner = await makeUserWithOrg(app, 'owner@suppay.test', 'Supplier Payment Co');
  clerk = await addMember(roles, 'clerk@suppay.test', 'Clerk');
  viewer = await addMember(roles, 'viewer@suppay.test', 'Viewer');
  other = await makeUserWithOrg(app, 'other@suppay.test', 'Other Org Co');

  const a = await seedOrg(owner.orgId);
  ({ exp: expense, apAcc: ap, cashAcc: cash, bankAcc: bank, sup: supplier, tax: vat13 } = a);
  supplier2 = await prisma.party.create({ data: { organizationId: owner.orgId, type: 'BOTH', code: 'SUP-002', name: 'Both Ways Traders' } });
  customer = await prisma.party.create({ data: { organizationId: owner.orgId, type: 'CUSTOMER', code: 'CUS-001', name: 'A Customer' } });

  const b = await seedOrg(other.orgId);
  otherSupplier = b.sup;
  otherBank = b.bankAcc;
  otherBill = await prisma.document.create({
    data: {
      organizationId: other.orgId, fiscalYearId: b.fy.id, docType: 'BILL', docNo: 'BILL-2082-0001', docDate: new Date('2025-07-20'),
      postingDate: new Date('2025-07-20'), partyId: b.sup.id, referenceNo: 'THEIRS-1', status: 'POSTED',
      grandTotal: 1000, outstandingAmount: 1000,
    },
  });
});

afterAll(() => prisma.$disconnect());

let refSeq = 0;
// Creates and posts a Bill through the API; returns the posted Bill body.
async function postedBill({ unitPrice = 1000, quantity = 1, withVat = false, partyId } = {}) {
  refSeq += 1;
  const created = await request(app).post('/api/v1/bills').set(owner.headers).send({
    partyId: partyId ?? supplier.id,
    referenceNo: `SP-INV-${refSeq}`,
    docDate: '2025-07-20',
    lines: [{ accountId: expense.id, description: 'Goods', quantity, unitPrice, ...(withVat ? { taxCodeId: vat13.id } : {}) }],
  });
  expect(created.status).toBe(201);
  const posted = await request(app).post(`/api/v1/bills/${created.body.id}/post`).set(owner.headers).send();
  expect(posted.status).toBe(200);
  return posted.body.bill;
}

let keySeq = 0;
function pay(body, { headers = owner.headers, key = `spk-${Date.now()}-${(keySeq += 1)}` } = {}) {
  const req = request(app).post('/api/v1/supplier-payments').set(headers);
  return (key ? req.set('Idempotency-Key', key) : req).send({
    partyId: supplier.id, docDate: '2025-07-25', paidFromAccountId: bank.id, ...body,
  });
}
const reload = (id) => prisma.document.findUniqueOrThrow({ where: { id } });
const reverse = (id, headers = owner.headers) =>
  request(app).post(`/api/v1/journal-entries/${id}/reverse`).set(headers).send({ reason: 'wrong bank', reversalDate: '2025-07-26' });

describe('POST /supplier-payments', () => {
  it('posts Dr 2100 (against the Supplier) / Cr paid-from account and applies the payment across Bills, leaving the remainder unapplied', async () => {
    // Bill 1: 10 x 250 = 2,500.00 + VAT 325.00 = 2,825.00. Bill 2: 1,000.00, no VAT.
    const bill1 = await postedBill({ quantity: 10, unitPrice: 250, withVat: true });
    const bill2 = await postedBill();
    expect(bill1.outstandingAmount).toBe('2825.00');

    // Pays 2,825.00 (all of bill 1) + 100.00 (part of bill 2) = 2,925.00 of 3,000.00 -> 75.00 unapplied.
    const res = await pay({
      amount: '3000.00',
      allocations: [{ billId: bill1.id, amount: '2825.00' }, { billId: bill2.id, amount: '100.00' }],
    });

    expect(res.status).toBe(201);
    expect(res.body.supplierPayment).toMatchObject({
      docType: 'supplier_payment', status: 'posted', partyId: supplier.id,
      grandTotal: '3000.00', allocatedAmount: '2925.00', outstandingAmount: '75.00',
    });
    expect(res.body.supplierPayment.docNo).toMatch(/^SPAY-2082-\d{4}$/);
    expect(res.body.allocations).toEqual([
      { billId: bill1.id, amount: '2825.00', billOutstandingAfter: '0.00' },
      { billId: bill2.id, amount: '100.00', billOutstandingAfter: '900.00' },
    ]);

    const lines = res.body.journalEntry.lines.map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit, partyId: l.partyId }));
    expect(lines).toEqual([
      { accountId: ap.id, debit: '3000.00', credit: '0.00', partyId: supplier.id },
      { accountId: bank.id, debit: '0.00', credit: '3000.00', partyId: null },
    ]);
    expect(res.body.journalEntry).toMatchObject({ documentType: 'supplierPayment', entryDate: '2025-07-25', status: 'posted' });

    const [b1, b2] = [await reload(bill1.id), await reload(bill2.id)];
    expect([b1.status, b1.outstandingAmount.toFixed(2), b1.allocatedAmount.toFixed(2)]).toEqual(['PAID', '0.00', '2825.00']);
    expect([b2.status, b2.outstandingAmount.toFixed(2), b2.allocatedAmount.toFixed(2)]).toEqual(['PARTIALLY_PAID', '900.00', '100.00']);

    const stored = await reload(res.body.supplierPayment.id);
    expect(stored.journalEntryId).toBe(res.body.journalEntry.id);
    const allocs = await prisma.paymentAllocation.findMany({ where: { paymentDocumentId: stored.id } });
    expect(allocs.map((a) => a.targetDocumentId).sort()).toEqual([bill1.id, bill2.id].sort());
  });

  it('can pay from Cash in Hand (1010), looked up by code', async () => {
    const res = await pay({ amount: '40.00', paidFromAccountId: cash.id, allocations: [] });
    expect(res.status).toBe(201);
    expect(res.body.supplierPayment.outstandingAmount).toBe('40.00');
    expect(res.body.journalEntry.lines[1]).toMatchObject({ accountId: cash.id, credit: '40.00' });
  });

  it('accepts a BOTH party', async () => {
    const res = await pay({ partyId: supplier2.id, amount: '10.00', allocations: [] });
    expect(res.status).toBe(201);
  });

  it('writes a supplier_payment.posted audit event', async () => {
    const res = await pay({ amount: '5.00', allocations: [] });
    await expect.poll(async () => prisma.auditLog.count({
      where: { organizationId: owner.orgId, entityId: res.body.supplierPayment.id, action: 'supplier_payment.posted' },
    })).toBe(1);
  });
});

describe('validation rejections', () => {
  const counts = async () => [
    await prisma.document.count({ where: { organizationId: owner.orgId, docType: 'SUPPLIER_PAYMENT' } }),
    await prisma.paymentAllocation.count({ where: { organizationId: owner.orgId } }),
    await prisma.journalEntry.count({ where: { organizationId: owner.orgId } }),
  ];

  it('refuses a Customer-only party, writing nothing', async () => {
    const before = await counts();
    const res = await pay({ partyId: customer.id, amount: '10.00', allocations: [] });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('party_not_supplier');
    expect(await counts()).toEqual(before);
  });

  it('refuses any paid-from account that is neither bank-flagged nor Cash in Hand', async () => {
    const before = await counts();
    for (const accountId of [expense.id, ap.id]) {
      const res = await pay({ amount: '10.00', paidFromAccountId: accountId, allocations: [] });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('invalid_paid_from_account');
    }
    expect(await counts()).toEqual(before);
  });

  it("refuses allocating to another Supplier's Bill with party_mismatch, leaving the Bill untouched", async () => {
    const bill = await postedBill({ partyId: supplier2.id });
    const before = await counts();
    const res = await pay({ amount: '500.00', allocations: [{ billId: bill.id, amount: '500.00' }] });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('party_mismatch');
    expect(await counts()).toEqual(before);
    expect((await reload(bill.id)).outstandingAmount.toFixed(2)).toBe('1000.00');
  });

  it("refuses allocating more than a Bill's outstanding amount, and more in total than the payment", async () => {
    const bill = await postedBill(); // 1,000.00
    const over = await pay({ amount: '2000.00', allocations: [{ billId: bill.id, amount: '1000.01' }] });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('over_allocation');

    const bill2 = await postedBill();
    const overTotal = await pay({
      amount: '1500.00', allocations: [{ billId: bill.id, amount: '1000.00' }, { billId: bill2.id, amount: '500.01' }],
    });
    expect(overTotal.status).toBe(422);
    expect(overTotal.body.error.code).toBe('over_allocation');
    expect((await reload(bill.id)).outstandingAmount.toFixed(2)).toBe('1000.00');
    expect((await reload(bill2.id)).outstandingAmount.toFixed(2)).toBe('1000.00');
  });

  it('refuses a draft Bill, a non-Bill document and a repeated Bill in one payment', async () => {
    refSeq += 1;
    const draft = await request(app).post('/api/v1/bills').set(owner.headers).send({
      partyId: supplier.id, referenceNo: `SP-DRAFT-${refSeq}`, docDate: '2025-07-20',
      lines: [{ accountId: expense.id, description: 'x', quantity: 1, unitPrice: 100 }],
    });
    const notOpen = await pay({ amount: '100.00', allocations: [{ billId: draft.body.id, amount: '100.00' }] });
    expect(notOpen.status).toBe(422);
    expect(notOpen.body.error.code).toBe('bill_not_open');

    const earlier = await pay({ amount: '10.00', allocations: [] });
    const notBill = await pay({ amount: '10.00', allocations: [{ billId: earlier.body.supplierPayment.id, amount: '5.00' }] });
    expect(notBill.status).toBe(422);
    expect(notBill.body.error.code).toBe('not_a_bill');

    const bill = await postedBill();
    const dup = await pay({ amount: '900.00', allocations: [{ billId: bill.id, amount: '500.00' }, { billId: bill.id, amount: '500.00' }] });
    expect(dup.status).toBe(422);
    expect(dup.body.error.code).toBe('duplicate_allocation');
  });

  it('requires an Idempotency-Key', async () => {
    const res = await pay({ amount: '10.00', allocations: [] }, { key: null });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('idempotency_key_required');
  });
});

describe('permissions', () => {
  it('allows only supplier_payment.create: Clerk and Viewer get 403 and nothing is written', async () => {
    const before = await prisma.document.count({ where: { organizationId: owner.orgId, docType: 'SUPPLIER_PAYMENT' } });
    for (const headers of [clerk, viewer]) {
      const res = await pay({ amount: '10.00', allocations: [] }, { headers });
      expect(res.status).toBe(403);
    }
    expect(await prisma.document.count({ where: { organizationId: owner.orgId, docType: 'SUPPLIER_PAYMENT' } })).toBe(before);
  });

  it('lets a Viewer read a Supplier Payment', async () => {
    const created = await pay({ amount: '10.00', allocations: [] });
    const res = await request(app).get(`/api/v1/supplier-payments/${created.body.supplierPayment.id}`).set(viewer);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: created.body.supplierPayment.id, grandTotal: '10.00', outstandingAmount: '10.00', allocations: [] });
  });
});

describe('idempotency', () => {
  it('replays the original result for the same key and pays once', async () => {
    const bill = await postedBill();
    const body = { amount: '300.00', allocations: [{ billId: bill.id, amount: '300.00' }] };
    const first = await pay(body, { key: 'sp-replay-1' });
    const second = await pay(body, { key: 'sp-replay-1' });

    expect(first.status).toBe(201);
    expect(first.headers['idempotent-replay']).toBeUndefined();
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(await prisma.document.count({ where: { organizationId: owner.orgId, docNo: first.body.supplierPayment.docNo } })).toBe(1);
    expect((await reload(bill.id)).outstandingAmount.toFixed(2)).toBe('700.00');
  });

  it('rejects the same key with a different body', async () => {
    await pay({ amount: '20.00', allocations: [] }, { key: 'sp-reuse-1' });
    const res = await pay({ amount: '21.00', allocations: [] }, { key: 'sp-reuse-1' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('idempotency_key_reuse');
  });

  it('runs again, not a replay, when the first attempt with that key failed and rolled back', async () => {
    const bill = await postedBill();
    const body = { amount: '250.00', allocations: [{ billId: bill.id, amount: '250.00' }] };
    await prisma.accountingPeriod.updateMany({ where: { fiscalYear: { organizationId: owner.orgId } }, data: { isOpen: false } });
    const failed = await pay(body, { key: 'sp-retry-1' });
    await prisma.accountingPeriod.updateMany({ where: { fiscalYear: { organizationId: owner.orgId } }, data: { isOpen: true } });

    expect(failed.status).toBe(422);
    expect(failed.body.error.code).toBe('period_locked');
    expect((await reload(bill.id)).outstandingAmount.toFixed(2)).toBe('1000.00');

    const retry = await pay(body, { key: 'sp-retry-1' });
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replay']).toBeUndefined();
    expect((await reload(bill.id)).outstandingAmount.toFixed(2)).toBe('750.00');
  });
});

describe('reversing a Supplier Payment (shared journal-entry reversal path)', () => {
  it('un-applies its allocations: Bills regain outstanding amount and status, allocation rows go, payment is REVERSED', async () => {
    const billA = await postedBill(); // 1,000.00
    const billB = await postedBill({ unitPrice: 600 }); // 600.00
    const first = await pay({ amount: '400.00', allocations: [{ billId: billA.id, amount: '400.00' }] });
    const second = await pay({
      amount: '1200.00', allocations: [{ billId: billA.id, amount: '600.00' }, { billId: billB.id, amount: '600.00' }],
    });
    expect(second.status).toBe(201);
    expect((await reload(billA.id)).status).toBe('PAID');
    expect((await reload(billB.id)).status).toBe('PAID');

    const res = await reverse(second.body.journalEntry.id);

    expect(res.status).toBe(200);
    expect(res.body.original.status).toBe('reversed');
    const [a, b] = [await reload(billA.id), await reload(billB.id)];
    expect([a.status, a.outstandingAmount.toFixed(2), a.allocatedAmount.toFixed(2)]).toEqual(['PARTIALLY_PAID', '600.00', '400.00']);
    expect([b.status, b.outstandingAmount.toFixed(2), b.allocatedAmount.toFixed(2)]).toEqual(['POSTED', '600.00', '0.00']);
    expect(await prisma.paymentAllocation.count({ where: { paymentDocumentId: second.body.supplierPayment.id } })).toBe(0);
    const payment = await reload(second.body.supplierPayment.id);
    expect([payment.status, payment.outstandingAmount.toFixed(2)]).toEqual(['REVERSED', '0.00']);

    // The first payment is still applied.
    expect(await prisma.paymentAllocation.count({ where: { paymentDocumentId: first.body.supplierPayment.id } })).toBe(1);

    // Reversal entry swaps the lines: Dr bank / Cr 2100 for the Supplier.
    expect(res.body.reversal.lines.map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit }))).toEqual([
      { accountId: ap.id, debit: '0.00', credit: '1200.00' },
      { accountId: bank.id, debit: '1200.00', credit: '0.00' },
    ]);
  });

  it('lets the Bill be reversed once its Supplier Payment is reversed, and refuses it before', async () => {
    const bill = await postedBill();
    const payment = await pay({ amount: '100.00', allocations: [{ billId: bill.id, amount: '100.00' }] });
    const billEntry = (await reload(bill.id)).journalEntryId;

    const refused = await reverse(billEntry);
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('cannot_reverse_bill_with_payments');

    expect((await reverse(payment.body.journalEntry.id)).status).toBe(200);
    expect((await reverse(billEntry)).status).toBe(200);
    expect((await reload(bill.id)).status).toBe('REVERSED');
  });
});

describe('payments applied to a Bill', () => {
  it('lists the Supplier Payments applied, newest first, with the Bill outstanding amount', async () => {
    const bill = await postedBill(); // 1,000.00
    const p1 = await pay({ amount: '300.00', referenceNo: 'CHQ-1', allocations: [{ billId: bill.id, amount: '300.00' }] });
    const p2 = await pay({ amount: '200.00', allocations: [{ billId: bill.id, amount: '150.00' }] });

    const res = await request(app).get(`/api/v1/bills/${bill.id}/payments`).set(viewer);

    expect(res.status).toBe(200);
    expect(res.body.billId).toBe(bill.id);
    expect(res.body.outstandingAmount).toBe('550.00');
    expect(res.body.payments.map((p) => [p.supplierPaymentNo, p.amount, p.referenceNo])).toEqual([
      [p2.body.supplierPayment.docNo, '150.00', null],
      [p1.body.supplierPayment.docNo, '300.00', 'CHQ-1'],
    ]);
    expect(res.body.payments[0]).toMatchObject({ supplierPaymentId: p2.body.supplierPayment.id, docDate: '2025-07-25' });
  });

  it("404s on another organization's Bill", async () => {
    const res = await request(app).get(`/api/v1/bills/${otherBill.id}/payments`).set(owner.headers);
    expect(res.status).toBe(404);
  });
});

describe('tenant isolation on write paths (org A user sending org B ids)', () => {
  const snapshot = async () => JSON.stringify({
    bill: await prisma.document.findUniqueOrThrow({ where: { id: otherBill.id } }),
    docs: await prisma.document.count({ where: { organizationId: other.orgId } }),
    allocs: await prisma.paymentAllocation.count({ where: { organizationId: other.orgId } }),
    entries: await prisma.journalEntry.count({ where: { organizationId: other.orgId } }),
    series: await prisma.documentSeries.count({ where: { organizationId: other.orgId } }),
  });

  it("a payment for org B's Supplier is 404", async () => {
    const before = await snapshot();
    const res = await pay({ partyId: otherSupplier.id, amount: '10.00', allocations: [] });
    expect(res.status).toBe(404);
    expect(await snapshot()).toBe(before);
  });

  it("allocating to org B's Bill is rejected and org B's Bill outstanding amount is unchanged", async () => {
    const before = await snapshot();
    const res = await pay({ amount: '500.00', allocations: [{ billId: otherBill.id, amount: '500.00' }] });
    expect(res.status).toBe(404);
    expect(await snapshot()).toBe(before);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: otherBill.id } })).outstandingAmount.toFixed(2)).toBe('1000.00');
  });

  it("paying from org B's bank account is rejected", async () => {
    const before = await snapshot();
    const res = await pay({ amount: '10.00', paidFromAccountId: otherBank.id, allocations: [] });
    expect(res.status).toBe(404);
    expect(await snapshot()).toBe(before);
  });

  it("404s reading org B's payment", async () => {
    const theirs = await prisma.document.create({
      data: {
        organizationId: other.orgId, fiscalYearId: otherBill.fiscalYearId, docType: 'SUPPLIER_PAYMENT', docDate: new Date('2025-07-21'),
        postingDate: new Date('2025-07-21'), partyId: otherSupplier.id, status: 'POSTED', grandTotal: 5, outstandingAmount: 5,
      },
    });
    const res = await request(app).get(`/api/v1/supplier-payments/${theirs.id}`).set(owner.headers);
    expect(res.status).toBe(404);
  });
});

describe('concurrency', () => {
  it('two payments allocating to the same two Bills in opposite order complete without deadlock and leave consistent outstanding amounts', async () => {
    const [billA, billB] = (await Promise.all([postedBill({ unitPrice: 1000000 }), postedBill({ unitPrice: 1000000 })]))
      .sort((x, y) => (x.id < y.id ? -1 : 1));
    const ROUNDS = 6;
    const PAIRS = 4;
    const body = (bills) => ({ amount: '20.00', allocations: bills.map((b) => ({ billId: b.id, amount: '10.00' })) });

    for (let round = 0; round < ROUNDS; round += 1) {
      const results = await Promise.all([
        ...Array.from({ length: PAIRS }, () => pay(body([billA, billB]))),
        ...Array.from({ length: PAIRS }, () => pay(body([billB, billA]))),
      ]);
      expect(results.map((r) => r.status)).toEqual(Array(PAIRS * 2).fill(201));
    }

    // 6 rounds x 8 payments x 10.00 against each Bill.
    for (const bill of [billA, billB]) {
      const fresh = await reload(bill.id);
      expect(fresh.allocatedAmount.toFixed(2)).toBe('480.00');
      expect(fresh.outstandingAmount.toFixed(2)).toBe('999520.00');
      const allocs = await prisma.paymentAllocation.findMany({ where: { targetDocumentId: bill.id } });
      expect(allocs).toHaveLength(ROUNDS * PAIRS * 2);
    }
  }, 60000);

  it('reversing a payment while another payment allocates to the same Bills in opposite order never deadlocks', async () => {
    const [billA, billB] = (await Promise.all([postedBill({ unitPrice: 1000000 }), postedBill({ unitPrice: 1000000 })]))
      .sort((x, y) => (x.id < y.id ? -1 : 1));
    const body = (bills) => ({ amount: '20.00', allocations: bills.map((b) => ({ billId: b.id, amount: '10.00' })) });
    const toReverse = [];
    for (let i = 0; i < 4; i += 1) toReverse.push(await pay(body([billB, billA])));

    const results = await Promise.all([
      ...toReverse.map((p) => reverse(p.body.journalEntry.id)),
      ...toReverse.map(() => pay(body([billA, billB]))),
    ]);
    expect(results.map((r) => r.status)).toEqual(Array(8).fill(200).fill(201, 4));
    for (const bill of [billA, billB]) {
      const fresh = await reload(bill.id);
      expect(fresh.allocatedAmount.toFixed(2)).toBe('40.00');
      expect(fresh.outstandingAmount.toFixed(2)).toBe('999960.00');
    }
  }, 60000);
});

describe('bank reconciliation (matching engine unchanged)', () => {
  it('offers a Supplier Payment from a bank account as the match for the statement debit', async () => {
    const fy = await prisma.fiscalYear.findFirstOrThrow({ where: { organizationId: owner.orgId } });
    await prisma.accountingPeriod.create({
      data: { fiscalYearId: fy.id, label: 'Poush', startDate: new Date('2026-01-01'), endDate: new Date('2026-01-31'), isOpen: true },
    });
    const glAccount = await prisma.account.create({
      data: { organizationId: owner.orgId, code: '1099', name: 'Bank - Reconciled', type: 'ASSET', isBankAccount: true },
    });
    const bankAccount = await request(app).post('/api/v1/bank-accounts').set(owner.headers).send({
      accountId: glAccount.id, bankName: 'Recon Bank', accountNoMasked: '****9999',
    });
    expect(bankAccount.status).toBe(201);

    const payment = await pay({ amount: '4321.00', docDate: '2026-01-10', paidFromAccountId: glAccount.id, allocations: [] });
    expect(payment.status).toBe(201);

    const columnMapping = {
      dateFormat: 'YYYY-MM-DD',
      columns: { date: 'Date', description: 'Description', reference: 'Reference', debit: 'Debit', credit: 'Credit', balance: 'Balance' },
    };
    const csv = ['Date,Description,Reference,Debit,Credit,Balance',
      `2026-01-10,NEFT ${payment.body.supplierPayment.docNo},,4321.00,,-4321.00`].join('\n');
    const imported = await request(app)
      .post(`/api/v1/bank-accounts/${bankAccount.body.id}/statements`)
      .set(owner.headers)
      .field('columnMapping', JSON.stringify(columnMapping))
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'supplier-payment.csv', contentType: 'text/csv' });

    expect(imported.status).toBe(200);
    expect(imported.body).toMatchObject({ imported: 1, autoMatched: 1, unmatched: 0 });
    const line = await prisma.bankStatementLine.findFirstOrThrow({ where: { statementId: imported.body.statement.id } });
    const matched = await prisma.journalLine.findUniqueOrThrow({ where: { id: line.matchedJournalLineId } });
    expect(matched.accountId).toBe(glAccount.id);
    expect(matched.credit.toFixed(2)).toBe('4321.00');
    expect(matched.journalEntryId).toBe(payment.body.journalEntry.id);
  });
});
