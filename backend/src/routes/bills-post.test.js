import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { prisma } from '../db/client.js';
import { resetDb, seedRoles, makeUserWithOrg } from '../test/helpers.js';

let owner, clerk, viewer, other;
let expense, asset, ap, vatIn, supplier, vat13, fy82, fy83;
let otherSupplier, otherExpense;

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
  const fyNext = await prisma.fiscalYear.create({
    data: { organizationId: orgId, label: '2083/84', startDate: new Date('2026-07-16'), endDate: new Date('2027-07-15') },
  });
  const period = (fiscalYearId, label, start, end) =>
    prisma.accountingPeriod.create({ data: { fiscalYearId, label, startDate: new Date(start), endDate: new Date(end), isOpen: true } });
  await period(fy.id, 'Shrawan', '2025-07-16', '2025-08-15');
  await period(fy.id, 'Bhadra', '2025-08-16', '2025-09-15');
  await period(fy.id, 'Ashad', '2026-06-16', '2026-07-15');
  await period(fyNext.id, 'Shrawan', '2026-07-16', '2026-08-15');
  const acc = (code, name, type, extra = {}) =>
    prisma.account.create({ data: { organizationId: orgId, code, name, type, ...extra } });
  const exp = await acc('5100', 'Office Supplies', 'EXPENSE');
  const ast = await acc('1500', 'Equipment', 'ASSET');
  const apAcc = await acc('2100', 'Accounts Payable', 'LIABILITY', { isControlAccount: true });
  const vatInAcc = await acc('2210', 'VAT Receivable (Input)', 'ASSET', { isControlAccount: true });
  const tax = await prisma.taxCode.create({
    data: { organizationId: orgId, code: 'VAT13', name: 'VAT 13%', rate: '0.1300', type: 'VAT', inputAccountId: vatInAcc.id },
  });
  const sup = await prisma.party.create({
    data: { organizationId: orgId, type: 'SUPPLIER', code: 'SUP-001', name: 'Kathmandu Stationers', creditDays: 30 },
  });
  return { fy, fyNext, exp, ast, apAcc, vatInAcc, tax, sup };
}

beforeAll(async () => {
  await resetDb();
  const roles = await seedRoles();

  owner = await makeUserWithOrg(app, 'owner@billpost.test', 'Bill Post Test Co');
  clerk = await addMember(roles, 'clerk@billpost.test', 'Clerk');
  viewer = await addMember(roles, 'viewer@billpost.test', 'Viewer');
  other = await makeUserWithOrg(app, 'other@billpost.test', 'Other Org Co');

  const a = await seedOrg(owner.orgId);
  ({ expense, asset, ap, vatIn, supplier, vat13 } = { expense: a.exp, asset: a.ast, ap: a.apAcc, vatIn: a.vatInAcc, supplier: a.sup, vat13: a.tax });
  fy82 = a.fy;
  fy83 = a.fyNext;

  const b = await seedOrg(other.orgId);
  otherSupplier = b.sup;
  otherExpense = b.exp;
});

afterAll(() => prisma.$disconnect());

let refSeq = 0;
function billBody(overrides = {}) {
  refSeq += 1;
  return {
    partyId: supplier.id,
    referenceNo: `SUP-INV-${refSeq}`,
    docDate: '2025-07-20',
    lines: [{ accountId: expense.id, description: 'Printer paper', quantity: 10, unitPrice: 250, taxCodeId: vat13.id }],
    ...overrides,
  };
}

const createBill = async (overrides) => {
  const res = await request(app).post('/api/v1/bills').set(owner.headers).send(billBody(overrides));
  expect(res.status).toBe(201);
  return res.body;
};
const postBill = (headers, id) => request(app).post(`/api/v1/bills/${id}/post`).set(headers).send();
const reverse = (id, body = { reason: 'entered twice', reversalDate: '2025-07-25' }) =>
  request(app).post(`/api/v1/journal-entries/${id}/reverse`).set(owner.headers).send(body);

