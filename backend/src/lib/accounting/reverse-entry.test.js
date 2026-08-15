import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../../app.js';
import { prisma } from '../../db/client.js';
import { resetDb, seedRoles, makeUserWithOrg } from '../../test/helpers.js';
import { dec } from '../money.js';

let owner, expenseAccount, bankAccount, salesAccount, party, fiscalYear;

beforeAll(async () => {
  await resetDb();
  await seedRoles();

  owner = await makeUserWithOrg(app, 'owner@reversal.test', 'Reversal Test Co');

  fiscalYear = await prisma.fiscalYear.create({
    data: { organizationId: owner.orgId, label: '2082/83', startDate: new Date('2025-07-16'), endDate: new Date('2026-07-15') },
  });
  await prisma.accountingPeriod.create({
    data: { fiscalYearId: fiscalYear.id, label: 'Shrawan', startDate: new Date('2025-07-16'), endDate: new Date('2025-08-15'), isOpen: true },
  });

  await prisma.account.create({
    data: { organizationId: owner.orgId, code: '1100', name: 'Accounts Receivable', type: 'ASSET', isControlAccount: true },
  });
  bankAccount = await prisma.account.create({
    data: { organizationId: owner.orgId, code: '1020', name: 'Bank — Nabil', type: 'ASSET', isBankAccount: true },
  });
  salesAccount = await prisma.account.create({
    data: { organizationId: owner.orgId, code: '4100', name: 'Sales Revenue', type: 'REVENUE' },
  });
  expenseAccount = await prisma.account.create({
    data: { organizationId: owner.orgId, code: '5900', name: 'Other Expenses', type: 'EXPENSE' },
  });
  party = await prisma.party.create({
    data: { organizationId: owner.orgId, type: 'CUSTOMER', code: 'CUS-001', name: 'Himalayan Trek Supplies' },
  });
});

afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

async function accountBalance(accountId) {
  const lines = await prisma.journalLine.findMany({ where: { accountId } });
  const debit = lines.reduce((t, l) => t.plus(l.debit), dec(0));
  const credit = lines.reduce((t, l) => t.plus(l.credit), dec(0));
  return debit.minus(credit).toNumber();
}

