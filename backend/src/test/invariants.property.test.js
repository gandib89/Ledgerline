import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fc from 'fast-check';
import request from 'supertest';
import app from '../app.js';
import { prisma } from '../db/client.js';
import { resetDb, seedRoles, makeUserWithOrg } from './helpers.js';

// INV-2 / INV-4: property tests over random operation sequences (§10). Unit
// tests check known scenarios; this checks that NO sequence of valid
// operations can ever leave the ledger unbalanced or break the accounting
// equation — the class of bug example-based tests structurally can't reach.
let owner;
let bankAccount, salesAccount, expenseAccount;
let partyIds;

const DOC_DATE = '2025-09-01'; // fixed, inside the single open period below

beforeAll(async () => {
  await resetDb();
  await seedRoles();
  owner = await makeUserWithOrg(app, 'owner@invariants.test', 'Invariant Test Co');

  const fiscalYear = await prisma.fiscalYear.create({
    data: { organizationId: owner.orgId, label: '2082/83', startDate: new Date('2025-07-16'), endDate: new Date('2026-07-15') },
  });
  await prisma.accountingPeriod.create({
    data: { fiscalYearId: fiscalYear.id, label: '2082/83', startDate: new Date('2025-07-16'), endDate: new Date('2026-07-15'), isOpen: true },
  });

  await prisma.account.create({ data: { organizationId: owner.orgId, code: '1100', name: 'Accounts Receivable', type: 'ASSET', isControlAccount: true } });
  bankAccount = await prisma.account.create({ data: { organizationId: owner.orgId, code: '1020', name: 'Bank', type: 'ASSET', isBankAccount: true } });
  salesAccount = await prisma.account.create({ data: { organizationId: owner.orgId, code: '4100', name: 'Sales Revenue', type: 'REVENUE' } });
  expenseAccount = await prisma.account.create({ data: { organizationId: owner.orgId, code: '5900', name: 'Misc Expense', type: 'EXPENSE' } });
  // VAT Payable also created for chart-of-accounts realism; lines below carry no tax code so it's never posted to.
  await prisma.account.create({ data: { organizationId: owner.orgId, code: '2200', name: 'VAT Payable', type: 'LIABILITY', isControlAccount: true } });

  const p1 = await prisma.party.create({ data: { organizationId: owner.orgId, type: 'CUSTOMER', code: 'CUS-001', name: 'Customer One' } });
  const p2 = await prisma.party.create({ data: { organizationId: owner.orgId, type: 'CUSTOMER', code: 'CUS-002', name: 'Customer Two' } });
  partyIds = [p1.id, p2.id];
});

afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

// Mutated across the whole property run (not reset per fast-check sample) —
// invariants must hold at every point regardless of what came before.
const invoiceIds = [];
const reversibleEntries = []; // {id}: receipt/creditNote/manualJV entries only
                               // (invoice entries are excluded — reversing one
                               // with activity applied is a real business rule
                               // rejection, not a bug, and would make the
                               // property test's "every op succeeds" premise false)

async function currentOutstanding(invoiceId) {
  const doc = await prisma.document.findUnique({ where: { id: invoiceId } });
  return doc ? Number(doc.outstandingAmount) : 0;
}

async function opCreateInvoice(amount, partyIdx) {
  const created = await request(app).post('/api/v1/invoices').set(owner.headers).send({
    partyId: partyIds[partyIdx], docDate: DOC_DATE,
    lines: [{ accountId: salesAccount.id, description: 'Property test line', quantity: 1, unitPrice: amount }],
  });
  if (created.status !== 201) throw new Error(`create invoice failed: ${created.status} ${JSON.stringify(created.body)}`);
  const posted = await request(app).post(`/api/v1/invoices/${created.body.id}/post`).set(owner.headers).send();
  if (posted.status !== 200) throw new Error(`post invoice failed: ${posted.status} ${JSON.stringify(posted.body)}`);
  invoiceIds.push(created.body.id);
}

async function opReceipt(amount) {
  if (invoiceIds.length === 0) return;
  const invoiceId = invoiceIds[Math.floor(Math.random() * invoiceIds.length)];
  const outstanding = await currentOutstanding(invoiceId);
  if (outstanding <= 0) return;
  const allocated = Math.min(amount, outstanding);
  const invoice = await prisma.document.findUnique({ where: { id: invoiceId } });

  const res = await request(app).post('/api/v1/receipts').set(owner.headers).send({
    partyId: invoice.partyId, docDate: DOC_DATE, depositAccountId: bankAccount.id, amount: allocated,
    allocations: [{ invoiceId, amount: allocated }],
  });
  if (res.status !== 201) throw new Error(`receipt failed: ${res.status} ${JSON.stringify(res.body)}`);
  reversibleEntries.push(res.body.journalEntry.id);
}