describe('POST /bills/:id/post', () => {
  it('posts a balanced entry: Dr each line account, Dr 2210 grouped input VAT, Cr 2100 for the grand total against the Supplier', async () => {
    // Paper: 10 x 250 = 2,500.00, VAT 325.00.
    // Desk:  2 x 1,000 = 2,000.00 less 10% = 1,800.00 taxable, VAT 234.00.
    // Taxable 4,300.00 + VAT 559.00 = grand total 4,859.00.
    const draft = await createBill({
      lines: [
        { accountId: expense.id, description: 'Printer paper', quantity: 10, unitPrice: 250, taxCodeId: vat13.id },
        { accountId: asset.id, description: 'Desk', quantity: 2, unitPrice: 1000, discountPct: 10, taxCodeId: vat13.id },
      ],
    });
    expect(draft.grandTotal).toBe('4859.00');
    expect(draft.outstandingAmount).toBe('0.00');

    const res = await postBill(owner.headers, draft.id);

    expect(res.status).toBe(200);
    expect(res.body.bill).toMatchObject({
      id: draft.id,
      docType: 'bill',
      status: 'posted',
      docNo: 'BILL-2082-0001',
      grandTotal: '4859.00',
      outstandingAmount: '4859.00',
    });
    const lines = res.body.journalEntry.lines;
    const simplified = lines.map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit, partyId: l.partyId }));
    expect(simplified).toEqual([
      { accountId: expense.id, debit: '2500.00', credit: '0.00', partyId: null },
      { accountId: asset.id, debit: '1800.00', credit: '0.00', partyId: null },
      { accountId: vatIn.id, debit: '559.00', credit: '0.00', partyId: null },
      { accountId: ap.id, debit: '0.00', credit: '4859.00', partyId: supplier.id },
    ]);
    expect(lines).toHaveLength(4);
    expect(res.body.journalEntry).toMatchObject({ documentType: 'bill', entryDate: '2025-07-20', sourceId: draft.id, status: 'posted' });

    const stored = await prisma.document.findUniqueOrThrow({ where: { id: draft.id } });
    expect(stored.journalEntryId).toBe(res.body.journalEntry.id);
  });

  it('refuses to post a Bill whose grand total is zero with a 422 business rule and leaves the draft untouched', async () => {
    const draft = await createBill({ lines: [{ accountId: expense.id, description: 'Free sample', quantity: 1, unitPrice: 0 }] });
    expect(draft.grandTotal).toBe('0.00');
    const entriesBefore = await prisma.journalEntry.count({ where: { organizationId: owner.orgId } });

    const res = await postBill(owner.headers, draft.id);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('bill_total_zero');
    expect((await prisma.document.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('DRAFT');
    expect(await prisma.journalEntry.count({ where: { organizationId: owner.orgId } })).toBe(entriesBefore);
  });

  it('writes a bill.posted audit event', async () => {
    const draft = await createBill();
    await postBill(owner.headers, draft.id);

    await expect.poll(async () => {
      const events = await prisma.auditLog.findMany({ where: { organizationId: owner.orgId, entityId: draft.id, action: 'bill.posted' } });
      return events.length;
    }).toBe(1);
  });

  it('refuses a second post of the same Bill', async () => {
    const draft = await createBill();
    expect((await postBill(owner.headers, draft.id)).status).toBe(200);
    const again = await postBill(owner.headers, draft.id);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('already_posted');
  });
});

