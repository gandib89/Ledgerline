import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { prisma } from '../db/client.js';
import { resetDb, seedRoles, makeUserWithOrg } from '../test/helpers.js';

// Applying an Unapplied Amount later is a sub-ledger operation: the payment's
// journal entry already put the whole amount on the Control Account, so these
// tests also pin that no new journal entry appears.

let owner, clerk, viewer, other;
let accounts, otherAccounts;
const parties = {};
const otherParties = {};

async function addMember(roles, email, roleName) {
  await request(app).post('/api/v1/auth/register').send({ email, password: 'password123' });
  await request(app).post(`/api/v1/orgs/${owner.orgId}/members`).set(owner.headers).send({ email, roleId: roles[roleName].id });
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
  return {
    fy,
    ar: await acc('1100', 'Accounts Receivable', 'ASSET', { isControlAccount: true }),
    ap: await acc('2100', 'Accounts Payable', 'LIABILITY', { isControlAccount: true }),
    bank: await acc('1020', 'Bank - Nabil', 'ASSET', { isBankAccount: true }),
    sales: await acc('4100', 'Sales Revenue', 'REVENUE'),
    expense: await acc('5100', 'Office Supplies', 'EXPENSE'),
  };
}

const mkParty = (orgId, type, code, name) => prisma.party.create({ data: { organizationId: orgId, type, code, name } });

beforeAll(async () => {
  await resetDb();
  const roles = await seedRoles();
  owner = await makeUserWithOrg(app, 'owner@apply.test', 'Apply Co');
  clerk = await addMember(roles, 'clerk@apply.test', 'Clerk');
  viewer = await addMember(roles, 'viewer@apply.test', 'Viewer');
  other = await makeUserWithOrg(app, 'other@apply.test', 'Other Apply Co');

  accounts = await seedOrg(owner.orgId);
  otherAccounts = await seedOrg(other.orgId);
  parties.receipt = await mkParty(owner.orgId, 'CUSTOMER', 'CUS-001', 'Himalayan Trek Supplies');
  parties.receiptOther = await mkParty(owner.orgId, 'CUSTOMER', 'CUS-002', 'Another Customer');
  parties.supplierPayment = await mkParty(owner.orgId, 'SUPPLIER', 'SUP-001', 'Kathmandu Stationers');
  parties.supplierPaymentOther = await mkParty(owner.orgId, 'SUPPLIER', 'SUP-002', 'Another Supplier');
  otherParties.receipt = await mkParty(other.orgId, 'CUSTOMER', 'CUS-001', 'Their Customer');
  otherParties.supplierPayment = await mkParty(other.orgId, 'SUPPLIER', 'SUP-001', 'Their Supplier');
});

afterAll(() => prisma.$disconnect());

let seq = 0;
const nextSeq = () => (seq += 1);