describe('POST /journal-entries/:id/reverse — INV-8', () => {
  it('nets to zero, preserves both entries, and produces the expected audit trail', async () => {
    const auditCountBefore = await prisma.auditLog.count({ where: { organizationId: owner.orgId } });
    const entryCountBefore = await prisma.journalEntry.count({ where: { organizationId: owner.orgId } });

    const posted = await request(app).post('/api/v1/journal-entries').set(owner.headers).send({
      entryDate: '2025-07-20',
      narration: 'Miscellaneous expense',
      lines: [
        { accountId: expenseAccount.id, debit: 12000, description: 'Misc expense' },
        { accountId: bankAccount.id, credit: 12000, description: 'Cash out' },
      ],
    });
    expect(posted.status).toBe(201);
    const originalId = posted.body.id;

    const response = await request(app)
      .post(`/api/v1/journal-entries/${originalId}/reverse`)
      .set(owner.headers)
      .send({ reason: 'posted to the wrong account', reversalDate: '2025-07-25' });

    expect(response.status).toBe(200);
    expect(response.body.original.status).toBe('reversed');
    expect(response.body.reversal.reversalOfId).toBe(originalId);
    expect(response.body.reversal.status).toBe('posted');

    // Net effect on both affected accounts is zero.
    expect(await accountBalance(expenseAccount.id)).toBe(0);
    expect(await accountBalance(bankAccount.id)).toBe(0);

    // Nothing deleted — both entries still exist.
    const entryCountAfter = await prisma.journalEntry.count({ where: { organizationId: owner.orgId } });
    expect(entryCountAfter).toBe(entryCountBefore + 2);

    // audit_log: journal_entry.posted (creation) + reversal_posted + marked_reversed = 3.
    const auditCountAfter = await prisma.auditLog.count({ where: { organizationId: owner.orgId } });
    expect(auditCountAfter).toBe(auditCountBefore + 3);
  });

  it('rejects reversing an already-reversed entry', async () => {
    const posted = await request(app).post('/api/v1/journal-entries').set(owner.headers).send({
      entryDate: '2025-07-21',
      narration: 'Second JV',
      lines: [
        { accountId: expenseAccount.id, debit: 500, description: 'Expense' },
        { accountId: bankAccount.id, credit: 500, description: 'Cash out' },
      ],
    });
    const id = posted.body.id;

    const first = await request(app).post(`/api/v1/journal-entries/${id}/reverse`).set(owner.headers).send({ reason: 'oops', reversalDate: '2025-07-25' });
    expect(first.status).toBe(200);

    const second = await request(app).post(`/api/v1/journal-entries/${id}/reverse`).set(owner.headers).send({ reason: 'again?', reversalDate: '2025-07-25' });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('already_reversed');
  });

  it('the DB trigger still blocks every other mutation on a posted entry', async () => {
    const posted = await request(app).post('/api/v1/journal-entries').set(owner.headers).send({
      entryDate: '2025-07-22',
      narration: 'Third JV',
      lines: [
        { accountId: expenseAccount.id, debit: 100, description: 'Expense' },
        { accountId: bankAccount.id, credit: 100, description: 'Cash out' },
      ],
    });
    const entry = await prisma.journalEntry.findUniqueOrThrow({ where: { id: posted.body.id } });

    await expect(
      prisma.journalEntry.update({ where: { id: entry.id }, data: { description: 'sneaky edit' } })
    ).rejects.toThrow(/immutable/i);

    const line = await prisma.journalLine.findFirstOrThrow({ where: { journalEntryId: entry.id } });
    await expect(prisma.journalLine.delete({ where: { id: line.id } })).rejects.toThrow(/immutable/i);
  });
});

describe('reverseEntry — cascade to source documents', () => {
  it('reversing a receipt restores the target invoice outstanding and removes the allocation', async () => {
    const invoiceRes = await request(app).post('/api/v1/invoices').set(owner.headers).send({
      partyId: party.id, docDate: '2025-07-23',
      lines: [{ accountId: salesAccount.id, description: 'Goods', quantity: 1, unitPrice: 10000 }],
    });
    const postRes = await request(app).post(`/api/v1/invoices/${invoiceRes.body.id}/post`).set(owner.headers).send();
    expect(postRes.status).toBe(200);
    const invoiceId = invoiceRes.body.id;

    const receiptRes = await request(app).post('/api/v1/receipts').set(owner.headers).send({
      partyId: party.id, docDate: '2025-07-24', depositAccountId: bankAccount.id, amount: 10000,
      allocations: [{ invoiceId, amount: 10000 }],
    });
    expect(receiptRes.status).toBe(201);

    const paidInvoice = await prisma.document.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(paidInvoice.status).toBe('PAID');
    expect(paidInvoice.outstandingAmount.toFixed(2)).toBe('0.00');

    const reverseRes = await request(app)
      .post(`/api/v1/journal-entries/${receiptRes.body.journalEntry.id}/reverse`)
      .set(owner.headers)
      .send({ reason: 'receipt recorded in error', reversalDate: '2025-07-25' });
    expect(reverseRes.status).toBe(200);

    const restoredInvoice = await prisma.document.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(restoredInvoice.status).toBe('POSTED');
    expect(restoredInvoice.outstandingAmount.toFixed(2)).toBe('10000.00');
    expect(restoredInvoice.allocatedAmount.toFixed(2)).toBe('0.00');

    const allocations = await prisma.paymentAllocation.findMany({ where: { targetDocumentId: invoiceId } });
    expect(allocations).toHaveLength(0);

    const reversedReceipt = await prisma.document.findUniqueOrThrow({ where: { id: receiptRes.body.receipt.id } });
    expect(reversedReceipt.status).toBe('REVERSED');
  });
});
