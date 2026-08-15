import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../../db/client.js';
import { postDocument } from './post-document.js';
import { postCreditNote } from './credit-note-service.js';
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

let org, fiscalYear, salesAccount, vatAccount, taxCode, party, actor;

beforeAll(async () => {
  await resetDb();

  org = await prisma.organization.create({ data: { name: 'Credit Note Service Test Co' } });
  fiscalYear = await prisma.fiscalYear.create({
    data: { organizationId: org.id, label: '2082/83', startDate: new Date('2025-07-16'), endDate: new Date('2026-07-15') },
  });
  await prisma.accountingPeriod.create({
    data: { fiscalYearId: fiscalYear.id, label: 'Shrawan', startDate: new Date('2025-07-16'), endDate: new Date('2025-08-15'), isOpen: true },
  });

  await prisma.account.create({ data: { organizationId: org.id, code: '1100', name: 'Accounts Receivable', type: 'ASSET', isControlAccount: true } });
  salesAccount = await prisma.account.create({ data: { organizationId: org.id, code: '4100', name: 'Sales Revenue', type: 'REVENUE' } });
  vatAccount = await prisma.account.create({ data: { organizationId: org.id, code: '2200', name: 'VAT Payable (Output)', type: 'LIABILITY', isControlAccount: true } });
  taxCode = await prisma.taxCode.create({ data: { organizationId: org.id, code: 'VAT13', name: 'VAT 13%', rate: '0.1300', type: 'VAT', outputAccountId: vatAccount.id } });
  party = await prisma.party.create({ data: { organizationId: org.id, type: 'CUSTOMER', code: 'CUS-001', name: 'Himalayan Trek Supplies' } });

  const postPermission = await prisma.permission.upsert({ where: { code: 'invoice.post' }, update: {}, create: { code: 'invoice.post' } });
  const role = await prisma.role.create({ data: { name: 'Poster' } });
  await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: postPermission.id } });
  const user = await prisma.user.create({ data: { email: 'poster@creditnotes.test', passwordHash: 'x' } });
  await prisma.membership.create({ data: { userId: user.id, organizationId: org.id, roleId: role.id } });
  actor = { userId: user.id, organizationId: org.id, roleId: role.id };
});

afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

async function postInvoice({ docDate, quantity, unitPrice }) {
  const computed = computeLine({ quantity, unitPrice, discountPct: 0, taxRate: '0.13' });
  const totals = sumLines([computed]);
  const doc = await prisma.document.create({
    data: {
      organizationId: org.id, fiscalYearId: fiscalYear.id, docType: 'INVOICE', docDate, partyId: party.id, status: 'DRAFT',
      subtotal: totals.subtotal, discountAmount: totals.discountAmount, taxableAmount: totals.taxableAmount,
      taxAmount: totals.taxAmount, grandTotal: totals.grandTotal,
      lines: { create: [{ lineNo: 1, description: 'Trekking backpacks', accountId: salesAccount.id, quantity, unitPrice, discountPct: 0, taxCodeId: taxCode.id, taxableAmount: computed.taxableAmount, taxAmount: computed.taxAmount, lineTotal: computed.lineTotal }] },
    },
  });
  await postDocument(doc.id, actor);
  return prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
}

describe('postCreditNote', () => {
  it('posts the mirror image of the invoice entry and reduces outstanding, leaving grandTotal untouched (§6 worked example 4)', async () => {
    // 15 backpacks @ 8000, 13% VAT -> 135600.00 grand total.
    const invoice = await postInvoice({ docDate: new Date('2025-07-20'), quantity: 15, unitPrice: '8000.00' });
    expect(invoice.grandTotal.toFixed(2)).toBe('135600.00');

    // Return 2 backpacks: 2 * 8000 = 16000 + 13% VAT (2080) = 18080.00.
    const { document, journalEntry, invoice: updatedInvoice } = await postCreditNote(actor, {
      invoiceId: invoice.id, docDate: '2025-08-01',
      lines: [{ accountId: salesAccount.id, description: 'Returned backpacks', quantity: 2, unitPrice: '8000.00', taxCodeId: taxCode.id }],
    });

    expect(document.status).toBe('POSTED');
    expect(document.docNo).toMatch(/^CN-2082-\d{4}$/);
    expect(document.parentDocumentId).toBe(invoice.id);
    expect(document.grandTotal.toFixed(2)).toBe('18080.00');

    const lines = await prisma.journalLine.findMany({ where: { journalEntryId: journalEntry.id } });
    const revenueLine = lines.find((l) => l.accountId === salesAccount.id);
    const vatLine = lines.find((l) => l.accountId === vatAccount.id);
    const arLine = lines.find((l) => l.description === 'Accounts Receivable');

    // Mirror image of the invoice: Dr revenue / Dr VAT, Cr AR.
    expect(revenueLine.debit.toFixed(2)).toBe('16000.00');
    expect(revenueLine.credit.toFixed(2)).toBe('0.00');
    expect(vatLine.debit.toFixed(2)).toBe('2080.00');
    expect(arLine.credit.toFixed(2)).toBe('18080.00');
    expect(arLine.partyId).toBe(party.id);

    const totalDebit = lines.reduce((t, l) => t.plus(l.debit), dec(0));
    const totalCredit = lines.reduce((t, l) => t.plus(l.credit), dec(0));
    expect(totalDebit.toFixed(2)).toBe(totalCredit.toFixed(2));

    // The invoice itself is untouched: grand total stays 135600, only
    // outstanding drops. 135600 - 18080 = 117520.
    expect(updatedInvoice.grandTotal.toFixed(2)).toBe('135600.00');
    expect(updatedInvoice.outstandingAmount.toFixed(2)).toBe('117520.00');
    expect(updatedInvoice.status).toBe('PARTIALLY_PAID');

    const reloadedInvoice = await prisma.document.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(reloadedInvoice.grandTotal.toFixed(2)).toBe('135600.00');
  });

  it('rejects a credit note larger than the invoice outstanding', async () => {
    const invoice = await postInvoice({ docDate: new Date('2025-07-21'), quantity: 1, unitPrice: '1000.00' });

    await expect(
      postCreditNote(actor, {
        invoiceId: invoice.id, docDate: '2025-08-02',
        lines: [{ accountId: salesAccount.id, description: 'Over-credit', quantity: 10, unitPrice: '1000.00', taxCodeId: taxCode.id }],
      })
    ).rejects.toMatchObject({ status: 422, code: 'credit_exceeds_outstanding' });

    const untouched = await prisma.document.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(untouched.outstandingAmount.toFixed(2)).toBe(untouched.grandTotal.toFixed(2)); // unchanged
  });
});
