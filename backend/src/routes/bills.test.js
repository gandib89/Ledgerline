import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { prisma } from '../db/client.js';
import { resetDb, seedRoles, makeUserWithOrg } from '../test/helpers.js';

let owner, clerk, viewer, other;
let expense, asset, supplier, vat13, fy82, fy83;
let otherSupplier, otherExpense, otherVat;

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
  const acc = (code, name, type, extra = {}) =>
    prisma.account.create({ data: { organizationId: orgId, code, name, type, ...extra } });
  const exp = await acc('5100', 'Office Supplies', 'EXPENSE');
  const ast = await acc('1500', 'Equipment', 'ASSET');
  const ap = await acc('2100', 'Accounts Payable', 'LIABILITY', { isControlAccount: true });
  const vatIn = await acc('2210', 'VAT Receivable (Input)', 'ASSET', { isControlAccount: true });
  const tax = await prisma.taxCode.create({
    data: { organizationId: orgId, code: 'VAT13', name: 'VAT 13%', rate: '0.1300', type: 'VAT', inputAccountId: vatIn.id },
  });
  const sup = await prisma.party.create({
    data: { organizationId: orgId, type: 'SUPPLIER', code: 'SUP-001', name: 'Kathmandu Stationers', creditDays: 30 },
  });
  return { fy, fyNext, exp, ast, ap, vatIn, tax, sup };
}

beforeAll(async () => {
  await resetDb();
  const roles = await seedRoles();

  owner = await makeUserWithOrg(app, 'owner@bills.test', 'Bill Route Test Co');
  clerk = await addMember(roles, 'clerk@bills.test', 'Clerk');
  viewer = await addMember(roles, 'viewer@bills.test', 'Viewer');
  other = await makeUserWithOrg(app, 'other@bills.test', 'Other Org Co');

  const a = await seedOrg(owner.orgId);
  ({ expense, asset, supplier, vat13 } = { expense: a.exp, asset: a.ast, supplier: a.sup, vat13: a.tax });
  fy82 = a.fy;
  fy83 = a.fyNext;
  await prisma.accountingPeriod.create({
    data: { fiscalYearId: fy82.id, label: 'Shrawan', startDate: new Date('2025-07-16'), endDate: new Date('2025-08-15'), isOpen: true },
  });

  const b = await seedOrg(other.orgId);
  otherSupplier = b.sup;
  otherExpense = b.exp;
  otherVat = b.tax;
});

afterAll(() => prisma.$disconnect());

function billBody(overrides = {}) {
  return {
    partyId: supplier.id,
    referenceNo: 'INV-12',
    docDate: '2025-07-20',
    lines: [{ accountId: expense.id, description: 'Printer paper', quantity: 10, unitPrice: 250 }],
    ...overrides,
  };
}

const post = (headers, body) => request(app).post('/api/v1/bills').set(headers).send(body);

// A valid Bill body for the *other* organization (its own supplier and account).
const theirBillBody = (referenceNo) => billBody({
  partyId: otherSupplier.id,
  referenceNo,
  lines: [{ accountId: otherExpense.id, description: 'x', quantity: 1, unitPrice: 1 }],
});