async function opCreditNote(amount) {
  if (invoiceIds.length === 0) return;
  const invoiceId = invoiceIds[Math.floor(Math.random() * invoiceIds.length)];
  const outstanding = await currentOutstanding(invoiceId);
  if (outstanding <= 0) return;
  const creditAmount = Math.min(amount, outstanding);

  const res = await request(app).post('/api/v1/credit-notes').set(owner.headers).send({
    invoiceId, docDate: DOC_DATE,
    lines: [{ accountId: salesAccount.id, description: 'Property test credit', quantity: 1, unitPrice: creditAmount }],
  });
  if (res.status !== 201) throw new Error(`credit note failed: ${res.status} ${JSON.stringify(res.body)}`);
  reversibleEntries.push(res.body.journalEntry.id);
}

async function opManualJv(amount) {
  const res = await request(app).post('/api/v1/journal-entries').set(owner.headers).send({
    entryDate: DOC_DATE, narration: 'Property test manual JV',
    lines: [
      { accountId: expenseAccount.id, debit: amount },
      { accountId: bankAccount.id, credit: amount },
    ],
  });
  if (res.status !== 201) throw new Error(`manual JV failed: ${res.status} ${JSON.stringify(res.body)}`);
  reversibleEntries.push(res.body.id);
}

async function opReverse() {
  if (reversibleEntries.length === 0) return;
  const idx = Math.floor(Math.random() * reversibleEntries.length);
  const [entryId] = reversibleEntries.splice(idx, 1);
  const res = await request(app).post(`/api/v1/journal-entries/${entryId}/reverse`).set(owner.headers).send({ reason: 'property test reversal', reversalDate: DOC_DATE });
  if (res.status !== 200) throw new Error(`reverse failed: ${res.status} ${JSON.stringify(res.body)}`);
}

async function applyOp(op) {
  const amount = op.amount;
  switch (op.type) {
    case 'invoice': return opCreateInvoice(amount, op.partyIdx);
    case 'receipt': return opReceipt(amount);
    case 'creditNote': return opCreditNote(amount);
    case 'manualJv': return opManualJv(amount);
    case 'reverse': return opReverse();
  }
}

// INV-2: Σdebit - Σcredit over the whole org must be exactly zero after
// every single operation. INV-4: the accounting equation must hold too,
// checked two independent ways — the Balance Sheet endpoint's own integrity
// flag, AND a raw SQL rollup across all five account types that doesn't
// share a code path with that endpoint.
async function assertInvariants() {
  const [glRow] = await prisma.$queryRaw`
    SELECT COALESCE(SUM(debit), 0) AS total_debit, COALESCE(SUM(credit), 0) AS total_credit
    FROM "JournalLine" WHERE "organizationId" = ${owner.orgId}
  `;
  expect((Number(glRow.total_debit) - Number(glRow.total_credit)).toFixed(4)).toBe('0.0000'); // INV-2

  const bs = await request(app).get('/api/v1/reports/balance-sheet').query({ asOf: '2026-07-15' }).set(owner.headers);
  expect(bs.status).toBe(200);
  expect(bs.body.integrity.balanced).toBe(true); // INV-4, via the endpoint

  const rows = await prisma.$queryRaw`
    SELECT a.type, COALESCE(SUM(jl.debit), 0) AS total_debit, COALESCE(SUM(jl.credit), 0) AS total_credit
    FROM "JournalLine" jl JOIN "Account" a ON a.id = jl."accountId"
    WHERE jl."organizationId" = ${owner.orgId}
    GROUP BY a.type
  `;
  const byType = Object.fromEntries(rows.map((r) => [r.type, Number(r.total_debit) - Number(r.total_credit)]));
  const assets = byType.ASSET ?? 0;
  const liabilities = -(byType.LIABILITY ?? 0);
  const equity = -(byType.EQUITY ?? 0);
  const revenue = -(byType.REVENUE ?? 0);
  const expense = byType.EXPENSE ?? 0;
  // Assets - (Liabilities + Equity + Income - Expenses) == 0, computed
  // independently from raw SQL across every account type (INV-4).
  expect((assets - (liabilities + equity + revenue - expense)).toFixed(4)).toBe('0.0000');
}

describe('INV-2 / INV-4: property tests over random operation sequences', () => {
  it(
    'the ledger stays balanced and the accounting equation holds after every op in every random sequence',
    { timeout: 120000 },
    async () => {
      const opArbitrary = fc.record({
        type: fc.constantFrom('invoice', 'receipt', 'creditNote', 'manualJv', 'reverse'),
        amount: fc.integer({ min: 100, max: 20000 }),
        partyIdx: fc.integer({ min: 0, max: 1 }),
      });

      await fc.assert(
        fc.asyncProperty(fc.array(opArbitrary, { minLength: 40, maxLength: 40 }), async (ops) => {
          for (const op of ops) {
            await applyOp(op);
            await assertInvariants();
          }
        }),
        { numRuns: 3 }
      );
    }
  );
});
