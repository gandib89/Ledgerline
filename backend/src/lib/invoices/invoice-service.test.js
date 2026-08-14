import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../../db/client.js';
import { createDraftInvoice, updateDraftInvoice, previewInvoice } from './invoice-service.js';
import { postDocument } from '../accounting/post-document.js';

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

let org, fiscalYear, salesAccount, vatAccount, taxCode13, party, actor;

beforeAll(async () => {
  await resetDb();

  org = await prisma.organization.create({ data: { name: 'Invoice Service Test Co' } });

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

  await prisma.account.create({
    data: { organizationId: org.id, code: '1100', name: 'Accounts Receivable', type: 'ASSET', isControlAccount: true },
  });
  salesAccount = await prisma.account.create({
    data: { organizationId: org.id, code: '4100', name: 'Sales Revenue', type: 'REVENUE' },
  });
  vatAccount = await prisma.account.create({
    data: { organizationId: org.id, code: '2200', name: 'VAT Payable (Output)', type: 'LIABILITY', isControlAccount: true },
  });
  taxCode13 = await prisma.taxCode.create({
    data: { organizationId: org.id, code: 'VAT13', name: 'VAT 13%', rate: '0.1300', type: 'VAT', outputAccountId: vatAccount.id },
  });
  party = await prisma.party.create({
    data: { organizationId: org.id, type: 'CUSTOMER', code: 'CUS-001', name: 'Himalayan Trek Supplies', creditDays: 30 },
  });

  const postPermission = await prisma.permission.upsert({
    where: { code: 'invoice.post' },
    update: {},
    create: { code: 'invoice.post' },
  });
  const role = await prisma.role.create({ data: { name: 'Poster' } });
  await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: postPermission.id } });
  const user = await prisma.user.create({ data: { email: 'poster@invoice-service.test', passwordHash: 'x' } });
  await prisma.membership.create({ data: { userId: user.id, organizationId: org.id, roleId: role.id } });
  actor = { userId: user.id, organizationId: org.id, roleId: role.id };
});

afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

function line(overrides = {}) {
  return {
    accountId: salesAccount.id,
    description: 'Trekking backpacks',
    quantity: 15,
    unitPrice: '8000.00',
    discountPct: 0,
    taxCodeId: taxCode13.id,
    ...overrides,
  };
}

describe('createDraftInvoice', () => {
  it('recomputes totals server-side and defaults the due date from party credit days', async () => {
    const doc = await createDraftInvoice(actor, {
      partyId: party.id,
      docDate: '2025-07-20',
      lines: [line()],
    });

    expect(doc.status).toBe('DRAFT');
    expect(doc.docNo).toBeNull();
    expect(doc.grandTotal.toFixed(2)).toBe('135600.00');
    expect(doc.taxAmount.toFixed(2)).toBe('15600.00');
    expect(doc.dueDate.toISOString().slice(0, 10)).toBe('2025-08-19'); // docDate + 30 days
    expect(doc.lines).toHaveLength(1);
    expect(doc.lines[0].lineTotal.toFixed(2)).toBe('135600.00');
  });

  it('ignores client-supplied totals entirely — only qty/rate/discount/tax feed the computation', async () => {
    const doc = await createDraftInvoice(actor, {
      partyId: party.id,
      docDate: '2025-07-20',
      lines: [{ ...line(), grandTotal: '1.00', taxableAmount: '1.00', taxAmount: '1.00', lineTotal: '1.00' }],
    });

    expect(doc.grandTotal.toFixed(2)).toBe('135600.00'); // computed, not the '1.00' the client sent
  });

  it('rejects an unknown party as 404', async () => {
    await expect(
      createDraftInvoice(actor, { partyId: 'not-a-real-id', docDate: '2025-07-20', lines: [line()] })
    ).rejects.toMatchObject({ status: 404 });
  });

  it('rejects an unknown account as 404', async () => {
    await expect(
      createDraftInvoice(actor, { partyId: party.id, docDate: '2025-07-20', lines: [line({ accountId: 'not-a-real-id' })] })
    ).rejects.toMatchObject({ status: 404 });
  });

  it('rejects a date with no covering fiscal year', async () => {
    await expect(
      createDraftInvoice(actor, { partyId: party.id, docDate: '2030-01-01', lines: [line()] })
    ).rejects.toMatchObject({ status: 422, code: 'no_fiscal_year' });
  });

  it('rejects an invoice with no lines', async () => {
    await expect(
      createDraftInvoice(actor, { partyId: party.id, docDate: '2025-07-20', lines: [] })
    ).rejects.toMatchObject({ status: 422, code: 'empty_invoice' });
  });
});

