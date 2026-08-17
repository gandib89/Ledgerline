import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { prisma } from '../db/client.js';
import { resetDb, seedRoles, makeUserWithOrg } from '../test/helpers.js';

let owner, clerk, viewer;
let salesAccount, party;

async function addMember(roles, email, roleName) {
  await request(app).post('/api/v1/auth/register').send({ email, password: 'password123' });
  await request(app)
    .post(`/api/v1/orgs/${owner.orgId}/members`)
    .set(owner.headers)
    .send({ email, roleId: roles[roleName].id });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: 'password123' });
  return { Authorization: `Bearer ${login.body.accessToken}`, 'X-Organization-Id': owner.orgId };
}

beforeAll(async () => {
  await resetDb();
  const roles = await seedRoles();

  owner = await makeUserWithOrg(app, 'owner@invoices.test', 'Invoice Route Test Co');
  clerk = await addMember(roles, 'clerk@invoices.test', 'Clerk');
  viewer = await addMember(roles, 'viewer@invoices.test', 'Viewer');

  const fiscalYear = await prisma.fiscalYear.create({
    data: {
      organizationId: owner.orgId,
      label: '2082/83',
      startDate: new Date('2025-07-16'),
      endDate: new Date('2026-07-15'),
    },
  });
  await prisma.accountingPeriod.create({
    data: {
      fiscalYearId: fiscalYear.id,
      label: 'Shrawan',
      startDate: new Date('2025-07-16'),
      endDate: new Date('2025-08-15'),
      isOpen: true,
    },
  });
  await prisma.accountingPeriod.create({
    data: {
      fiscalYearId: fiscalYear.id,
      label: 'Bhadra',
      startDate: new Date('2025-08-16'),
      endDate: new Date('2025-09-15'),
      isOpen: false,
    },
  });

  await prisma.account.create({
    data: { organizationId: owner.orgId, code: '1100', name: 'Accounts Receivable', type: 'ASSET', isControlAccount: true },
  });
  salesAccount = await prisma.account.create({
    data: { organizationId: owner.orgId, code: '4100', name: 'Sales Revenue', type: 'REVENUE' },
  });
  const vatAccount = await prisma.account.create({
    data: { organizationId: owner.orgId, code: '2200', name: 'VAT Payable (Output)', type: 'LIABILITY', isControlAccount: true },
  });
  await prisma.taxCode.create({
    data: { organizationId: owner.orgId, code: 'VAT13', name: 'VAT 13%', rate: '0.1300', type: 'VAT', outputAccountId: vatAccount.id },
  });
  party = await prisma.party.create({
    data: { organizationId: owner.orgId, type: 'CUSTOMER', code: 'CUS-001', name: 'Himalayan Trek Supplies', creditDays: 30 },
  });
});

afterAll(() => prisma.$disconnect());

function invoiceBody(overrides = {}) {
  return {
    partyId: party.id,
    docDate: '2025-07-20',
    lines: [
      { accountId: salesAccount.id, description: 'Trekking backpacks', quantity: 15, unitPrice: 8000, taxCodeId: undefined },
    ],
    ...overrides,
  };
}

