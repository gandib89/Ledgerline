import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { prisma } from '../db/client.js';
import { resetDb, seedRoles, makeUserWithOrg } from './helpers.js';

// CONC-1 / CONC-2 (§10): row locks (FOR UPDATE on the invoice for
// allocation, on DocumentSeries for numbering) must serialize concurrent
// requests correctly — Promise.all is the only way to prove that; sequential
// awaits would never touch the race at all.
let owner, bankAccount, salesAccount, party;

beforeAll(async () => {
  await resetDb();
  await seedRoles();
  owner = await makeUserWithOrg(app, 'owner@concurrency.test', 'Concurrency Test Co');

  const fiscalYear = await prisma.fiscalYear.create({
    data: { organizationId: owner.orgId, label: '2082/83', startDate: new Date('2025-07-16'), endDate: new Date('2026-07-15') },
  });
  await prisma.accountingPeriod.create({
    data: { fiscalYearId: fiscalYear.id, label: '2082/83', startDate: new Date('2025-07-16'), endDate: new Date('2026-07-15'), isOpen: true },
  });

  await prisma.account.create({ data: { organizationId: owner.orgId, code: '1100', name: 'Accounts Receivable', type: 'ASSET', isControlAccount: true } });
  bankAccount = await prisma.account.create({ data: { organizationId: owner.orgId, code: '1020', name: 'Bank', type: 'ASSET', isBankAccount: true } });
  salesAccount = await prisma.account.create({ data: { organizationId: owner.orgId, code: '4100', name: 'Sales Revenue', type: 'REVENUE' } });
  party = await prisma.party.create({ data: { organizationId: owner.orgId, type: 'CUSTOMER', code: 'CUS-001', name: 'Concurrency Test Customer' } });
});

afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

describe('CONC-1: concurrent over-allocation is impossible', () => {
  it('5 receipts x 30,000 against 100,000 outstanding -> exactly 3 succeed, 2 refused, ledger stays balanced', async () => {
    const created = await request(app).post('/api/v1/invoices').set(owner.headers).send({
      partyId: party.id, docDate: '2025-09-05',
      lines: [{ accountId: salesAccount.id, description: 'Concurrency test goods', quantity: 1, unitPrice: 100000 }],
    });
    const posted = await request(app).post(`/api/v1/invoices/${created.body.id}/post`).set(owner.headers).send();
    expect(posted.status).toBe(200);
    const invoiceId = created.body.id;

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app).post('/api/v1/receipts').set(owner.headers).send({
          partyId: party.id, docDate: '2025-09-06', depositAccountId: bankAccount.id, amount: 30000,
          allocations: [{ invoiceId, amount: 30000 }],
        })
      )
    );

    const succeeded = results.filter((r) => r.status === 201);
    const refused = results.filter((r) => r.status === 422);
    expect(succeeded).toHaveLength(3);
    expect(refused).toHaveLength(2);
    expect(refused.every((r) => r.body.error.code === 'over_allocation')).toBe(true);

    const invoice = await prisma.document.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.outstandingAmount.toFixed(2)).toBe('10000.00');

    const allocations = await prisma.paymentAllocation.findMany({ where: { targetDocumentId: invoiceId } });
    const allocatedTotal = allocations.reduce((t, a) => t + Number(a.amount), 0);
    expect(allocatedTotal).toBe(90000);

    const [arRow] = await prisma.$queryRaw`
      SELECT COALESCE(SUM(jl.debit), 0) AS total_debit, COALESCE(SUM(jl.credit), 0) AS total_credit
      FROM "JournalLine" jl WHERE jl."organizationId" = ${owner.orgId}
    `;
    expect((Number(arRow.total_debit) - Number(arRow.total_credit)).toFixed(4)).toBe('0.0000'); // ledger still balanced
  });
});

describe('CONC-2: concurrent invoice posting produces distinct, gap-free doc numbers', () => {
  it('10 concurrent posts -> 10 distinct sequential doc numbers, no gaps, no duplicates', async () => {
    const drafts = [];
    for (let i = 0; i < 10; i += 1) {
      const created = await request(app).post('/api/v1/invoices').set(owner.headers).send({
        partyId: party.id, docDate: '2025-09-10',
        lines: [{ accountId: salesAccount.id, description: `Concurrency post ${i}`, quantity: 1, unitPrice: 100 }],
      });
      expect(created.status).toBe(201);
      drafts.push(created.body.id);
    }

    const results = await Promise.all(
      drafts.map((id) => request(app).post(`/api/v1/invoices/${id}/post`).set(owner.headers).send())
    );

    expect(results.every((r) => r.status === 200)).toBe(true);
    const docNumbers = results.map((r) => r.body.invoice.docNo);
    expect(new Set(docNumbers).size).toBe(10); // no duplicates

    const suffixes = docNumbers.map((n) => Number(n.match(/-(\d+)$/)[1])).sort((a, b) => a - b);
    const min = suffixes[0];
    expect(suffixes).toEqual(Array.from({ length: 10 }, (_, i) => min + i)); // no gaps, contiguous
  });
});