describe('updateDraftInvoice', () => {
  it('recomputes totals and bumps version on a valid edit', async () => {
    const doc = await createDraftInvoice(actor, { partyId: party.id, docDate: '2025-07-21', lines: [line({ quantity: 1 })] });
    expect(doc.version).toBe(0);

    const updated = await updateDraftInvoice(actor, doc.id, 0, {
      partyId: party.id,
      lines: [line({ quantity: 2 })],
    });

    expect(updated.version).toBe(1);
    expect(updated.grandTotal.toFixed(2)).toBe('18080.00'); // 2 * 8000 * 1.13
    expect(updated.lines).toHaveLength(1);
  });

  it('rejects a stale version with 409 (optimistic concurrency)', async () => {
    const doc = await createDraftInvoice(actor, { partyId: party.id, docDate: '2025-07-21', lines: [line({ quantity: 1 })] });

    await updateDraftInvoice(actor, doc.id, 0, { lines: [line({ quantity: 3 })] }); // version now 1

    await expect(
      updateDraftInvoice(actor, doc.id, 0, { lines: [line({ quantity: 5 })] }) // stale — still says 0
    ).rejects.toMatchObject({ status: 409, code: 'version_conflict' });
  });

  it('recomputes the due date from the real party credit days when docDate changes', async () => {
    // 15 days, deliberately not the 30-day default — a hardcoded fallback
    // would silently produce 2025-08-16 here instead of 2025-08-01.
    const shortTerms = await prisma.party.create({
      data: { organizationId: org.id, type: 'CUSTOMER', code: 'CUS-015', name: 'Everest Cafe', creditDays: 15 },
    });

    const doc = await createDraftInvoice(actor, {
      partyId: shortTerms.id,
      docDate: '2025-07-20',
      lines: [line({ quantity: 1 })],
    });
    expect(doc.dueDate.toISOString().slice(0, 10)).toBe('2025-08-04');

    const updated = await updateDraftInvoice(actor, doc.id, doc.version, {
      docDate: '2025-07-17',
      lines: [line({ quantity: 1 })],
    });
    expect(updated.dueDate.toISOString().slice(0, 10)).toBe('2025-08-01');
  });

  it('leaves a hand-set due date alone when an unrelated field is edited', async () => {
    const doc = await createDraftInvoice(actor, {
      partyId: party.id,
      docDate: '2025-07-20',
      dueDate: '2025-09-30', // set by hand, not derived from credit days
      lines: [line({ quantity: 1 })],
    });
    expect(doc.dueDate.toISOString().slice(0, 10)).toBe('2025-09-30');

    const updated = await updateDraftInvoice(actor, doc.id, doc.version, {
      notes: 'Chased by phone',
      lines: [line({ quantity: 2 })],
    });
    expect(updated.dueDate.toISOString().slice(0, 10)).toBe('2025-09-30');
  });

  it('rejects editing a posted invoice', async () => {
    const doc = await createDraftInvoice(actor, { partyId: party.id, docDate: '2025-07-22', lines: [line({ quantity: 1 })] });
    await postDocument(doc.id, actor);

    await expect(
      updateDraftInvoice(actor, doc.id, 1, { lines: [line({ quantity: 9 })] })
    ).rejects.toMatchObject({ status: 409, code: 'not_draft' });
  });
});

describe('previewInvoice', () => {
  it('computes totals without persisting anything', async () => {
    const before = await prisma.document.count();
    const { totals } = await previewInvoice(actor, { lines: [line({ quantity: 1 })] });
    const after = await prisma.document.count();

    expect(totals.grandTotal.toFixed(2)).toBe('9040.00'); // 8000 * 1.13
    expect(after).toBe(before);
  });
});

describe('draft -> edit -> post, end to end', () => {
  it('the posted journal entry matches the final edited total, not the original draft', async () => {
    const draft = await createDraftInvoice(actor, { partyId: party.id, docDate: '2025-07-23', lines: [line({ quantity: 1 })] });
    const edited = await updateDraftInvoice(actor, draft.id, draft.version, { lines: [line({ quantity: 10 })] });

    const entry = await postDocument(edited.id, actor);
    const arLine = await prisma.journalLine.findFirstOrThrow({
      where: { journalEntryId: entry.id, description: 'Accounts Receivable' },
    });

    expect(arLine.debit.toFixed(2)).toBe(edited.grandTotal.toFixed(2));
    expect(arLine.debit.toFixed(2)).toBe('90400.00'); // 10 * 8000 * 1.13
  });
});
