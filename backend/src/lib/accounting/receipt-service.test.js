import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../../db/client.js';
import { postDocument } from './post-document.js';
import { postReceipt } from './receipt-service.js';
import { computeLine, sumLines } from './line-math.js';
import { dec } from '../money.js';

async function resetDb() {
  await prisma.$executeRawUnsafe(`
    TRUNCATE
      "PaymentAllocation", "DocumentLine", "Document", "DocumentSeries", "EntrySeries",
      "JournalLine", "JournalEntry", "Account", "TaxCode", "Party",
      "AccountingPeriod", "FiscalYear", "Membership", "RolePermission",
      "Role", "Permission", "Organization", "User", "AuditLog", "IdempotencyKey"
    CASCADE
  `);
}

let org, fiscalYear, cashAccount, salesAccount, arAccount, party, actor;

beforeAll(async () => {
  await resetDb();

  org = await prisma.organization.create({ data: { name: 'Receipt Service Test Co' } });

  fiscalYear = await prisma.fiscalYear.create({
    data: { organizationId: org.id, label: '2082/83', startDate: new Date('2025-07-16'), endDate: new Date('2026-07-15') },
  });
  await prisma.accountingPeriod.create({
    data: { fiscalYearId: fiscalYear.id, label: 'Shrawan', startDate: new Date('2025-07-16'), endDate: new Date('2025-08-15'), isOpen: true },
  });

  arAccount = await prisma.account.create({
    data: { organizationId: org.id, code: '1100', name: 'Accounts Receivable', type: 'ASSET', isControlAccount: true },
  });
  cashAccount = await prisma.account.create({
    data: { organizationId: org.id, code: '1020', name: 'Bank — Nabil Bank Current', type: 'ASSET', isBankAccount: true },
  });
  salesAccount = await prisma.account.create({
    data: { organizationId: org.id, code: '4100', name: 'Sales Revenue', type: 'REVENUE' },
  });

  party = await prisma.party.create({
    data: { organizationId: org.id, type: 'CUSTOMER', code: 'CUS-001', name: 'Himalayan Trek Supplies' },
  });

  const postPermission = await prisma.permission.upsert({ where: { code: 'invoice.post' }, update: {}, create: { code: 'invoice.post' } });
  const payPermission = await prisma.permission.upsert({ where: { code: 'payment.create' }, update: {}, create: { code: 'payment.create' } });
  const role = await prisma.role.create({ data: { name: 'Poster' } });
  await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: postPermission.id } });
  await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: payPermission.id } });
  const user = await prisma.user.create({ data: { email: 'poster@receipts.test', passwordHash: 'x' } });
  await prisma.membership.create({ data: { userId: user.id, organizationId: org.id, roleId: role.id } });
  actor = { userId: user.id, organizationId: org.id, roleId: role.id };
});

afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

// Every test posts its own fresh invoice(s) rather than sharing one across
// tests — outstandingAmount is mutated by postReceipt, so shared fixtures
// would make tests order-dependent.
async function postInvoice({ docDate, quantity, unitPrice }) {
  const computed = computeLine({ quantity, unitPrice, discountPct: 0, taxRate: 0 });
  const totals = sumLines([computed]);
  const doc = await prisma.document.create({
    data: {
      organizationId: org.id, fiscalYearId: fiscalYear.id, docType: 'INVOICE', docDate, partyId: party.id, status: 'DRAFT',
      subtotal: totals.subtotal, discountAmount: totals.discountAmount, taxableAmount: totals.taxableAmount,
      taxAmount: totals.taxAmount, grandTotal: totals.grandTotal,
      lines: { create: [{ lineNo: 1, description: 'Line 1', accountId: salesAccount.id, quantity, unitPrice, discountPct: 0, taxableAmount: computed.taxableAmount, taxAmount: computed.taxAmount, lineTotal: computed.lineTotal }] },
    },
  });
  await postDocument(doc.id, actor);
  return prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
}

