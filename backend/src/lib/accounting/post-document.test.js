import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../../db/client.js';
import { postDocument } from './post-document.js';
import { computeLine, sumLines } from './line-math.js';
import { dec } from '../money.js';

// TRUNCATE, not DELETE: the immutability trigger blocks row-level DELETE on
// JournalEntry/JournalLine, but TRUNCATE doesn't fire row-level triggers.
async function resetDb() {
  await prisma.$executeRawUnsafe(`
    TRUNCATE
      "DocumentLine", "Document", "DocumentSeries", "EntrySeries",
      "JournalLine", "JournalEntry", "Account", "TaxCode", "Party",
      "AccountingPeriod", "FiscalYear", "Membership", "RolePermission",
      "Role", "Permission", "Organization", "User", "AuditLog", "IdempotencyKey"
    CASCADE
  `);
}

let org, fiscalYear, salesAccount, vatAccount, taxCode, party, actor, noPermActor;

beforeAll(async () => {
  await resetDb();

  org = await prisma.organization.create({ data: { name: 'Post Document Test Co' } });

  fiscalYear = await prisma.fiscalYear.create({
    data: {
      organizationId: org.id,
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
    data: { organizationId: org.id, code: '1100', name: 'Accounts Receivable', type: 'ASSET', isControlAccount: true },
  });
  salesAccount = await prisma.account.create({
    data: { organizationId: org.id, code: '4100', name: 'Sales Revenue', type: 'REVENUE' },
  });
  vatAccount = await prisma.account.create({
    data: { organizationId: org.id, code: '2200', name: 'VAT Payable (Output)', type: 'LIABILITY', isControlAccount: true },
  });

  taxCode = await prisma.taxCode.create({
    data: { organizationId: org.id, code: 'VAT13', name: 'VAT 13%', rate: '0.1300', type: 'VAT', outputAccountId: vatAccount.id },
  });

  party = await prisma.party.create({
    data: { organizationId: org.id, type: 'CUSTOMER', code: 'CUS-001', name: 'Himalayan Trek Supplies Pvt. Ltd.' },
  });

  const postPermission = await prisma.permission.upsert({
    where: { code: 'invoice.post' },
    update: {},
    create: { code: 'invoice.post' },
  });
  const posterRole = await prisma.role.create({ data: { name: 'Poster' } });
  await prisma.rolePermission.create({ data: { roleId: posterRole.id, permissionId: postPermission.id } });
  const posterUser = await prisma.user.create({ data: { email: 'poster@test.local', passwordHash: 'x' } });
  await prisma.membership.create({ data: { userId: posterUser.id, organizationId: org.id, roleId: posterRole.id } });
  actor = { userId: posterUser.id, organizationId: org.id, roleId: posterRole.id };

  const bystanderRole = await prisma.role.create({ data: { name: 'Bystander' } });
  const bystanderUser = await prisma.user.create({ data: { email: 'bystander@test.local', passwordHash: 'x' } });
  await prisma.membership.create({ data: { userId: bystanderUser.id, organizationId: org.id, roleId: bystanderRole.id } });
  noPermActor = { userId: bystanderUser.id, organizationId: org.id, roleId: bystanderRole.id };
});

afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

// Draft a document whose lines are already computed via computeLine, mirroring
// what the invoice service (Day 3 step 5) will do at create/update time —
// postDocument itself never recomputes qty * rate, only reads what's stored.
async function makeDraftInvoice({ docDate, lineInputs, grandTotalOverride }) {
  const computed = lineInputs.map((input) => ({ input, computed: computeLine(input) }));
  const totals = sumLines(computed.map((c) => c.computed));

  return prisma.document.create({
    data: {
      organizationId: org.id,
      fiscalYearId: fiscalYear.id,
      docType: 'INVOICE',
      docDate,
      partyId: party.id,
      status: 'DRAFT',
      subtotal: totals.subtotal,
      discountAmount: totals.discountAmount,
      taxableAmount: totals.taxableAmount,
      taxAmount: totals.taxAmount,
      grandTotal: grandTotalOverride ?? totals.grandTotal,
      lines: {
        create: computed.map(({ input, computed: c }, i) => ({
          lineNo: i + 1,
          description: input.description ?? `Line ${i + 1}`,
          accountId: input.accountId ?? salesAccount.id,
          quantity: input.quantity,
          unitPrice: input.unitPrice,
          discountPct: input.discountPct ?? 0,
          taxableAmount: c.taxableAmount,
          taxCodeId: input.taxRate ? taxCode.id : null,
          taxAmount: c.taxAmount,
          lineTotal: c.lineTotal,
        })),
      },
    },
  });
}

describe('postDocument — invoice', () => {
  it('posts a single-line invoice matching the §6 worked example 1', async () => {
    const doc = await makeDraftInvoice({
      docDate: new Date('2025-07-20'),
      lineInputs: [{ quantity: 15, unitPrice: '8000.00', discountPct: 0, taxRate: '0.13', description: 'Trekking backpacks' }],
    });

    const entry = await postDocument(doc.id, actor);
    expect(entry.status).toBe('POSTED');
    expect(entry.entryNumber).toMatch(/^JE-2082-\d{4}$/);

    const lines = await prisma.journalLine.findMany({ where: { journalEntryId: entry.id } });
    const ar = lines.find((l) => l.description === 'Accounts Receivable');
    const sales = lines.find((l) => l.accountId === salesAccount.id);
    const vat = lines.find((l) => l.accountId === vatAccount.id);

    expect(ar.debit.toFixed(2)).toBe('135600.00');
    expect(ar.partyId).toBe(party.id);
    expect(sales.credit.toFixed(2)).toBe('120000.00');
    expect(vat.credit.toFixed(2)).toBe('15600.00');

    const totalDebit = lines.reduce((t, l) => t.plus(l.debit), dec(0));
    const totalCredit = lines.reduce((t, l) => t.plus(l.credit), dec(0));
    expect(totalDebit.toFixed(2)).toBe(totalCredit.toFixed(2)); // INV-1

    const posted = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(posted.status).toBe('POSTED');
    expect(posted.docNo).toMatch(/^INV-2082-\d{4}$/);
    expect(posted.journalEntryId).toBe(entry.id);
    expect(posted.outstandingAmount.toFixed(2)).toBe('135600.00');
    expect(posted.version).toBe(1);
    // INV-11: document total equals the AR line's debit, exactly.
    expect(posted.grandTotal.toFixed(2)).toBe(ar.debit.toFixed(2));
  });

  it('rounds without drift across many lines at the §6 boundary case (INV-9)', async () => {
    const lineInputs = Array.from({ length: 7 }, (_, i) => ({
      quantity: 3,
      unitPrice: '1250.50',
      discountPct: 5,
      taxRate: '0.13',
      description: `Item ${i + 1}`,
    }));
    const doc = await makeDraftInvoice({ docDate: new Date('2025-07-21'), lineInputs });

    const entry = await postDocument(doc.id, actor);
    const arLine = await prisma.journalLine.findFirstOrThrow({
      where: { journalEntryId: entry.id, description: 'Accounts Receivable' },
    });
    const posted = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });

    expect(posted.grandTotal.toFixed(2)).toBe(arLine.debit.toFixed(2));
    expect(posted.grandTotal.toFixed(2)).toBe((4027.23 * 7).toFixed(2));
  });

  it('rejects a document whose stored grandTotal does not match its lines', async () => {
    const doc = await makeDraftInvoice({
      docDate: new Date('2025-07-22'),
      lineInputs: [{ quantity: 1, unitPrice: '1000.00', discountPct: 0, taxRate: '0.13' }],
      grandTotalOverride: '1.00', // tampered/stale total
    });

    await expect(postDocument(doc.id, actor)).rejects.toThrow(/unbalanced/i);
  });

  it('rejects posting an already-posted document', async () => {
    const doc = await makeDraftInvoice({
      docDate: new Date('2025-07-23'),
      lineInputs: [{ quantity: 1, unitPrice: '500.00', discountPct: 0, taxRate: '0.13' }],
    });

    await postDocument(doc.id, actor);
    await expect(postDocument(doc.id, actor)).rejects.toMatchObject({ status: 409, code: 'already_posted' });
  });

  it('rejects posting into a locked period', async () => {
    const doc = await makeDraftInvoice({
      docDate: new Date('2025-08-20'), // falls in closedPeriod
      lineInputs: [{ quantity: 1, unitPrice: '500.00', discountPct: 0, taxRate: '0.13' }],
    });

    await expect(postDocument(doc.id, actor)).rejects.toMatchObject({ status: 422, code: 'period_locked' });

    const untouched = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(untouched.status).toBe('DRAFT');
  });

  it('rejects posting without the invoice.post permission', async () => {
    const doc = await makeDraftInvoice({
      docDate: new Date('2025-07-24'),
      lineInputs: [{ quantity: 1, unitPrice: '500.00', discountPct: 0, taxRate: '0.13' }],
    });

    await expect(postDocument(doc.id, noPermActor)).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  });

  it('allocates doc_no per type and entry_no from one shared sequence', async () => {
    const docA = await makeDraftInvoice({
      docDate: new Date('2025-07-25'),
      lineInputs: [{ quantity: 1, unitPrice: '100.00', discountPct: 0, taxRate: '0.13' }],
    });
    const docB = await makeDraftInvoice({
      docDate: new Date('2025-07-26'),
      lineInputs: [{ quantity: 1, unitPrice: '200.00', discountPct: 0, taxRate: '0.13' }],
    });

    const entryA = await postDocument(docA.id, actor);
    const entryB = await postDocument(docB.id, actor);

    const postedA = await prisma.document.findUniqueOrThrow({ where: { id: docA.id } });
    const postedB = await prisma.document.findUniqueOrThrow({ where: { id: docB.id } });

    const seqA = Number(postedA.docNo.split('-').pop());
    const seqB = Number(postedB.docNo.split('-').pop());
    expect(seqB).toBe(seqA + 1);

    const entrySeqA = Number(entryA.entryNumber.split('-').pop());
    const entrySeqB = Number(entryB.entryNumber.split('-').pop());
    expect(entrySeqB).toBe(entrySeqA + 1);
  });
});