describe('POST /bills', () => {
  it('saves a DRAFT with Supplier Reference, defaulted Posting Date, Due Date from credit days and invoice-style totals', async () => {
    const res = await post(owner.headers, billBody({
      lines: [{ accountId: expense.id, description: 'Printer paper', quantity: 10, unitPrice: 250, taxCodeId: vat13.id }],
    }));

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      docType: 'bill',
      status: 'draft',
      docNo: null,
      referenceNo: 'INV-12',
      docDate: '2025-07-20',
      postingDate: '2025-07-20',
      dueDate: '2025-08-19', // + 30 credit days
      partyId: supplier.id,
      taxableAmount: '2500.00',
      taxAmount: '325.00',
      grandTotal: '2825.00',
    });
    expect(res.body.lines).toHaveLength(1);
    const stored = await prisma.document.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(stored.docType).toBe('BILL');
    expect(stored.fiscalYearId).toBe(fy82.id);
  });

  it('uses an explicit Due Date and a later Posting Date, which decides the fiscal year', async () => {
    const res = await post(owner.headers, billBody({
      referenceNo: 'INV-LATE',
      docDate: '2026-07-10', // fiscal year 2082/83
      postingDate: '2026-07-20', // fiscal year 2083/84
      dueDate: '2026-08-30',
    }));

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ docDate: '2026-07-10', postingDate: '2026-07-20', dueDate: '2026-08-30' });
    const stored = await prisma.document.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(stored.fiscalYearId).toBe(fy83.id);
  });

  it('keeps the Due Date counting from the Bill Date, not the Posting Date', async () => {
    const res = await post(owner.headers, billBody({ referenceNo: 'INV-DUE', docDate: '2025-07-20', postingDate: '2025-07-25' }));
    expect(res.body.dueDate).toBe('2025-08-19');
  });

  it('rejects a Posting Date earlier than the Bill Date', async () => {
    const res = await post(owner.headers, billBody({ docDate: '2025-07-20', postingDate: '2025-07-19' }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('posting_date_before_bill_date');
  });

  it.each([[''], ['   ']])('rejects a blank Supplier Reference (%j)', async (referenceNo) => {
    const res = await post(owner.headers, billBody({ referenceNo }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('supplier_reference_required');
  });

  it('rejects a missing Supplier Reference', async () => {
    const body = billBody();
    delete body.referenceNo;
    const res = await post(owner.headers, body);
    expect(res.status).toBe(400);
  });

  it('accepts a party of type BOTH and rejects a Customer-only party', async () => {
    const both = await prisma.party.create({ data: { organizationId: owner.orgId, type: 'BOTH', code: 'BTH-1', name: 'Both Ltd', creditDays: 0 } });
    const customer = await prisma.party.create({ data: { organizationId: owner.orgId, type: 'CUSTOMER', code: 'CUS-9', name: 'Customer Only', creditDays: 0 } });

    const ok = await post(owner.headers, billBody({ partyId: both.id, referenceNo: 'B-1' }));
    expect(ok.status).toBe(201);
    expect(ok.body.dueDate).toBe('2025-07-20'); // 0 credit days

    const bad = await post(owner.headers, billBody({ partyId: customer.id, referenceNo: 'B-2' }));
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('party_not_supplier');
  });

  it('accepts expense and asset lines and rejects revenue, control, bank, cash and liability accounts', async () => {
    const mk = (code, type, extra = {}) => prisma.account.create({ data: { organizationId: owner.orgId, code, name: `Acct ${code}`, type, ...extra } });
    const revenue = await mk('4900', 'REVENUE');
    const controlExpense = await mk('5900', 'EXPENSE', { isControlAccount: true });
    const bank = await mk('1090', 'ASSET', { isBankAccount: true });
    const liability = await mk('2900', 'LIABILITY');
    // Cash in Hand is not flagged as a bank account, but a Bill must never debit cash.
    const cashInHand = await mk('1010', 'ASSET');

    const ok = await post(owner.headers, billBody({
      referenceNo: 'LINES-OK',
      lines: [
        { accountId: expense.id, description: 'Paper', quantity: 1, unitPrice: 100 },
        { accountId: asset.id, description: 'Laptop', quantity: 1, unitPrice: 50000 },
      ],
    }));
    expect(ok.status).toBe(201);
    expect(ok.body.grandTotal).toBe('50100.00');

    for (const bad of [revenue, controlExpense, bank, liability, cashInHand]) {
      const res = await post(owner.headers, billBody({
        referenceNo: `LINES-${bad.code}`,
        lines: [{ accountId: bad.id, description: 'x', quantity: 1, unitPrice: 1 }],
      }));
      expect(res.status, bad.code).toBe(422);
      expect(res.body.error.code).toBe('bill_line_account_not_allowed');
    }
  });
});

describe('zero-total Bills', () => {
  const free = () => [{ accountId: expense.id, description: 'Free sample', quantity: 1, unitPrice: 0 }];

  it('rejects creating a Bill whose grand total is zero and saves nothing', async () => {
    const before = await prisma.document.count({ where: { organizationId: owner.orgId, docType: 'BILL' } });
    const res = await post(owner.headers, billBody({ referenceNo: 'ZERO-1', lines: free() }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('bill_total_zero');
    expect(await prisma.document.count({ where: { organizationId: owner.orgId, docType: 'BILL' } })).toBe(before);
  });

  it('rejects a 100% discount on create, and an update that would zero a draft, leaving the draft unchanged', async () => {
    const full = await post(owner.headers, billBody({
      referenceNo: 'ZERO-2',
      lines: [{ accountId: expense.id, description: 'Promo', quantity: 1, unitPrice: 100, discountPct: 100 }],
    }));
    expect(full.status).toBe(422);
    expect(full.body.error.code).toBe('bill_total_zero');

    const draft = await post(owner.headers, billBody({ referenceNo: 'ZERO-3' }));
    const res = await request(app).patch(`/api/v1/bills/${draft.body.id}`).set(owner.headers).send({ version: 0, lines: free() });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('bill_total_zero');
    const stored = await prisma.document.findUniqueOrThrow({ where: { id: draft.body.id } });
    expect(stored.version).toBe(0);
    expect(stored.grandTotal.toString()).toBe('2500');
  });
});

describe('PATCH /bills/:id', () => {
  const patch = (headers, id, body) => request(app).patch(`/api/v1/bills/${id}`).set(headers).send(body);

  async function draft(referenceNo, extra = {}) {
    const res = await post(owner.headers, billBody({ referenceNo, ...extra }));
    expect(res.status).toBe(201);
    return res.body;
  }

  it('recomputes totals, bumps the version and rejects a stale version', async () => {
    const bill = await draft('PATCH-1');
    const lines = [{ accountId: expense.id, description: 'Toner', quantity: 2, unitPrice: 1000, taxCodeId: vat13.id }];

    const updated = await patch(owner.headers, bill.id, { version: 0, lines });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ version: 1, taxableAmount: '2000.00', taxAmount: '260.00', grandTotal: '2260.00' });

    const stale = await patch(owner.headers, bill.id, { version: 0, lines });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('version_conflict');
  });

  it('recalculates fiscalYearId from the Posting Date and re-validates it against the Bill Date', async () => {
    const bill = await draft('PATCH-FY', { docDate: '2026-07-10' });
    const lines = billBody().lines;
    const fiscalYearOf = async () => (await prisma.document.findUniqueOrThrow({ where: { id: bill.id } })).fiscalYearId;
    expect(await fiscalYearOf()).toBe(fy82.id);

    const moved = await patch(owner.headers, bill.id, { version: 0, postingDate: '2026-07-18', lines });
    expect(moved.status).toBe(200);
    expect(moved.body.postingDate).toBe('2026-07-18');
    expect(await fiscalYearOf()).toBe(fy83.id);

    const back = await patch(owner.headers, bill.id, { version: 1, postingDate: '2026-07-10', lines });
    expect(back.status).toBe(200);
    expect(await fiscalYearOf()).toBe(fy82.id);

    const before = await patch(owner.headers, bill.id, { version: 2, postingDate: '2026-07-09', lines });
    expect(before.status).toBe(422);
    expect(before.body.error.code).toBe('posting_date_before_bill_date');
  });

  it('moves a defaulted Posting Date with the Bill Date, and leaves a chosen Due Date alone', async () => {
    const bill = await draft('PATCH-DATES', { docDate: '2025-07-20', dueDate: '2025-09-01' });
    const same = await patch(owner.headers, bill.id, { version: 0, lines: billBody().lines, notes: 'n' });
    expect(same.body).toMatchObject({ postingDate: '2025-07-20', dueDate: '2025-09-01' });

    const moved = await patch(owner.headers, bill.id, { version: 1, docDate: '2026-07-18', lines: billBody().lines });
    expect(moved.body).toMatchObject({ docDate: '2026-07-18', postingDate: '2026-07-18', dueDate: '2026-08-17' });
  });

  it('rejects a Customer-only party, a blank reference and a disallowed account', async () => {
    const bill = await draft('PATCH-BAD');
    const customer = await prisma.party.create({ data: { organizationId: owner.orgId, type: 'CUSTOMER', code: 'CUS-P', name: 'Cust P', creditDays: 0 } });
    const control = await prisma.account.findFirstOrThrow({ where: { organizationId: owner.orgId, code: '2100' } });

    const party = await patch(owner.headers, bill.id, { version: 0, partyId: customer.id, lines: billBody().lines });
    expect(party.body.error.code).toBe('party_not_supplier');
    const ref = await patch(owner.headers, bill.id, { version: 0, referenceNo: '  ', lines: billBody().lines });
    expect(ref.body.error.code).toBe('supplier_reference_required');
    const acct = await patch(owner.headers, bill.id, { version: 0, lines: [{ accountId: control.id, description: 'x', quantity: 1, unitPrice: 1 }] });
    expect(acct.body.error.code).toBe('bill_line_account_not_allowed');

    expect((await prisma.document.findUniqueOrThrow({ where: { id: bill.id } })).version).toBe(0);
  });

  it('returns 409 not_draft for a Bill that is no longer a draft', async () => {
    const bill = await draft('PATCH-POSTED');
    await prisma.document.update({ where: { id: bill.id }, data: { status: 'POSTED' } });

    const res = await patch(owner.headers, bill.id, { version: 0, lines: billBody().lines });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('not_draft');
  });

  it('does not touch an Invoice through the Bills route', async () => {
    const invoice = await prisma.document.create({
      data: {
        organizationId: owner.orgId, fiscalYearId: fy82.id, docType: 'INVOICE', docDate: new Date('2025-07-20'),
        postingDate: new Date('2025-07-20'), partyId: supplier.id, status: 'DRAFT',
      },
    });
    const res = await patch(owner.headers, invoice.id, { version: 0, lines: billBody().lines });
    expect(res.status).toBe(404);
  });
});

describe('GET /bills', () => {
  it('lists Bills filtered by Supplier and status, and a Viewer can read them', async () => {
    const sup2 = await prisma.party.create({ data: { organizationId: owner.orgId, type: 'SUPPLIER', code: 'SUP-L', name: 'List Supplier', creditDays: 0 } });
    const a = await post(owner.headers, billBody({ partyId: sup2.id, referenceNo: 'LIST-A' }));
    const b = await post(owner.headers, billBody({ partyId: sup2.id, referenceNo: 'LIST-B' }));
    await prisma.document.update({ where: { id: b.body.id }, data: { status: 'POSTED' } });

    const bySupplier = await request(app).get(`/api/v1/bills?partyId=${sup2.id}`).set(viewer);
    expect(bySupplier.status).toBe(200);
    expect(bySupplier.body.map((x) => x.referenceNo).sort()).toEqual(['LIST-A', 'LIST-B']);
    expect(bySupplier.body.every((x) => x.docType === 'bill')).toBe(true);

    const drafts = await request(app).get(`/api/v1/bills?partyId=${sup2.id}&status=draft`).set(owner.headers);
    expect(drafts.body.map((x) => x.id)).toEqual([a.body.id]);

    const detail = await request(app).get(`/api/v1/bills/${a.body.id}`).set(viewer);
    expect(detail.status).toBe(200);
    expect(detail.body.lines).toHaveLength(1);
  });

  it("does not list another organization's Bills", async () => {
    const theirs = await post(other.headers, theirBillBody('THEIRS'));
    expect(theirs.status).toBe(201);

    const res = await request(app).get('/api/v1/bills').set(owner.headers);
    expect(res.body.map((x) => x.id)).not.toContain(theirs.body.id);
  });
});

describe('permissions', () => {
  it('lets a Clerk draft a Bill, and refuses a Viewer', async () => {
    const ok = await post(clerk, billBody({ referenceNo: 'PERM-CLERK' }));
    expect(ok.status).toBe(201);
    const no = await post(viewer, billBody({ referenceNo: 'PERM-VIEWER' }));
    expect(no.status).toBe(403);
    const patchNo = await request(app).patch(`/api/v1/bills/${ok.body.id}`).set(viewer).send({ version: 0, lines: billBody().lines });
    expect(patchNo.status).toBe(403);
  });
});

describe('audit', () => {
  it('writes bill.created and bill.updated events', async () => {
    const created = await post(owner.headers, billBody({ referenceNo: 'AUDIT-1' }));
    await request(app).patch(`/api/v1/bills/${created.body.id}`).set(owner.headers).send({ version: 0, lines: billBody().lines });

    await vi.waitFor(async () => {
      const events = await prisma.auditLog.findMany({ where: { organizationId: owner.orgId, entityId: created.body.id }, orderBy: { createdAt: 'asc' } });
      expect(events.map((e) => e.action)).toEqual(['bill.created', 'bill.updated']);
    });
  });
});

describe('write-path tenant isolation (org A user sending org B ids)', () => {
  async function orgBSnapshot() {
    const [docs, lines, parties] = await Promise.all([
      prisma.document.findMany({ where: { organizationId: other.orgId }, orderBy: { id: 'asc' } }),
      prisma.documentLine.findMany({ where: { document: { organizationId: other.orgId } }, orderBy: { id: 'asc' } }),
      prisma.party.findMany({ where: { organizationId: other.orgId }, orderBy: { id: 'asc' } }),
    ]);
    return JSON.stringify({ docs, lines, parties });
  }
  const ownBillCount = () => prisma.document.count({ where: { organizationId: owner.orgId, docType: 'BILL' } });

  it("editing org B's Bill is a 404 and leaves it unchanged", async () => {
    const theirs = await post(other.headers, theirBillBody('ISO-EDIT'));
    const before = await orgBSnapshot();

    const res = await request(app).patch(`/api/v1/bills/${theirs.body.id}`).set(owner.headers).send({ version: 0, notes: 'hijack', lines: billBody().lines });

    expect(res.status).toBe(404);
    expect(await orgBSnapshot()).toBe(before);
  });

  it("creating a Bill for org B's Supplier is rejected and writes nothing", async () => {
    const before = await orgBSnapshot();
    const ownBefore = await ownBillCount();

    const res = await post(owner.headers, billBody({ partyId: otherSupplier.id, referenceNo: 'ISO-SUP' }));

    expect(res.status).toBe(404);
    expect(await orgBSnapshot()).toBe(before);
    expect(await ownBillCount()).toBe(ownBefore);
  });

  it("rejects a line with org B's account or tax code, on create and on edit, and writes nothing", async () => {
    const own = await post(owner.headers, billBody({ referenceNo: 'ISO-OWN' }));
    const before = await orgBSnapshot();
    const ownBefore = await ownBillCount();

    const badAccount = await post(owner.headers, billBody({ referenceNo: 'ISO-ACC', lines: [{ accountId: otherExpense.id, description: 'x', quantity: 1, unitPrice: 1 }] }));
    const badTax = await post(owner.headers, billBody({ referenceNo: 'ISO-TAX', lines: [{ accountId: expense.id, description: 'x', quantity: 1, unitPrice: 1, taxCodeId: otherVat.id }] }));
    const patched = await request(app).patch(`/api/v1/bills/${own.body.id}`).set(owner.headers).send({ version: 0, lines: [{ accountId: otherExpense.id, description: 'x', quantity: 1, unitPrice: 1 }] });

    expect([badAccount.status, badTax.status, patched.status]).toEqual([404, 404, 404]);
    expect(await orgBSnapshot()).toBe(before);
    expect(await ownBillCount()).toBe(ownBefore);
  });

  it("reads org B's Bill as 404", async () => {
    const theirs = await prisma.document.findFirstOrThrow({ where: { organizationId: other.orgId, docType: 'BILL' } });
    const res = await request(app).get(`/api/v1/bills/${theirs.id}`).set(owner.headers);
    expect(res.status).toBe(404);
  });
});

describe('Duplicate Supplier Reference', () => {
  const patch = (headers, id, body) => request(app).patch(`/api/v1/bills/${id}`).set(headers).send(body);
  let sup2;

  beforeAll(async () => {
    sup2 = await prisma.party.create({
      data: { organizationId: owner.orgId, type: 'SUPPLIER', code: 'SUP-DUP', name: 'Pokhara Paper', creditDays: 15 },
    });
  });

  it('409s a second Bill with the same reference, ignoring case and surrounding spaces, naming the first Bill', async () => {
    const first = await post(owner.headers, billBody({ referenceNo: 'inv-D1' }));
    expect(first.status).toBe(201);

    const dup = await post(owner.headers, billBody({ referenceNo: ' INV-d1 ' }));
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('duplicate_supplier_reference');
    expect(dup.body.error.details).toEqual({ billId: first.body.id, referenceNo: 'inv-D1' });
    expect(dup.body.error.message).toMatch(/open and edit/i);
  });

  it('allows the same reference for a different Supplier and in a different organization', async () => {
    await post(owner.headers, billBody({ referenceNo: 'SHARED-1' }));
    const otherSupplierSameRef = await post(owner.headers, billBody({ partyId: sup2.id, referenceNo: 'SHARED-1' }));
    const otherOrgSameRef = await post(other.headers, theirBillBody('SHARED-1'));
    expect([otherSupplierSameRef.status, otherOrgSameRef.status]).toEqual([201, 201]);
  });

  it('409s an update that moves a draft onto another Bill\'s reference, but not one that keeps its own', async () => {
    const a = await post(owner.headers, billBody({ referenceNo: 'UPD-A' }));
    const b = await post(owner.headers, billBody({ referenceNo: 'UPD-B' }));

    const clash = await patch(owner.headers, b.body.id, { version: 0, referenceNo: 'upd-a', lines: billBody().lines });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('duplicate_supplier_reference');
    expect(clash.body.error.details).toEqual({ billId: a.body.id, referenceNo: 'UPD-A' });

    const own = await patch(owner.headers, b.body.id, { version: 0, referenceNo: ' UPD-b ', lines: billBody().lines });
    expect(own.status).toBe(200);
  });

  it('409s an update that moves a draft to another Supplier who already has that reference', async () => {
    await post(owner.headers, billBody({ partyId: sup2.id, referenceNo: 'MOVE-1' }));
    const mine = await post(owner.headers, billBody({ referenceNo: 'MOVE-1' }));
    const res = await patch(owner.headers, mine.body.id, { version: 0, partyId: sup2.id, lines: billBody().lines });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('duplicate_supplier_reference');
  });

  it('does not let a REVERSED Bill block the same reference again', async () => {
    const old = await post(owner.headers, billBody({ referenceNo: 'REV-1' }));
    await prisma.document.update({ where: { id: old.body.id }, data: { status: 'REVERSED' } });

    const again = await post(owner.headers, billBody({ referenceNo: 'REV-1' }));
    expect(again.status).toBe(201);
  });

  it('rejects a Bill with a blank reference at the database (CHECK constraint)', async () => {
    const doc = await prisma.document.findFirstOrThrow({ where: { organizationId: owner.orgId, docType: 'BILL' } });
    await expect(prisma.document.update({ where: { id: doc.id }, data: { referenceNo: '   ' } })).rejects.toThrow(/Document_bill_reference_required/);
  });

  it('two simultaneous creates with the same reference give exactly one 201 and one 409', async () => {
    const results = await Promise.all([
      post(owner.headers, billBody({ referenceNo: 'RACE-1' })),
      post(owner.headers, billBody({ referenceNo: 'race-1 ' })),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const loser = results.find((r) => r.status === 409);
    const winner = results.find((r) => r.status === 201);
    expect(loser.body.error.code).toBe('duplicate_supplier_reference');
    expect(loser.body.error.details.billId).toBe(winner.body.id);
  });
});