describe('the Day 3 checkpoint: create, preview, post', () => {
  it('lists active tax codes with exact decimal rates', async () => {
    const response = await request(app).get('/api/v1/tax-codes').set(owner.headers);

    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      expect.objectContaining({ code: 'VAT13', name: 'VAT 13%', rate: '0.1300', type: 'VAT', isActive: true }),
    ]);
  });

  it('filters invoices inclusively by document date', async () => {
    await request(app).post('/api/v1/invoices').set(owner.headers).send(invoiceBody({ docDate: '2025-07-19' }));
    await request(app).post('/api/v1/invoices').set(owner.headers).send(invoiceBody({ docDate: '2025-07-25' }));
    await request(app).post('/api/v1/invoices').set(owner.headers).send(invoiceBody({ docDate: '2025-07-26' }));

    const response = await request(app)
      .get('/api/v1/invoices?from=2025-07-20&to=2025-07-25')
      .set(owner.headers);

    expect(response.status).toBe(200);
    expect(response.body.map((invoice) => invoice.docDate)).toEqual(['2025-07-25']);
  });

  it('creates a draft, previews totals, posts, and gets back a balanced journal entry', async () => {
    const preview = await request(app)
      .post('/api/v1/invoices/preview')
      .set(owner.headers)
      .send({ lines: invoiceBody().lines });
    expect(preview.status).toBe(200);
    expect(preview.body.totals.grandTotal).toBe('120000.00'); // no tax code on this line

    const created = await request(app).post('/api/v1/invoices').set(owner.headers).send(invoiceBody());
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('draft');
    expect(created.body.docNo).toBeNull();
    expect(created.body.grandTotal).toBe('120000.00');

    const posted = await request(app)
      .post(`/api/v1/invoices/${created.body.id}/post`)
      .set(owner.headers)
      .send();
    expect(posted.status).toBe(200);
    expect(posted.body.invoice.status).toBe('posted');
    expect(posted.body.invoice.docNo).toMatch(/^INV-2082-\d{4}$/);

    const lines = posted.body.journalEntry.lines;
    const totalDebit = lines.reduce((t, l) => t + Number(l.debit), 0);
    const totalCredit = lines.reduce((t, l) => t + Number(l.credit), 0);
    expect(totalDebit).toBe(totalCredit); // INV-1
    expect(totalDebit).toBe(120000);

    const fetched = await request(app).get(`/api/v1/invoices/${created.body.id}`).set(owner.headers);
    expect(fetched.body.status).toBe('posted');
    expect(fetched.body.grandTotal).toBe(posted.body.invoice.grandTotal); // INV-11
  });

  it('rounds the discount boundary correctly with no tax code', async () => {
    const created = await request(app)
      .post('/api/v1/invoices')
      .set(owner.headers)
      .send(
        invoiceBody({
          docDate: '2025-07-21',
          lines: [{ accountId: salesAccount.id, description: 'Backpacks', quantity: 3, unitPrice: '1250.50', discountPct: 5 }],
        })
      );

    expect(created.status).toBe(201);
    expect(created.body.taxAmount).toBe('0.00');
    expect(created.body.discountAmount).toBe('187.58'); // 187.575 rounds half-up
    expect(created.body.grandTotal).toBe('3563.92');
  });

  it('applies VAT end to end through the API and credits the tax account', async () => {
    const taxCode = await prisma.taxCode.findFirstOrThrow({ where: { organizationId: owner.orgId, code: 'VAT13' } });
    const vatAccount = await prisma.account.findFirstOrThrow({ where: { organizationId: owner.orgId, code: '2200' } });

    const created = await request(app)
      .post('/api/v1/invoices')
      .set(owner.headers)
      .send(
        invoiceBody({
          docDate: '2025-07-28',
          lines: [
            { accountId: salesAccount.id, description: 'Trekking backpacks', quantity: 15, unitPrice: 8000, taxCodeId: taxCode.id },
          ],
        })
      );

    expect(created.status).toBe(201);
    expect(created.body.taxableAmount).toBe('120000.00');
    expect(created.body.taxAmount).toBe('15600.00');
    expect(created.body.grandTotal).toBe('135600.00');

    const posted = await request(app).post(`/api/v1/invoices/${created.body.id}/post`).set(owner.headers).send();
    expect(posted.status).toBe(200);

    const lines = posted.body.journalEntry.lines;
    const vatLine = lines.find((l) => l.accountId === vatAccount.id);
    const salesLine = lines.find((l) => l.accountId === salesAccount.id);

    expect(vatLine.credit).toBe('15600.00');
    expect(salesLine.credit).toBe('120000.00');
    expect(lines.reduce((t, l) => t + Number(l.debit), 0)).toBe(135600);
    expect(lines.reduce((t, l) => t + Number(l.credit), 0)).toBe(135600);
  });
});

describe('PATCH /invoices/:id — optimistic concurrency', () => {
  it('recomputes on a valid version and rejects a stale one with 409', async () => {
    const created = await request(app).post('/api/v1/invoices').set(owner.headers).send(invoiceBody({ docDate: '2025-07-22' }));

    const updated = await request(app)
      .patch(`/api/v1/invoices/${created.body.id}`)
      .set(owner.headers)
      .send({ version: 0, lines: [{ accountId: salesAccount.id, description: 'Backpacks', quantity: 1, unitPrice: 8000 }] });
    expect(updated.status).toBe(200);
    expect(updated.body.version).toBe(1);
    expect(updated.body.grandTotal).toBe('8000.00');

    const stale = await request(app)
      .patch(`/api/v1/invoices/${created.body.id}`)
      .set(owner.headers)
      .send({ version: 0, lines: [{ accountId: salesAccount.id, description: 'Backpacks', quantity: 2, unitPrice: 8000 }] });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('version_conflict');
  });
});

describe('GET /invoices/:id/payments', () => {
  it('returns allocated receipts and the recalculated outstanding amount', async () => {
    const bankAccount = await prisma.account.create({
      data: {
        organizationId: owner.orgId,
        code: `102${Date.now().toString().slice(-3)}`,
        name: 'Nabil Current for payment history',
        type: 'ASSET',
        isBankAccount: true,
      },
    });
    const created = await request(app).post('/api/v1/invoices').set(owner.headers).send(invoiceBody({ docDate: '2025-07-29' }));
    await request(app).post(`/api/v1/invoices/${created.body.id}/post`).set(owner.headers).send();
    const receipt = await request(app).post('/api/v1/receipts').set(owner.headers).send({
      partyId: party.id,
      docDate: '2025-07-30',
      depositAccountId: bankAccount.id,
      amount: '50000.00',
      referenceNo: 'BNK-93',
      allocations: [{ invoiceId: created.body.id, amount: '50000.00' }],
    });
    expect(receipt.status).toBe(201);

    const response = await request(app).get(`/api/v1/invoices/${created.body.id}/payments`).set(owner.headers);

    expect(response.status).toBe(200);
    expect(response.body.outstandingAmount).toBe('70000.00');
    expect(response.body.payments).toEqual([
      expect.objectContaining({
        receiptId: receipt.body.receipt.id,
        receiptNo: receipt.body.receipt.docNo,
        docDate: '2025-07-30',
        referenceNo: 'BNK-93',
        amount: '50000.00',
      }),
    ]);
  });
});