// One adapter per payment kind keeps every rule below tested for both.
const KINDS = [
  {
    name: 'Receipt', path: 'receipts', idField: 'invoiceId', targetType: 'INVOICE', paymentType: 'RECEIPT',
    auditAction: 'receipt.allocated', responseKey: 'receipt', targetOutstandingKey: 'invoiceOutstandingAfter',
    entryType: 'receipt', clerkAllowed: true,
    async postTarget({ amount = 1000, partyId = parties.receipt.id, post = true } = {}) {
      const created = await request(app).post('/api/v1/invoices').set(owner.headers).send({
        partyId, docDate: '2025-07-20',
        lines: [{ accountId: accounts.sales.id, description: 'Goods', quantity: 1, unitPrice: amount }],
      });
      expect(created.status).toBe(201);
      if (post) expect((await request(app).post(`/api/v1/invoices/${created.body.id}/post`).set(owner.headers).send()).status).toBe(200);
      return created.body.id;
    },
    async postPayment({ amount, allocations = [], partyId = parties.receipt.id }) {
      const res = await request(app).post('/api/v1/receipts').set(owner.headers).set('Idempotency-Key', `rc-${nextSeq()}`).send({
        partyId, docDate: '2025-07-25', depositAccountId: accounts.bank.id, amount,
        allocations: allocations.map((a) => ({ invoiceId: a.targetId, amount: a.amount })),
      });
      expect(res.status).toBe(201);
      return { id: res.body.receipt.id, entryId: res.body.journalEntry.id };
    },
    mkOtherOrgTarget: (orgId, fiscalYearId, partyId) => prisma.document.create({
      data: { organizationId: orgId, fiscalYearId, docType: 'INVOICE', docNo: `X-INV-${nextSeq()}`, docDate: new Date('2025-07-20'), postingDate: new Date('2025-07-20'), partyId, status: 'POSTED', grandTotal: 500, outstandingAmount: 500 },
    }),
  },
  {
    name: 'Supplier Payment', path: 'supplier-payments', idField: 'billId', targetType: 'BILL', paymentType: 'SUPPLIER_PAYMENT',
    auditAction: 'supplier_payment.allocated', responseKey: 'supplierPayment', targetOutstandingKey: 'billOutstandingAfter',
    entryType: 'supplierPayment', clerkAllowed: false,
    async postTarget({ amount = 1000, partyId = parties.supplierPayment.id, post = true } = {}) {
      const created = await request(app).post('/api/v1/bills').set(owner.headers).send({
        partyId, referenceNo: `AP-REF-${nextSeq()}`, docDate: '2025-07-20',
        lines: [{ accountId: accounts.expense.id, description: 'Goods', quantity: 1, unitPrice: amount }],
      });
      expect(created.status).toBe(201);
      if (post) expect((await request(app).post(`/api/v1/bills/${created.body.id}/post`).set(owner.headers).send()).status).toBe(200);
      return created.body.id;
    },
    async postPayment({ amount, allocations = [], partyId = parties.supplierPayment.id }) {
      const res = await request(app).post('/api/v1/supplier-payments').set(owner.headers).set('Idempotency-Key', `sp-${nextSeq()}`).send({
        partyId, docDate: '2025-07-25', paidFromAccountId: accounts.bank.id, amount,
        allocations: allocations.map((a) => ({ billId: a.targetId, amount: a.amount })),
      });
      expect(res.status).toBe(201);
      return { id: res.body.supplierPayment.id, entryId: res.body.journalEntry.id };
    },
    mkOtherOrgTarget: (orgId, fiscalYearId, partyId) => prisma.document.create({
      data: { organizationId: orgId, fiscalYearId, docType: 'BILL', docNo: `X-BILL-${nextSeq()}`, referenceNo: `X-${nextSeq()}`, docDate: new Date('2025-07-20'), postingDate: new Date('2025-07-20'), partyId, status: 'POSTED', grandTotal: 500, outstandingAmount: 500 },
    }),
  },
];

const reload = (id) => prisma.document.findUniqueOrThrow({ where: { id } });
const reverse = (entryId) =>
  request(app).post(`/api/v1/journal-entries/${entryId}/reverse`).set(owner.headers).send({ reason: 'mistake', reversalDate: '2025-07-26' });
const snapshot = async (ids) => (await Promise.all(ids.map(reload))).map((d) => [d.status, d.outstandingAmount.toFixed(2), d.allocatedAmount.toFixed(2)]);