describe('Posting Date rules at post time', () => {
  it('numbers a Bill dated in 2082/83 (Ashad) but posted in Shrawan 2083 from the later year BILL series', async () => {
    const draft = await createBill({ docDate: '2026-07-10', postingDate: '2026-07-20' });
    expect(draft.docDate).toBe('2026-07-10');

    const res = await postBill(owner.headers, draft.id);

    expect(res.status).toBe(200);
    expect(res.body.bill.docNo).toBe('BILL-2083-0001');
    expect(res.body.journalEntry.entryDate).toBe('2026-07-20');
    expect(res.body.journalEntry.entryNumber).toMatch(/^JE-2083-/);
    const stored = await prisma.document.findUniqueOrThrow({ where: { id: draft.id } });
    expect(stored.fiscalYearId).toBe(fy83.id);
  });

  it('posts a late Bill whose Bill Date period is locked, using an open Posting Date', async () => {
    const draft = await createBill({ docDate: '2026-06-20', postingDate: '2026-07-20' });
    await prisma.accountingPeriod.updateMany({ where: { fiscalYearId: fy82.id, label: 'Ashad' }, data: { isOpen: false } });

    const res = await postBill(owner.headers, draft.id);
    await prisma.accountingPeriod.updateMany({ where: { fiscalYearId: fy82.id, label: 'Ashad' }, data: { isOpen: true } });

    expect(res.status).toBe(200);
    expect(res.body.bill.docNo).toMatch(/^BILL-2083-/);
  });

  it('fails with period_locked when the Posting Date period was locked after the draft was saved', async () => {
    const draft = await createBill({ docDate: '2025-08-20' }); // Bhadra
    await prisma.accountingPeriod.updateMany({ where: { fiscalYearId: fy82.id, label: 'Bhadra' }, data: { isOpen: false } });

    const res = await postBill(owner.headers, draft.id);
    await prisma.accountingPeriod.updateMany({ where: { fiscalYearId: fy82.id, label: 'Bhadra' }, data: { isOpen: true } });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('period_locked');
    const stored = await prisma.document.findUniqueOrThrow({ where: { id: draft.id } });
    expect(stored.status).toBe('DRAFT');
    expect(stored.docNo).toBeNull();
    expect(await prisma.journalEntry.count({ where: { sourceId: draft.id } })).toBe(0);
  });

  it('rejects a Posting Date earlier than the Bill Date when saving the draft, and when posting a row that slipped past', async () => {
    const early = await request(app).post('/api/v1/bills').set(owner.headers).send(billBody({ docDate: '2025-07-20', postingDate: '2025-07-19' }));
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe('posting_date_before_bill_date');

    const draft = await createBill({ docDate: '2025-07-20' });
    await prisma.$executeRaw`UPDATE "Document" SET "postingDate" = '2025-07-19' WHERE id = ${draft.id}`;
    const res = await postBill(owner.headers, draft.id);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('posting_date_before_bill_date');
    expect((await prisma.document.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('DRAFT');
  });
});

describe('posting guards', () => {
  it('refuses a Bill line whose tax code has no input account, writing nothing', async () => {
    const noInput = await prisma.taxCode.create({
      data: { organizationId: owner.orgId, code: 'OUTONLY', name: 'Output only', rate: '0.1300', type: 'VAT' },
    });
    const draft = await createBill({ lines: [{ accountId: expense.id, description: 'x', quantity: 1, unitPrice: 100, taxCodeId: noInput.id }] });

    const res = await postBill(owner.headers, draft.id);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('tax_code_no_input_account');
    expect((await prisma.document.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('DRAFT');
  });

  it('allows only bill.post: Clerk and Viewer get 403 and the draft is untouched', async () => {
    const draft = await createBill();
    for (const headers of [clerk, viewer]) {
      const res = await postBill(headers, draft.id);
      expect(res.status).toBe(403);
    }
    expect((await prisma.document.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('DRAFT');
  });
});

describe('tenant isolation', () => {
  it("org A's user posting org B's Bill gets 404 and org B's Bill is unchanged", async () => {
    const theirs = await prisma.document.create({
      data: {
        organizationId: other.orgId, fiscalYearId: (await prisma.fiscalYear.findFirstOrThrow({ where: { organizationId: other.orgId, label: '2082/83' } })).id,
        docType: 'BILL', docDate: new Date('2025-07-20'), postingDate: new Date('2025-07-20'), partyId: otherSupplier.id,
        referenceNo: 'THEIRS-1', status: 'DRAFT', subtotal: 100, taxableAmount: 100, grandTotal: 100,
        lines: { create: [{ lineNo: 1, description: 'x', accountId: otherExpense.id, quantity: 1, unitPrice: 100, taxableAmount: 100, lineTotal: 100 }] },
      },
    });
    const before = JSON.stringify(await prisma.document.findUniqueOrThrow({ where: { id: theirs.id } }));

    const res = await postBill(owner.headers, theirs.id);

    expect(res.status).toBe(404);
    expect(JSON.stringify(await prisma.document.findUniqueOrThrow({ where: { id: theirs.id } }))).toBe(before);
    expect(await prisma.journalEntry.count({ where: { organizationId: other.orgId } })).toBe(0);
    expect(await prisma.documentSeries.count({ where: { organizationId: other.orgId } })).toBe(0);
  });
});

describe('reversing a posted Bill (shared journal-entry reversal path)', () => {
  const apBalance = async () => {
    const lines = await prisma.journalLine.findMany({ where: { organizationId: owner.orgId, accountId: ap.id } });
    return lines.reduce((t, l) => t + Number(l.credit) - Number(l.debit), 0);
  };

  it('reverses a Bill with no payments: status REVERSED, outstanding 0, reversal entry posted, AP back to where it was', async () => {
    const draft = await createBill(); // 2,500.00 + 325.00 VAT = 2,825.00
    const posted = await postBill(owner.headers, draft.id);
    const apAfterPost = await apBalance();

    const res = await reverse(posted.body.journalEntry.id);

    expect(res.status).toBe(200);
    expect(res.body.original.status).toBe('reversed');
    expect(res.body.reversal).toMatchObject({ status: 'posted', reversalOfId: posted.body.journalEntry.id });
    const stored = await prisma.document.findUniqueOrThrow({ where: { id: draft.id } });
    expect(stored.status).toBe('REVERSED');
    expect(stored.outstandingAmount.toFixed(2)).toBe('0.00');
    expect(await apBalance()).toBe(apAfterPost - 2825);

    // A reversed Bill reads back as reversed.
    const read = await request(app).get(`/api/v1/bills/${draft.id}`).set(owner.headers);
    expect(read.body.status).toBe('reversed');
  });

  it('refuses to reverse a Bill that has payments applied, naming the Supplier Payment, and changes nothing', async () => {
    const draft = await createBill();
    const posted = await postBill(owner.headers, draft.id);
    // Supplier Payments arrive in a later ticket: put an allocation row in directly.
    const payment = await prisma.document.create({
      data: {
        organizationId: owner.orgId, fiscalYearId: fy82.id, docType: 'SUPPLIER_PAYMENT', docDate: new Date('2025-07-21'),
        postingDate: new Date('2025-07-21'), partyId: supplier.id, status: 'POSTED', grandTotal: 500,
      },
    });
    await prisma.paymentAllocation.create({
      data: { organizationId: owner.orgId, paymentDocumentId: payment.id, targetDocumentId: draft.id, amount: 500 },
    });
    const entriesBefore = await prisma.journalEntry.count({ where: { organizationId: owner.orgId } });

    const res = await reverse(posted.body.journalEntry.id);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('cannot_reverse_bill_with_payments');
    expect(res.body.error.message).toBe(`Bill ${draft.id} has payments applied \u2014 reverse the Supplier Payment first`);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('POSTED');
    expect((await prisma.journalEntry.findUniqueOrThrow({ where: { id: posted.body.journalEntry.id } })).status).toBe('POSTED');
    expect(await prisma.journalEntry.count({ where: { organizationId: owner.orgId } })).toBe(entriesBefore);
  });
});
