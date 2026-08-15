import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { prisma } from '../db/client.js';
import { resetDb, seedRoles, makeUserWithOrg } from '../test/helpers.js';
import { dec } from '../lib/money.js';

let owner, otherOrg, bankAccount, salesAccount, party;

beforeAll(async () => {
  await resetDb();
  await seedRoles();

  owner = await makeUserWithOrg(app, 'owner@receipts.test', 'Receipts Test Co');
  otherOrg = await makeUserWithOrg(app, 'owner@other-receipts.test', 'Other Receipts Co');

  const fiscalYear = await prisma.fiscalYear.create({
    data: { organizationId: owner.orgId, label: '2082/83', startDate: new Date('2025-07-16'), endDate: new Date('2026-07-15') },
  });
  await prisma.accountingPeriod.create({
    data: { fiscalYearId: fiscalYear.id, label: 'Shrawan', startDate: new Date('2025-07-16'), endDate: new Date('2025-08-15'), isOpen: true },
  });

  await prisma.account.create({ data: { organizationId: owner.orgId, code: '1100', name: 'Accounts Receivable', type: 'ASSET', isControlAccount: true } });
  bankAccount = await prisma.account.create({ data: { organizationId: owner.orgId, code: '1020', name: 'Bank — Nabil', type: 'ASSET', isBankAccount: true } });
  salesAccount = await prisma.account.create({ data: { organizationId: owner.orgId, code: '4100', name: 'Sales Revenue', type: 'REVENUE' } });
  party = await prisma.party.create({ data: { organizationId: owner.orgId, type: 'CUSTOMER', code: 'CUS-001', name: 'Himalayan Trek Supplies' } });

  // Give the second org the same shape so IDEM-3 has something to post against.
  const otherFiscalYear = await prisma.fiscalYear.create({
    data: { organizationId: otherOrg.orgId, label: '2082/83', startDate: new Date('2025-07-16'), endDate: new Date('2026-07-15') },
  });
  await prisma.accountingPeriod.create({
    data: { fiscalYearId: otherFiscalYear.id, label: 'Shrawan', startDate: new Date('2025-07-16'), endDate: new Date('2025-08-15'), isOpen: true },
  });
  await prisma.account.create({ data: { organizationId: otherOrg.orgId, code: '1100', name: 'Accounts Receivable', type: 'ASSET', isControlAccount: true } });
  const otherBank = await prisma.account.create({ data: { organizationId: otherOrg.orgId, code: '1020', name: 'Bank', type: 'ASSET', isBankAccount: true } });
  const otherParty = await prisma.party.create({ data: { organizationId: otherOrg.orgId, type: 'CUSTOMER', code: 'CUS-001', name: 'Other Co Customer' } });
  otherOrg.bankAccountId = otherBank.id;
  otherOrg.partyId = otherParty.id;
});

afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

async function postAndPostInvoice(headers, amount) {
  const created = await request(app).post('/api/v1/invoices').set(headers).send({
    partyId: party.id, docDate: '2025-07-20',
    lines: [{ accountId: salesAccount.id, description: 'Goods', quantity: 1, unitPrice: amount }],
  });
  await request(app).post(`/api/v1/invoices/${created.body.id}/post`).set(headers).send();
  return created.body.id;
}

describe('POST /receipts — idempotency (IDEM-1..3)', () => {
  it('IDEM-1: the same key posted twice creates one payment; the replay is identical and flagged', async () => {
    const invoiceId = await postAndPostInvoice(owner.headers, 5000);
    const body = { partyId: party.id, docDate: '2025-07-21', depositAccountId: bankAccount.id, amount: 5000, allocations: [{ invoiceId, amount: 5000 }] };
    const key = 'idem-key-1';

    const first = await request(app).post('/api/v1/receipts').set(owner.headers).set('Idempotency-Key', key).send(body);
    expect(first.status).toBe(201);
    expect(first.headers['idempotent-replay']).toBeUndefined();

    const second = await request(app).post('/api/v1/receipts').set(owner.headers).set('Idempotency-Key', key).send(body);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.body).toEqual(first.body);

    const receipts = await prisma.document.count({ where: { organizationId: owner.orgId, docType: 'RECEIPT', docNo: first.body.receipt.docNo } });
    expect(receipts).toBe(1);
  });

  it('IDEM-2: the same key with a different body is rejected', async () => {
    const invoiceId = await postAndPostInvoice(owner.headers, 3000);
    const key = 'idem-key-2';

    const first = await request(app).post('/api/v1/receipts').set(owner.headers).set('Idempotency-Key', key).send({
      partyId: party.id, docDate: '2025-07-22', depositAccountId: bankAccount.id, amount: 3000, allocations: [{ invoiceId, amount: 3000 }],
    });
    expect(first.status).toBe(201);

    const second = await request(app).post('/api/v1/receipts').set(owner.headers).set('Idempotency-Key', key).send({
      partyId: party.id, docDate: '2025-07-22', depositAccountId: bankAccount.id, amount: 999, allocations: [],
    });
    expect(second.status).toBe(422);
    expect(second.body.error.code).toBe('idempotency_key_reuse');
  });

  it('IDEM-3: the same key value reused by a different org is treated as a new request', async () => {
    const invoiceId = await postAndPostInvoice(owner.headers, 1500);
    const key = 'idem-key-shared-across-orgs';

    const first = await request(app).post('/api/v1/receipts').set(owner.headers).set('Idempotency-Key', key).send({
      partyId: party.id, docDate: '2025-07-23', depositAccountId: bankAccount.id, amount: 1500, allocations: [{ invoiceId, amount: 1500 }],
    });
    expect(first.status).toBe(201);

    const second = await request(app).post('/api/v1/receipts').set(otherOrg.headers).set('Idempotency-Key', key).send({
      partyId: otherOrg.partyId, docDate: '2025-07-23', depositAccountId: otherOrg.bankAccountId, amount: 250, allocations: [],
    });
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replay']).toBeUndefined();
    expect(second.body.receipt.id).not.toBe(first.body.receipt.id);
  });
});

describe('INV-3: subledger equals the general ledger after a partial receipt', () => {
  it('Σ open-invoice outstanding equals the AR control account balance', async () => {
    const invoiceId = await postAndPostInvoice(owner.headers, 20000);
    await request(app).post('/api/v1/receipts').set(owner.headers).send({
      partyId: party.id, docDate: '2025-07-24', depositAccountId: bankAccount.id, amount: 8000, allocations: [{ invoiceId, amount: 8000 }],
    });

    const openInvoices = await prisma.document.findMany({
      where: { organizationId: owner.orgId, docType: 'INVOICE', status: { not: 'REVERSED' } },
    });
    const subledgerTotal = openInvoices.reduce((t, d) => t.plus(d.outstandingAmount), dec(0));

    const [arRow] = await prisma.$queryRaw`
      SELECT COALESCE(SUM(jl.debit), 0) AS total_debit, COALESCE(SUM(jl.credit), 0) AS total_credit
      FROM "JournalLine" jl JOIN "Account" a ON a.id = jl."accountId"
      WHERE jl."organizationId" = ${owner.orgId} AND a.code = '1100'
    `;
    const ledgerBalance = dec(arRow.total_debit).minus(arRow.total_credit);

    expect(subledgerTotal.toFixed(4)).toBe(ledgerBalance.toFixed(4));
  });
});