describe('postReceipt — happy path', () => {
  it('posts a fully allocated receipt: Dr Bank / Cr AR, invoice flips to PAID', async () => {
    const invoice = await postInvoice({ docDate: new Date('2025-07-20'), quantity: 1, unitPrice: '135600.00' });

    const { document, journalEntry, allocations } = await postReceipt(actor, {
      partyId: party.id, docDate: '2025-07-25', depositAccountId: cashAccount.id, amount: 135600,
      allocations: [{ invoiceId: invoice.id, amount: 135600 }],
    });

    expect(document.status).toBe('POSTED');
    expect(document.docNo).toMatch(/^RCP-2082-\d{4}$/);
    expect(document.outstandingAmount.toFixed(2)).toBe('0.00');
    expect(allocations).toEqual([{ invoiceId: invoice.id, amount: '135600.00', invoiceOutstandingAfter: '0.00' }]);

    const lines = await prisma.journalLine.findMany({ where: { journalEntryId: journalEntry.id } });
    const bankLine = lines.find((l) => l.accountId === cashAccount.id);
    const arLine = lines.find((l) => l.accountId === arAccount.id);
    expect(bankLine.debit.toFixed(2)).toBe('135600.00');
    expect(arLine.credit.toFixed(2)).toBe('135600.00');
    expect(arLine.partyId).toBe(party.id);

    const updatedInvoice = await prisma.document.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(updatedInvoice.status).toBe('PAID');
    expect(updatedInvoice.outstandingAmount.toFixed(2)).toBe('0.00');
  });

  it('splits one receipt across two invoices and leaves an unallocated advance', async () => {
    const inv1 = await postInvoice({ docDate: new Date('2025-07-21'), quantity: 1, unitPrice: '50000.00' });
    const inv2 = await postInvoice({ docDate: new Date('2025-07-21'), quantity: 1, unitPrice: '30000.00' });

    const { document, allocations } = await postReceipt(actor, {
      partyId: party.id, docDate: '2025-07-26', depositAccountId: cashAccount.id, amount: 90000,
      allocations: [{ invoiceId: inv1.id, amount: 50000 }, { invoiceId: inv2.id, amount: 20000 }],
    });

    expect(document.outstandingAmount.toFixed(2)).toBe('20000.00'); // 90000 - 70000 unapplied advance
    expect(allocations).toHaveLength(2);

    const updated1 = await prisma.document.findUniqueOrThrow({ where: { id: inv1.id } });
    const updated2 = await prisma.document.findUniqueOrThrow({ where: { id: inv2.id } });
    expect(updated1.status).toBe('PAID');
    expect(updated2.outstandingAmount.toFixed(2)).toBe('10000.00');
    expect(updated2.status).toBe('PARTIALLY_PAID');
  });

  it('allows a pure advance with zero allocations', async () => {
    const { document } = await postReceipt(actor, {
      partyId: party.id, docDate: '2025-07-27', depositAccountId: cashAccount.id, amount: 5000, allocations: [],
    });
    expect(document.outstandingAmount.toFixed(2)).toBe('5000.00');
    expect(document.allocatedAmount.toFixed(2)).toBe('0.00');
  });
});

describe('postReceipt — INV-7: over-allocation is impossible', () => {
  it('rejects an allocation exceeding the invoice outstanding, writes nothing', async () => {
    const invoice = await postInvoice({ docDate: new Date('2025-07-22'), quantity: 1, unitPrice: '135600.00' });
    const receiptCountBefore = await prisma.document.count({ where: { docType: 'RECEIPT' } });

    await postReceipt(actor, {
      partyId: party.id, docDate: '2025-07-28', depositAccountId: cashAccount.id, amount: 100000,
      allocations: [{ invoiceId: invoice.id, amount: 100000 }],
    });

    const afterFirst = await prisma.document.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(afterFirst.outstandingAmount.toFixed(2)).toBe('35600.00');

    await expect(
      postReceipt(actor, {
        partyId: party.id, docDate: '2025-07-28', depositAccountId: cashAccount.id, amount: 40000,
        allocations: [{ invoiceId: invoice.id, amount: 40000 }],
      })
    ).rejects.toMatchObject({ status: 422, code: 'over_allocation' });

    const untouched = await prisma.document.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(untouched.outstandingAmount.toFixed(2)).toBe('35600.00'); // unchanged

    // Only the first (successful) receipt got written — the rejected
    // attempt created no Document row at all (transaction rolled back).
    const receiptCountAfter = await prisma.document.count({ where: { docType: 'RECEIPT' } });
    expect(receiptCountAfter).toBe(receiptCountBefore + 1);
  });
});

describe('postReceipt — CONC-1: concurrent over-allocation is impossible', () => {
  it('exactly 3 of 5 concurrent 30,000 receipts succeed against a 100,000 outstanding invoice', async () => {
    const invoice = await postInvoice({ docDate: new Date('2025-07-23'), quantity: 1, unitPrice: '100000.00' });

    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        postReceipt(actor, {
          partyId: party.id, docDate: '2025-07-29', depositAccountId: cashAccount.id, amount: 30000,
          allocations: [{ invoiceId: invoice.id, amount: 30000 }],
        })
      )
    );

    const fulfilled = attempts.filter((a) => a.status === 'fulfilled');
    const rejected = attempts.filter((a) => a.status === 'rejected');
    expect(fulfilled).toHaveLength(3);
    expect(rejected).toHaveLength(2);
    for (const r of rejected) {
      expect(r.reason).toMatchObject({ status: 422, code: 'over_allocation' });
    }

    const finalInvoice = await prisma.document.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(finalInvoice.outstandingAmount.toFixed(2)).toBe('10000.00');

    const allocations = await prisma.paymentAllocation.findMany({ where: { targetDocumentId: invoice.id } });
    const allocatedTotal = allocations.reduce((t, a) => t.plus(a.amount), dec(0));
    expect(allocatedTotal.toFixed(2)).toBe('90000.00');

    // The ledger is still balanced (INV-2 style global check).
    const allLines = await prisma.journalLine.findMany({ where: { organizationId: org.id } });
    const totalDebit = allLines.reduce((t, l) => t.plus(l.debit), dec(0));
    const totalCredit = allLines.reduce((t, l) => t.plus(l.credit), dec(0));
    expect(totalDebit.toFixed(4)).toBe(totalCredit.toFixed(4));
  });
});
