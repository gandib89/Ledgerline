import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
  it('buckets open invoices by days overdue and self-checks against the AR control account', async () => {
    // asOf 2025-11-15, 30-day credit terms baked into party.creditDays.
    await postInvoice('2025-11-10', 1000); // due 2025-12-10 -> not yet due -> current
    await postInvoice('2025-10-01', 2000); // due 2025-10-31 -> 15 days overdue -> 1-30
    await postInvoice('2025-07-20', 3000); // due 2025-08-19 -> 88 days overdue -> 61-90

    const res = await request(app).get('/api/v1/reports/ar-aging').query({ asOf: '2025-11-15' }).set(owner.headers);
    expect(res.status).toBe(200);

    const row = res.body.rows.find((r) => r.partyId === party.id);
    expect(row.buckets.current).toBe('1000.00');
    expect(row.buckets.d1_30).toBe('2000.00');
    expect(row.buckets.d61_90).toBe('3000.00');
    expect(row.total).toBe('6000.00');

    expect(res.body.integrity.balanced).toBe(true);
    expect(res.body.integrity.arControlBalance).toBe(res.body.totals.grandTotal);
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