describe.each(KINDS)('POST allocations on a $name', (K) => {
  let keySeq = 0;
  const apply = (paymentId, allocations, { headers = owner.headers, key = `apply-${K.path}-${Date.now()}-${(keySeq += 1)}` } = {}) => {
    const req = request(app).post(`/api/v1/${K.path}/${paymentId}/allocations`).set(headers);
    return (key ? req.set('Idempotency-Key', key) : req).send({ allocations: allocations.map((a) => ({ [K.idField]: a.targetId, amount: a.amount })) });
  };
  const writes = async () => [
    await prisma.paymentAllocation.count({ where: { organizationId: owner.orgId } }),
    await prisma.journalEntry.count({ where: { organizationId: owner.orgId } }),
    await prisma.auditLog.count({ where: { organizationId: owner.orgId, action: K.auditAction } }),
  ];

  describe('applying', () => {
    it('allocates part of the Unapplied Amount to open documents, with no new journal entry', async () => {
      const t1 = await K.postTarget({ amount: 1000 });
      const t2 = await K.postTarget({ amount: 600 });
      const payment = await K.postPayment({ amount: '1500.00', allocations: [{ targetId: t1, amount: '200.00' }] }); // 1,300 unapplied
      const entriesBefore = await prisma.journalEntry.count({ where: { organizationId: owner.orgId } });

      const res = await apply(payment.id, [{ targetId: t1, amount: '300.00' }, { targetId: t2, amount: '600.00' }]);

      expect(res.status).toBe(201);
      expect(res.body[K.responseKey]).toMatchObject({
        id: payment.id, status: 'posted', grandTotal: '1500.00', allocatedAmount: '1100.00', outstandingAmount: '400.00',
      });
      expect(res.body.allocations).toEqual([
        { [K.idField]: t1, amount: '300.00', [K.targetOutstandingKey]: '500.00' },
        { [K.idField]: t2, amount: '600.00', [K.targetOutstandingKey]: '0.00' },
      ]);
      expect(await snapshot([t1, t2])).toEqual([['PARTIALLY_PAID', '500.00', '500.00'], ['PAID', '0.00', '600.00']]);
      expect(await prisma.journalEntry.count({ where: { organizationId: owner.orgId } })).toBe(entriesBefore);
      const stored = await reload(payment.id);
      expect([stored.status, stored.allocatedAmount.toFixed(2), stored.outstandingAmount.toFixed(2)]).toEqual(['POSTED', '1100.00', '400.00']);
    });

    it('can apply the whole remainder, leaving nothing unapplied', async () => {
      const t = await K.postTarget({ amount: 800 });
      const payment = await K.postPayment({ amount: '800.00' });
      const res = await apply(payment.id, [{ targetId: t, amount: '800.00' }]);
      expect(res.status).toBe(201);
      expect(res.body[K.responseKey].outstandingAmount).toBe('0.00');
      expect((await reload(t)).status).toBe('PAID');
    });

    it('adds to the existing allocation when the payment already covers that document', async () => {
      const t = await K.postTarget({ amount: 1000 });
      const payment = await K.postPayment({ amount: '900.00', allocations: [{ targetId: t, amount: '100.00' }] });

      const res = await apply(payment.id, [{ targetId: t, amount: '250.00' }]);

      expect(res.status).toBe(201);
      expect(res.body.allocations).toEqual([{ [K.idField]: t, amount: '250.00', [K.targetOutstandingKey]: '650.00' }]);
      const rows = await prisma.paymentAllocation.findMany({ where: { paymentDocumentId: payment.id } });
      expect(rows.map((r) => r.amount.toFixed(2))).toEqual(['350.00']);
      const detail = await request(app).get(`/api/v1/${K.path}/${payment.id}`).set(owner.headers);
      expect(detail.body.allocations.map((a) => [a[K.idField], a.amount])).toEqual([[t, '350.00']]);
    });
  });

  describe('rules identical to creation (422, nothing written)', () => {
    it('refuses a reversed payment', async () => {
      const t = await K.postTarget();
      const payment = await K.postPayment({ amount: '500.00' });
      expect((await reverse(payment.entryId)).status).toBe(200);
      const before = await writes();
      const res = await apply(payment.id, [{ targetId: t, amount: '100.00' }]);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('payment_not_posted');
      expect(await writes()).toEqual(before);
    });

    it('refuses a draft or already-paid target', async () => {
      const draft = await K.postTarget({ post: false });
      const paid = await K.postTarget({ amount: 100 });
      await K.postPayment({ amount: '100.00', allocations: [{ targetId: paid, amount: '100.00' }] });
      const payment = await K.postPayment({ amount: '500.00' });
      const before = await writes();

      const d = await apply(payment.id, [{ targetId: draft, amount: '10.00' }]);
      const p = await apply(payment.id, [{ targetId: paid, amount: '10.00' }]);

      expect([d.status, p.status]).toEqual([422, 422]);
      expect([d.body.error.code, p.body.error.code]).toEqual([K.targetType === 'INVOICE' ? 'invoice_not_open' : 'bill_not_open', K.targetType === 'INVOICE' ? 'invoice_not_open' : 'bill_not_open']);
      expect(await writes()).toEqual(before);
    });

    it("refuses another party's document", async () => {
      const otherPartyId = K.targetType === 'INVOICE' ? parties.receiptOther.id : parties.supplierPaymentOther.id;
      const t = await K.postTarget({ partyId: otherPartyId });
      const payment = await K.postPayment({ amount: '500.00' });
      const res = await apply(payment.id, [{ targetId: t, amount: '10.00' }]);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('party_mismatch');
      expect((await reload(t)).outstandingAmount.toFixed(2)).toBe('1000.00');
    });

    it('refuses a document of the wrong type (a payment is not a target)', async () => {
      const payment = await K.postPayment({ amount: '500.00' });
      const res = await apply(payment.id, [{ targetId: (await K.postPayment({ amount: '10.00' })).id, amount: '5.00' }]);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(K.targetType === 'INVOICE' ? 'not_an_invoice' : 'not_a_bill');
    });

    it("refuses more than a document's outstanding amount and more than the Unapplied Amount, and a repeated document", async () => {
      const t1 = await K.postTarget({ amount: 100 });
      const t2 = await K.postTarget({ amount: 1000 });
      const payment = await K.postPayment({ amount: '300.00', allocations: [{ targetId: t2, amount: '50.00' }] }); // 250 unapplied
      const before = await writes();

      const overTarget = await apply(payment.id, [{ targetId: t1, amount: '100.01' }]);
      const overPayment = await apply(payment.id, [{ targetId: t1, amount: '100.00' }, { targetId: t2, amount: '150.01' }]);
      const duplicate = await apply(payment.id, [{ targetId: t2, amount: '10.00' }, { targetId: t2, amount: '10.00' }]);

      expect([overTarget.status, overPayment.status, duplicate.status]).toEqual([422, 422, 422]);
      expect([overTarget.body.error.code, overPayment.body.error.code, duplicate.body.error.code]).toEqual(['over_allocation', 'over_allocation', 'duplicate_allocation']);
      expect(await writes()).toEqual(before);
      expect(await snapshot([t1, t2])).toEqual([['POSTED', '100.00', '0.00'], ['PARTIALLY_PAID', '950.00', '50.00']]);
    });

    it('accepts decimal-string and numeric amounts and rejects zero, negatives, extra decimals, an empty list and bad ids (400)', async () => {
      const t = await K.postTarget({ amount: 1000 });
      const payment = await K.postPayment({ amount: '500.00' });
      for (const amount of ['0', '0.00', '-5.00', '1.005', '1e2', '', 'abc', null]) {
        expect((await apply(payment.id, [{ targetId: t, amount }])).status).toBe(400);
      }
      expect((await apply(payment.id, [])).status).toBe(400);
      expect((await apply(payment.id, [{ targetId: 'not-a-uuid', amount: '5.00' }])).status).toBe(400);
      expect((await apply('not-a-uuid', [{ targetId: t, amount: '5.00' }])).status).toBe(400);
      expect((await apply(payment.id, [{ targetId: t, amount: 10 }])).status).toBe(201);
      expect((await apply(payment.id, [{ targetId: t, amount: '10.50' }])).status).toBe(201);
      expect((await reload(t)).outstandingAmount.toFixed(2)).toBe('979.50');
    });

    it('requires an Idempotency-Key', async () => {
      const t = await K.postTarget();
      const payment = await K.postPayment({ amount: '500.00' });
      const res = await apply(payment.id, [{ targetId: t, amount: '10.00' }], { key: null });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('idempotency_key_required');
      expect((await reload(t)).outstandingAmount.toFixed(2)).toBe('1000.00');
    });
  });

  describe('permissions, audit, idempotency', () => {
    it('is gated by the create permission of its side: a Viewer gets 403, nothing written', async () => {
      const t = await K.postTarget();
      const payment = await K.postPayment({ amount: '500.00' });
      const before = await writes();
      const res = await apply(payment.id, [{ targetId: t, amount: '10.00' }], { headers: viewer });
      expect(res.status).toBe(403);
      expect(await writes()).toEqual(before);

      // Clerk holds payment.create but not supplier_payment.create.
      const asClerk = await apply(payment.id, [{ targetId: t, amount: '10.00' }], { headers: clerk });
      expect(asClerk.status).toBe(K.clerkAllowed ? 201 : 403);
    });

    it('writes one audit event naming the allocations', async () => {
      const t = await K.postTarget();
      const payment = await K.postPayment({ amount: '500.00' });
      await apply(payment.id, [{ targetId: t, amount: '10.00' }]);
      await expect.poll(async () => prisma.auditLog.count({
        where: { organizationId: owner.orgId, entityId: payment.id, action: K.auditAction },
      })).toBe(1);
      const event = await prisma.auditLog.findFirstOrThrow({ where: { entityId: payment.id, action: K.auditAction } });
      expect(JSON.stringify(event.after)).toContain(t);
    });

    it('replays the original result for the same key and applies once; rejects the key with a different body', async () => {
      const t = await K.postTarget();
      const payment = await K.postPayment({ amount: '500.00' });
      const key = `replay-${K.path}-${Date.now()}`;
      const first = await apply(payment.id, [{ targetId: t, amount: '100.00' }], { key });
      const second = await apply(payment.id, [{ targetId: t, amount: '100.00' }], { key });
      expect(second.status).toBe(first.status);
      expect(second.headers['idempotent-replay']).toBe('true');
      expect(second.body).toEqual(first.body);
      expect((await reload(t)).outstandingAmount.toFixed(2)).toBe('900.00');

      const different = await apply(payment.id, [{ targetId: t, amount: '200.00' }], { key });
      expect(different.status).toBe(422);
      expect(different.body.error.code).toBe('idempotency_key_reuse');

      // Same key and body against a different payment is a different request.
      const otherPayment = await K.postPayment({ amount: '500.00' });
      const elsewhere = await apply(otherPayment.id, [{ targetId: t, amount: '100.00' }], { key });
      expect(elsewhere.status).toBe(422);
      expect(elsewhere.body.error.code).toBe('idempotency_key_reuse');
    });
  });

  describe('tenant isolation (org A user sending org B ids)', () => {
    it("404s on org B's payment, and on org B's document, writing nothing", async () => {
      const mine = await K.postTarget();
      const payment = await K.postPayment({ amount: '500.00' });
      const theirTarget = await K.mkOtherOrgTarget(other.orgId, otherAccounts.fy.id, K.targetType === 'INVOICE' ? otherParties.receipt.id : otherParties.supplierPayment.id);
      const theirPayment = await prisma.document.create({
        data: {
          organizationId: other.orgId, fiscalYearId: otherAccounts.fy.id, docType: K.paymentType, docNo: `X-PAY-${nextSeq()}`,
          docDate: new Date('2025-07-20'), postingDate: new Date('2025-07-20'),
          partyId: K.targetType === 'INVOICE' ? otherParties.receipt.id : otherParties.supplierPayment.id,
          status: 'POSTED', grandTotal: 500, outstandingAmount: 500,
        },
      });
      const before = await writes();

      const asTheirPayment = await apply(theirPayment.id, [{ targetId: mine, amount: '10.00' }]);
      const asTheirTarget = await apply(payment.id, [{ targetId: theirTarget.id, amount: '10.00' }]);
      const mixed = await apply(payment.id, [{ targetId: mine, amount: '10.00' }, { targetId: theirTarget.id, amount: '10.00' }]);

      expect([asTheirPayment.status, asTheirTarget.status, mixed.status]).toEqual([404, 404, 404]);
      expect(await writes()).toEqual(before);
      expect((await reload(theirTarget.id)).outstandingAmount.toFixed(2)).toBe('500.00');
      expect((await reload(mine)).outstandingAmount.toFixed(2)).toBe('1000.00');
      expect((await reload(theirPayment.id)).outstandingAmount.toFixed(2)).toBe('500.00');
    });

    it('404s on an unknown payment id', async () => {
      const t = await K.postTarget();
      const res = await apply('5d0c0f7e-6b0e-4b6f-8a53-1d0f5f0c9a11', [{ targetId: t, amount: '10.00' }]);
      expect(res.status).toBe(404);
    });
  });

  describe('reversal', () => {
    it('un-applies a later-applied allocation too, restoring the document outstanding amount and status', async () => {
      const t1 = await K.postTarget({ amount: 1000 });
      const t2 = await K.postTarget({ amount: 400 });
      const payment = await K.postPayment({ amount: '1000.00', allocations: [{ targetId: t1, amount: '100.00' }] });
      expect((await apply(payment.id, [{ targetId: t1, amount: '200.00' }, { targetId: t2, amount: '400.00' }])).status).toBe(201);
      expect(await snapshot([t1, t2])).toEqual([['PARTIALLY_PAID', '700.00', '300.00'], ['PAID', '0.00', '400.00']]);

      const res = await reverse(payment.entryId);

      expect(res.status).toBe(200);
      expect(await snapshot([t1, t2])).toEqual([['POSTED', '1000.00', '0.00'], ['POSTED', '400.00', '0.00']]);
      expect(await prisma.paymentAllocation.count({ where: { paymentDocumentId: payment.id } })).toBe(0);
      const stored = await reload(payment.id);
      expect([stored.status, stored.outstandingAmount.toFixed(2)]).toEqual(['REVERSED', '0.00']);
    });
  });

  describe('concurrency', () => {
    it('competing applies for the same Unapplied Amount never over-allocate or deadlock', async () => {
      const ROUNDS = 5;
      for (let round = 0; round < ROUNDS; round += 1) {
        const [t1, t2] = await Promise.all([K.postTarget({ amount: 1000 }), K.postTarget({ amount: 1000 })]);
        const payment = await K.postPayment({ amount: '100.00' });
        const results = await Promise.all([
          apply(payment.id, [{ targetId: t1, amount: '70.00' }, { targetId: t2, amount: '10.00' }]),
          apply(payment.id, [{ targetId: t2, amount: '70.00' }, { targetId: t1, amount: '10.00' }]),
          apply(payment.id, [{ targetId: t1, amount: '50.00' }]),
          apply(payment.id, [{ targetId: t2, amount: '50.00' }]),
        ]);
        const statuses = results.map((r) => r.status);
        expect(statuses.every((s) => s === 201 || s === 422)).toBe(true);
        expect(statuses).toContain(201);

        const stored = await reload(payment.id);
        const rows = await prisma.paymentAllocation.findMany({ where: { paymentDocumentId: payment.id } });
        const total = rows.reduce((s, r) => s + Number(r.amount), 0);
        expect(total).toBeLessThanOrEqual(100);
        expect(stored.allocatedAmount.toFixed(2)).toBe(total.toFixed(2));
        expect(stored.outstandingAmount.toFixed(2)).toBe((100 - total).toFixed(2));
        const targets = await Promise.all([t1, t2].map(reload));
        for (const t of targets) {
          const mine = rows.filter((r) => r.targetDocumentId === t.id).reduce((s, r) => s + Number(r.amount), 0);
          expect(t.allocatedAmount.toFixed(2)).toBe(mine.toFixed(2));
          expect(t.outstandingAmount.toFixed(2)).toBe((1000 - mine).toFixed(2));
        }
      }
    }, 60000);

    it('applying while the same payment is reversed never deadlocks, even when the target id sorts before the payment id', async () => {
      for (let round = 0; round < 6; round += 1) {
        // Lowest possible id: sorts before any random payment id.
        const id = `00000000-0000-4000-8000-${String(nextSeq()).padStart(12, '0')}`;
        const partyId = K.targetType === 'INVOICE' ? parties.receipt.id : parties.supplierPayment.id;
        await prisma.document.create({
          data: {
            id, organizationId: owner.orgId, fiscalYearId: accounts.fy.id, docType: K.targetType, docNo: `LOW-${id.slice(-6)}`,
            ...(K.targetType === 'BILL' ? { referenceNo: `LOW-${id.slice(-6)}` } : {}),
            docDate: new Date('2025-07-20'), postingDate: new Date('2025-07-20'), partyId,
            status: 'POSTED', grandTotal: 1000, outstandingAmount: 1000,
          },
        });
        const payment = await K.postPayment({ amount: '500.00' });
        const results = await Promise.all([
          reverse(payment.entryId),
          apply(payment.id, [{ targetId: id, amount: '100.00' }]),
          apply(payment.id, [{ targetId: id, amount: '100.00' }]),
        ]);
        expect(results[0].status).toBe(200);
        expect(results.slice(1).every((r) => r.status === 201 || r.status === 422)).toBe(true);
        // Whatever the interleaving, the reversal leaves nothing applied.
        const target = await reload(id);
        expect([target.status, target.outstandingAmount.toFixed(2), target.allocatedAmount.toFixed(2)]).toEqual(['POSTED', '1000.00', '0.00']);
        expect(await prisma.paymentAllocation.count({ where: { paymentDocumentId: payment.id } })).toBe(0);
      }
    }, 60000);
  });
});