describe('period locking, enforced at the API', () => {
  it('rejects posting into a locked period', async () => {
    const created = await request(app)
      .post('/api/v1/invoices')
      .set(owner.headers)
      .send(invoiceBody({ docDate: '2025-08-20' })); // falls in the closed period

    const posted = await request(app).post(`/api/v1/invoices/${created.body.id}/post`).set(owner.headers).send();
    expect(posted.status).toBe(422);
    expect(posted.body.error.code).toBe('period_locked');
  });
});

describe('GET /reports/trial-balance', () => {
  it('is self-balancing after posting', async () => {
    const created = await request(app).post('/api/v1/invoices').set(owner.headers).send(invoiceBody({ docDate: '2025-07-23' }));
    await request(app).post(`/api/v1/invoices/${created.body.id}/post`).set(owner.headers).send();

    const tb = await request(app).get('/api/v1/reports/trial-balance').set(owner.headers);
    expect(tb.status).toBe(200);
    expect(tb.body.integrity.balanced).toBe(true);
    expect(tb.body.totals.debit).toBe(tb.body.totals.credit);

    const ar = tb.body.rows.find((r) => r.code === '1100');
    const sales = tb.body.rows.find((r) => r.code === '4100');
    expect(Number(ar.debitBalance)).toBeGreaterThan(0);
    expect(Number(sales.creditBalance)).toBeGreaterThan(0);
  });

  it('PERM-4: a Viewer can read the trial balance', async () => {
    const res = await request(app).get('/api/v1/reports/trial-balance').set(viewer);
    expect(res.status).toBe(200);
  });
});

describe('permissions on the invoice lifecycle', () => {
  it('PERM-1: a Clerk may draft an invoice', async () => {
    const res = await request(app).post('/api/v1/invoices').set(clerk).send(invoiceBody({ docDate: '2025-07-24' }));
    expect(res.status).toBe(201);
  });

  it('PERM-2: a Clerk cannot post an invoice', async () => {
    const created = await request(app).post('/api/v1/invoices').set(clerk).send(invoiceBody({ docDate: '2025-07-25' }));
    const posted = await request(app).post(`/api/v1/invoices/${created.body.id}/post`).set(clerk).send();
    expect(posted.status).toBe(403);
    expect(posted.body.error.code).toBe('forbidden'); // authorize() reports the generic 'forbidden' code
  });

  it('PERM-3: a Viewer cannot create an invoice', async () => {
    const res = await request(app).post('/api/v1/invoices').set(viewer).send(invoiceBody({ docDate: '2025-07-26' }));
    expect(res.status).toBe(403);
  });
});

describe('manual journal entries', () => {
  it('posts a balanced manual JV', async () => {
    const res = await request(app)
      .post('/api/v1/journal-entries')
      .set(owner.headers)
      .send({
        entryDate: '2025-07-27',
        narration: 'Correcting a misclassified expense',
        lines: [
          { accountId: salesAccount.id, debit: 0, credit: 100 },
          { accountId: salesAccount.id, debit: 100, credit: 0 },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('posted');
    expect(res.body.entryNumber).toMatch(/^JE-2082-\d{4}$/);
  });

  it('PERM-6: rejects a manual entry that touches a control account', async () => {
    const arAccount = await prisma.account.findFirstOrThrow({ where: { organizationId: owner.orgId, code: '1100' } });

    const res = await request(app)
      .post('/api/v1/journal-entries')
      .set(owner.headers)
      .send({
        entryDate: '2025-07-27',
        narration: 'Sneaking into AR directly',
        lines: [
          { accountId: arAccount.id, debit: 0, credit: 50 },
          { accountId: salesAccount.id, debit: 50, credit: 0 },
        ],
      });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('manual_entry_not_allowed_on_control_account');
  });
});

describe('tenant isolation on invoices', () => {
  it('ISO-1: a cross-tenant invoice id reads as 404, not 403', async () => {
    const bob = await makeUserWithOrg(app, 'bob@invoices.test', 'Bob Ventures');
    const res = await request(app).get(`/api/v1/invoices/00000000-0000-0000-0000-000000000000`).set(bob.headers);
    expect(res.status).toBe(404);
  });
});
