import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from './client.js';

// TRUNCATE, not DELETE: the immutability trigger blocks row-level DELETE on
// JournalEntry/JournalLine, but TRUNCATE doesn't fire row-level triggers.
async function resetDb() {
  await prisma.$executeRawUnsafe(`
    TRUNCATE
      "DocumentLine", "Document", "DocumentSeries",
      "JournalLine", "JournalEntry", "Account", "TaxCode",
      "AccountingPeriod", "FiscalYear", "Membership", "RolePermission",
      "Role", "Permission", "Organization", "User", "AuditLog", "IdempotencyKey"
    CASCADE
  `);
}

let org, fiscalYear, periodOpen, periodClosed, cash, revenue;

beforeAll(async () => {
  await resetDb();

  org = await prisma.organization.create({ data: { name: 'Trigger Test Co' } });

  fiscalYear = await prisma.fiscalYear.create({
    data: {
      organizationId: org.id,
      label: '2082/83',
      startDate: new Date('2025-07-16'),
      endDate: new Date('2026-07-15'),
    },
  });

  periodOpen = await prisma.accountingPeriod.create({
    data: {
      fiscalYearId: fiscalYear.id,
      label: 'Open Month',
      startDate: new Date('2025-07-16'),
      endDate: new Date('2025-08-15'),
      isOpen: true,
    },
  });

  periodClosed = await prisma.accountingPeriod.create({
    data: {
      fiscalYearId: fiscalYear.id,
      label: 'Closed Month',
      startDate: new Date('2025-08-16'),
      endDate: new Date('2025-09-15'),
      isOpen: false,
    },
  });

  cash = await prisma.account.create({
    data: { organizationId: org.id, code: '1010', name: 'Cash', type: 'ASSET' },
  });

  revenue = await prisma.account.create({
    data: { organizationId: org.id, code: '4100', name: 'Sales Revenue', type: 'REVENUE' },
  });
});

afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

describe('Trigger 1: journal entries must balance', () => {
  it('rejects an unbalanced entry at commit', async () => {
    await expect(
      prisma.journalEntry.create({
        data: {
          organizationId: org.id,
          periodId: periodOpen.id,
          entryNumber: 'JE-UNBALANCED-1',
          documentType: 'manual',
          entryDate: new Date('2025-07-20'),
          lines: {
            create: [
              { organizationId: org.id, accountId: cash.id, debit: '100.00', credit: '0', lineNumber: 1 },
              { organizationId: org.id, accountId: revenue.id, debit: '0', credit: '90.00', lineNumber: 2 },
            ],
          },
        },
      })
    ).rejects.toThrow(/unbalanced/i);

    const count = await prisma.journalEntry.count({ where: { entryNumber: 'JE-UNBALANCED-1' } });
    expect(count).toBe(0); // whole transaction rolled back, nothing left behind
  });

  it('accepts a balanced entry', async () => {
    const entry = await prisma.journalEntry.create({
      data: {
        organizationId: org.id,
        periodId: periodOpen.id,
        entryNumber: 'JE-BALANCED-1',
        documentType: 'manual',
        entryDate: new Date('2025-07-20'),
        lines: {
          create: [
            { organizationId: org.id, accountId: cash.id, debit: '100.00', credit: '0', lineNumber: 1 },
            { organizationId: org.id, accountId: revenue.id, debit: '0', credit: '100.00', lineNumber: 2 },
          ],
        },
      },
    });
    expect(entry.entryNumber).toBe('JE-BALANCED-1');
  });
});

describe('Trigger 2: posted entries are immutable', () => {
  it('rejects updating a posted entry', async () => {
    const entry = await prisma.journalEntry.findUniqueOrThrow({
      where: { organizationId_entryNumber: { organizationId: org.id, entryNumber: 'JE-BALANCED-1' } },
    });

    await expect(
      prisma.journalEntry.update({
        where: { id: entry.id },
        data: { description: 'trying to sneak an edit in' },
      })
    ).rejects.toThrow(/immutable/i);
  });

  it('rejects deleting a posted line', async () => {
    const line = await prisma.journalLine.findFirst({
      where: { journalEntry: { entryNumber: 'JE-BALANCED-1' } },
    });

    await expect(prisma.journalLine.delete({ where: { id: line.id } })).rejects.toThrow(/immutable/i);
  });
});

describe('Trigger 3: period lock', () => {
  it('rejects posting into a closed period', async () => {
    await expect(
      prisma.journalEntry.create({
        data: {
          organizationId: org.id,
          periodId: periodClosed.id,
          entryNumber: 'JE-CLOSED-PERIOD-1',
          documentType: 'manual',
          entryDate: new Date('2025-08-20'),
          lines: {
            create: [
              { organizationId: org.id, accountId: cash.id, debit: '50.00', credit: '0', lineNumber: 1 },
              { organizationId: org.id, accountId: revenue.id, debit: '0', credit: '50.00', lineNumber: 2 },
            ],
          },
        },
      })
    ).rejects.toThrow(/closed/i);
  });

  it('accepts posting into an open period', async () => {
    const entry = await prisma.journalEntry.create({
      data: {
        organizationId: org.id,
        periodId: periodOpen.id,
        entryNumber: 'JE-OPEN-PERIOD-1',
        documentType: 'manual',
        entryDate: new Date('2025-07-25'),
        lines: {
          create: [
            { organizationId: org.id, accountId: cash.id, debit: '25.00', credit: '0', lineNumber: 1 },
            { organizationId: org.id, accountId: revenue.id, debit: '0', credit: '25.00', lineNumber: 2 },
          ],
        },
      },
    });
    expect(entry.entryNumber).toBe('JE-OPEN-PERIOD-1');
  });
});

// A document's Posting Date, not its own date, picks the period its entry goes
// into. The trigger is the last line of defence, so the rejection here is the
// database's own — the entry is written directly, bypassing the service check.
describe('Trigger 3: period lock follows the document Posting Date', () => {
  async function draftDoc(docDate, postingDate) {
    return prisma.document.create({
      data: { organizationId: org.id, fiscalYearId: fiscalYear.id, docType: 'INVOICE', docDate: new Date(docDate), postingDate: new Date(postingDate) },
    });
  }
  async function entryFor(doc, entryNumber) {
    const period = await prisma.accountingPeriod.findFirstOrThrow({
      where: { fiscalYearId: fiscalYear.id, startDate: { lte: doc.postingDate }, endDate: { gte: doc.postingDate } },
    });
    return prisma.journalEntry.create({
      data: {
        organizationId: org.id, periodId: period.id, entryNumber, documentType: 'invoice', entryDate: doc.postingDate, sourceId: doc.id,
        lines: {
          create: [
            { organizationId: org.id, accountId: cash.id, debit: '10.00', credit: '0', lineNumber: 1 },
            { organizationId: org.id, accountId: revenue.id, debit: '0', credit: '10.00', lineNumber: 2 },
          ],
        },
      },
    });
  }

  it('posts an entry for a document whose Posting Date is in an open period, even if its docDate is in a locked one', async () => {
    const doc = await draftDoc('2025-08-20', '2025-07-25');
    const entry = await entryFor(doc, 'JE-POSTING-DATE-OPEN');
    expect(entry.periodId).toBe(periodOpen.id);
  });

  it('rejects an entry for a document whose Posting Date is in a locked period, even if its docDate is in an open one', async () => {
    const doc = await draftDoc('2025-07-25', '2025-08-20');
    await expect(entryFor(doc, 'JE-POSTING-DATE-LOCKED')).rejects.toThrow(/closed/i);
  });
});

describe('jl_sign_check: a line is a debit or a credit, never both', () => {
  it('rejects a line with both debit and credit set', async () => {
    await expect(
      prisma.journalEntry.create({
        data: {
          organizationId: org.id,
          periodId: periodOpen.id,
          entryNumber: 'JE-SIGN-VIOLATION-1',
          documentType: 'manual',
          entryDate: new Date('2025-07-26'),
          lines: {
            create: [{ organizationId: org.id, accountId: cash.id, debit: '10.00', credit: '10.00', lineNumber: 1 }],
          },
        },
      })
    ).rejects.toThrow();
  });
});
