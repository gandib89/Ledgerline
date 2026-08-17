import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { prisma } from '../db/client.js';
import { resetDb, seedRoles, makeUserWithOrg } from '../test/helpers.js';

let owner, party;

beforeAll(async () => {
  await resetDb();
  await seedRoles();

  owner = await makeUserWithOrg(app, 'owner@banking.test', 'Banking Test Co');

  const fiscalYear = await prisma.fiscalYear.create({
    data: { organizationId: owner.orgId, label: '2082/83', startDate: new Date('2025-07-16'), endDate: new Date('2026-07-15') },
  });
  await prisma.accountingPeriod.create({
    data: { fiscalYearId: fiscalYear.id, label: '2082/83', startDate: new Date('2025-07-16'), endDate: new Date('2026-07-15'), isOpen: true },
  });

  await prisma.account.create({ data: { organizationId: owner.orgId, code: '1100', name: 'Accounts Receivable', type: 'ASSET', isControlAccount: true } });
  await prisma.account.create({ data: { organizationId: owner.orgId, code: '5500', name: 'Bank Charges', type: 'EXPENSE' } });
  party = await prisma.party.create({ data: { organizationId: owner.orgId, type: 'CUSTOMER', code: 'CUS-001', name: 'Himalayan Trek Supplies' } });
});

afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

let bankCounter = 0;
// Every test gets its own GL bank account + BankAccount master row, so the
// matcher's candidate pool and the file_sha256 uniqueness never leak between
// scenarios that would otherwise share the same organization.
async function makeBankAccount() {
  bankCounter += 1;
  const code = `10${20 + bankCounter}`;
  const glAccount = await prisma.account.create({
    data: { organizationId: owner.orgId, code, name: `Bank — Test ${bankCounter}`, type: 'ASSET', isBankAccount: true },
  });
  const res = await request(app).post('/api/v1/bank-accounts').set(owner.headers).send({
    accountId: glAccount.id, bankName: `Test Bank ${bankCounter}`, accountNoMasked: `****${1000 + bankCounter}`,
  });
  expect(res.status).toBe(201);
  return { glAccount, bankAccountId: res.body.id };
}

async function postReceipt(amount, docDate, depositAccountId) {
  const res = await request(app).post('/api/v1/receipts').set(owner.headers).send({
    partyId: party.id, docDate, depositAccountId, amount, allocations: [],
  });
  expect(res.status).toBe(201);
  return res.body;
}

function csvText(rows) {
  const header = 'Date,Description,Reference,Debit,Credit,Balance';
  const lines = rows.map((r) => [r.date, r.description, r.reference ?? '', r.debit ?? '', r.credit ?? '', r.balance ?? ''].join(','));
  return [header, ...lines].join('\n');
}

const columnMapping = {
  dateFormat: 'YYYY-MM-DD',
  columns: { date: 'Date', description: 'Description', reference: 'Reference', debit: 'Debit', credit: 'Credit', balance: 'Balance' },
};

function importCsv(bankAccountId, fileName, rows, { idempotencyKey, contentType = 'text/csv' } = {}) {
  const req = request(app)
    .post(`/api/v1/bank-accounts/${bankAccountId}/statements`)
    .set(owner.headers)
    .field('columnMapping', JSON.stringify(columnMapping))
    .attach('file', Buffer.from(csvText(rows), 'utf8'), { filename: fileName, contentType });
  return idempotencyKey ? req.set('Idempotency-Key', idempotencyKey) : req;
}

describe('RECON-1: import auto-matches on amount + date + reference, leaves the rest unmatched', () => {
  it('3 of 4 lines auto-match at >=0.90, 1 stays unmatched', async () => {
    const { glAccount, bankAccountId } = await makeBankAccount();

    const r1 = await postReceipt(10000, '2026-01-05', glAccount.id);
    const r2 = await postReceipt(20000, '2026-01-12', glAccount.id);
    const r3 = await postReceipt(15000, '2026-01-20', glAccount.id);

    const res = await importCsv(bankAccountId, 'jan-2026.csv', [
      { date: '2026-01-05', description: `NEFT ${r1.receipt.docNo}`, credit: '10000.00', balance: '10000.00' },
      { date: '2026-01-12', description: `NEFT ${r2.receipt.docNo}`, credit: '20000.00', balance: '30000.00' },
      { date: '2026-01-20', description: `NEFT ${r3.receipt.docNo}`, credit: '15000.00', balance: '45000.00' },
      { date: '2026-01-25', description: 'MONTHLY SERVICE CHARGE', debit: '250.00', balance: '44750.00' },
    ]);

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(4);
    expect(res.body.autoMatched).toBe(3);
    expect(res.body.suggested).toBe(0);
    expect(res.body.unmatched).toBe(1);

    const lines = await request(app).get(`/api/v1/statements/${res.body.statement.id}/lines`).set(owner.headers);
    const statuses = lines.body.lines.map((l) => l.status).sort();
    expect(statuses).toEqual(['matched', 'matched', 'matched', 'unmatched']);
  });
});

describe('RECON-2: re-importing the same file is idempotent', () => {
  it('returns 200, zero new lines, the same statement id', async () => {
    const { glAccount, bankAccountId } = await makeBankAccount();
    const r1 = await postReceipt(5000, '2026-01-05', glAccount.id);
    const rows = [{ date: '2026-01-05', description: `NEFT ${r1.receipt.docNo}`, credit: '5000.00', balance: '5000.00' }];

    const first = await importCsv(bankAccountId, 'reimport.csv', rows);
    expect(first.status).toBe(200);
    const countAfterFirst = await prisma.bankStatementLine.count({ where: { statementId: first.body.statement.id } });

    const second = await importCsv(bankAccountId, 'reimport.csv', rows);
    expect(second.status).toBe(200);
    expect(second.body.imported).toBe(0);
    expect(second.body.statement.id).toBe(first.body.statement.id);

    const countAfterSecond = await prisma.bankStatementLine.count({ where: { statementId: first.body.statement.id } });
    expect(countAfterSecond).toBe(countAfterFirst);
  });
});

describe('POST /bank-accounts/:id/statements — multipart upload guards (§7/§9)', () => {
  it('rejects a non-CSV mimetype before it ever reaches the parser', async () => {
    const { bankAccountId } = await makeBankAccount();
    const res = await importCsv(bankAccountId, 'statement.pdf', [
      { date: '2026-01-05', description: 'X', credit: '100.00', balance: '100.00' },
    ], { contentType: 'application/pdf' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('unsupported_file_type');
  });

  it('Idempotency-Key: the same key replayed twice returns the identical response, flagged', async () => {
    const { glAccount, bankAccountId } = await makeBankAccount();
    const r1 = await postReceipt(3000, '2026-01-05', glAccount.id);
    const rows = [{ date: '2026-01-05', description: `NEFT ${r1.receipt.docNo}`, credit: '3000.00', balance: '3000.00' }];
    const key = 'stmt-idem-key-1';

    const first = await importCsv(bankAccountId, 'idem.csv', rows, { idempotencyKey: key });
    expect(first.status).toBe(200);
    expect(first.headers['idempotent-replay']).toBeUndefined();

    const second = await importCsv(bankAccountId, 'idem.csv', rows, { idempotencyKey: key });
    expect(second.status).toBe(200);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.body).toEqual(first.body);

    const statementCount = await prisma.bankStatement.count({ where: { bankAccountId } });
    expect(statementCount).toBe(1);
  });
});

describe('RECON-3: two identical amounts on the same day tie, so neither auto-matches', () => {
  it('both statement lines stay suggested', async () => {
    const { glAccount, bankAccountId } = await makeBankAccount();

    // Same party, same amount, same date on both receipts: every score
    // component (amount, date, trigram name similarity) ties exactly between
    // the two candidates, so each statement line's own top-2 candidates tie.
    await postReceipt(5000, '2026-01-10', glAccount.id);
    await postReceipt(5000, '2026-01-10', glAccount.id);

    const res = await importCsv(bankAccountId, 'duplicate-amounts.csv', [
      { date: '2026-01-10', description: party.name, credit: '5000.00', balance: '5000.00' },
      { date: '2026-01-10', description: party.name, credit: '5000.00', balance: '10000.00' },
    ]);

    expect(res.status).toBe(200);
    expect(res.body.autoMatched).toBe(0);
    expect(res.body.suggested).toBe(2);
    expect(res.body.unmatched).toBe(0);
  });
});

describe('POST /lines/:id/reject', () => {
  it('clears a suggested candidate, returns the line to unmatched, and audits the decision', async () => {
    const { glAccount, bankAccountId } = await makeBankAccount();
    await postReceipt(6100, '2026-01-14', glAccount.id);
    const imported = await importCsv(bankAccountId, 'reject-suggestion.csv', [
      { date: '2026-01-14', description: 'UNIDENTIFIED DEPOSIT', credit: '6100.00', balance: '6100.00' },
    ]);
    expect(imported.body.suggested).toBe(1);
    const suggested = await prisma.bankStatementLine.findFirstOrThrow({
      where: { statementId: imported.body.statement.id },
    });
    expect(suggested.matchedJournalLineId).not.toBeNull();

    const response = await request(app).post(`/api/v1/lines/${suggested.id}/reject`).set(owner.headers).send();

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'unmatched', matchedJournalLineId: null, matchConfidence: null });
    const audit = await prisma.auditLog.findFirst({
      where: { organizationId: owner.orgId, action: 'statementLine.suggestionRejected', entityId: suggested.id },
    });
    expect(audit).not.toBeNull();
  });
});

describe('RECON-4: manual match', () => {
  it('sets matched_by=manual, confidence 1.0, and writes an audit row', async () => {
    const { glAccount, bankAccountId } = await makeBankAccount();
    const r1 = await postReceipt(7000, '2026-01-05', glAccount.id);

    // Dated 20 days later — outside the matcher's 7-day candidate window, so
    // it imports unmatched and must be resolved by hand.
    const res = await importCsv(bankAccountId, 'manual-match.csv', [
      { date: '2026-01-25', description: 'DEPOSIT', credit: '7000.00', balance: '7000.00' },
    ]);
    expect(res.body.unmatched).toBe(1);
    const lineId = res.body.statement.lines?.[0]?.id
      ?? (await request(app).get(`/api/v1/statements/${res.body.statement.id}/lines`).set(owner.headers)).body.lines[0].id;

    const journalLine = await prisma.journalLine.findFirstOrThrow({
      where: { journalEntryId: r1.journalEntry.id, accountId: glAccount.id },
    });

    const matchRes = await request(app).post(`/api/v1/lines/${lineId}/match`).set(owner.headers).send({ journalLineId: journalLine.id });
    expect(matchRes.status).toBe(200);
    expect(matchRes.body.status).toBe('matched');
    expect(matchRes.body.matchedBy).toBe('manual');
    expect(matchRes.body.matchConfidence).toBe('1.000');

    const audit = await prisma.auditLog.findFirst({ where: { organizationId: owner.orgId, action: 'statementLine.matched', entityId: lineId } });
    expect(audit).not.toBeNull();
  });
});

describe('RECON-5: create-entry-from-line', () => {
  it('posts through the real posting engine and auto-matches the new line', async () => {
    const { glAccount, bankAccountId } = await makeBankAccount();
    const bankChargesAccount = await prisma.account.findFirstOrThrow({ where: { organizationId: owner.orgId, code: '5500' } });

    const res = await importCsv(bankAccountId, 'bank-charge.csv', [
      { date: '2026-01-25', description: 'MONTHLY SERVICE CHARGE', debit: '1130.00', balance: '1130.00' },
    ]);
    expect(res.body.unmatched).toBe(1);
    const lineId = (await request(app).get(`/api/v1/statements/${res.body.statement.id}/lines`).set(owner.headers)).body.lines[0].id;

    const createRes = await request(app).post(`/api/v1/lines/${lineId}/create-entry`).set(owner.headers).send({ accountId: bankChargesAccount.id });
    expect(createRes.status).toBe(201);
    expect(createRes.body.statementLine.status).toBe('matched');
    expect(createRes.body.statementLine.matchedBy).toBe('auto');

    const entry = await prisma.journalEntry.findUniqueOrThrow({ where: { id: createRes.body.journalEntryId }, include: { lines: true } });
    expect(entry.lines).toHaveLength(2);
    const bankLine = entry.lines.find((l) => l.accountId === glAccount.id);
    const expenseLine = entry.lines.find((l) => l.accountId === bankChargesAccount.id);
    expect(bankLine.credit.toFixed(2)).toBe('1130.00'); // money left the bank
    expect(expenseLine.debit.toFixed(2)).toBe('1130.00');
  });
});

describe('RECON-6: direction — a statement credit never matches a journal credit on the bank account', () => {
  it('a same-day, same-amount but wrong-direction line stays unmatched', async () => {
    const { glAccount, bankAccountId } = await makeBankAccount();
    // The receipt puts a DEBIT on the bank account. A statement DEBIT
    // (money out) can only ever match a journal CREDIT — never this line.
    await postReceipt(5000, '2026-01-10', glAccount.id);

    const res = await importCsv(bankAccountId, 'wrong-direction.csv', [
      { date: '2026-01-10', description: 'SOME PAYMENT', debit: '5000.00', balance: '-5000.00' },
    ]);

    expect(res.body.autoMatched).toBe(0);
    expect(res.body.suggested).toBe(0);
    expect(res.body.unmatched).toBe(1);
  });
});

describe('RECON-7: completing with a nonzero difference is refused', () => {
  it('422 from the service, and the DB CHECK refuses a direct update too', async () => {
    const { glAccount, bankAccountId } = await makeBankAccount();
    const r1 = await postReceipt(5000, '2026-01-10', glAccount.id);

    const res = await importCsv(bankAccountId, 'unbalanced.csv', [
      // Balance column deliberately doesn't reconcile with the ledger (5000)
      { date: '2026-01-10', description: `NEFT ${r1.receipt.docNo}`, credit: '5000.00', balance: '6000.00' },
    ]);
    expect(res.body.autoMatched).toBe(1);

    const recRes = await request(app).post('/api/v1/reconciliations').set(owner.headers).send({
      bankAccountId, statementId: res.body.statement.id, asOfDate: '2026-01-10',
    });
    expect(recRes.status).toBe(201);
    expect(recRes.body.difference).toBe('1000.00');

    const completeRes = await request(app).post(`/api/v1/reconciliations/${recRes.body.id}/complete`).set(owner.headers).send();
    expect(completeRes.status).toBe(422);
    expect(completeRes.body.error.code).toBe('reconciliation_not_balanced');

    await expect(
      prisma.$executeRaw`UPDATE "Reconciliation" SET status = 'COMPLETED' WHERE id = ${recRes.body.id}`
    ).rejects.toThrow();
  });
});

describe('GET /reports/bank-reconciliation', () => {
  it('reports book/bank/difference and a matched-vs-unmatched breakdown (§8.6)', async () => {
    const { glAccount, bankAccountId } = await makeBankAccount();
    const r1 = await postReceipt(4000, '2026-01-10', glAccount.id);

    const res = await importCsv(bankAccountId, 'summary.csv', [
      { date: '2026-01-10', description: `NEFT ${r1.receipt.docNo}`, credit: '4000.00', balance: '4000.00' },
      { date: '2026-01-25', description: 'MONTHLY SERVICE CHARGE', debit: '250.00', balance: '3750.00' },
    ]);
    expect(res.body.autoMatched).toBe(1);
    expect(res.body.unmatched).toBe(1);

    const summary = await request(app).get('/api/v1/reports/bank-reconciliation').query({
      bankAccountId, statementId: res.body.statement.id,
    }).set(owner.headers);

    expect(summary.status).toBe(200);
    expect(summary.body.bankBalance).toBe('3750.00');
    expect(summary.body.bookBalance).toBe('4000.00'); // the 250 charge isn't posted to the ledger yet
    expect(summary.body.difference).toBe('-250.00');
    expect(summary.body.counts).toMatchObject({ autoMatched: 1, manualMatched: 0, suggested: 0, unmatched: 1, ignored: 0, matched: 1, total: 2 });
  });
});

describe('RECON-8: reversing a matched entry returns its line to unmatched', () => {
  it('unmatches when the reconciliation is not completed, blocks when it is', async () => {
    const { glAccount, bankAccountId } = await makeBankAccount();
    const r1 = await postReceipt(8000, '2026-01-10', glAccount.id);

    const res = await importCsv(bankAccountId, 'reversal.csv', [
      { date: '2026-01-10', description: `NEFT ${r1.receipt.docNo}`, credit: '8000.00', balance: '8000.00' },
    ]);
    expect(res.body.autoMatched).toBe(1);
    const lineId = (await request(app).get(`/api/v1/statements/${res.body.statement.id}/lines`).set(owner.headers)).body.lines[0].id;

    const reverseRes = await request(app).post(`/api/v1/journal-entries/${r1.journalEntry.id}/reverse`).set(owner.headers).send({
      reason: 'wrong receipt', reversalDate: '2026-01-11',
    });
    expect(reverseRes.status).toBe(200);

    const afterReversal = await prisma.bankStatementLine.findUniqueOrThrow({ where: { id: lineId } });
    expect(afterReversal.status).toBe('UNMATCHED');
    expect(afterReversal.matchedJournalLineId).toBeNull();
  });

  it('blocks the reversal with 422 reconciled_period once the reconciliation is completed', async () => {
    const { glAccount, bankAccountId } = await makeBankAccount();
    const r1 = await postReceipt(9000, '2026-01-10', glAccount.id);

    const res = await importCsv(bankAccountId, 'reversal-blocked.csv', [
      { date: '2026-01-10', description: `NEFT ${r1.receipt.docNo}`, credit: '9000.00', balance: '9000.00' },
    ]);
    expect(res.body.autoMatched).toBe(1);
    const lineId = (await request(app).get(`/api/v1/statements/${res.body.statement.id}/lines`).set(owner.headers)).body.lines[0].id;

    const recRes = await request(app).post('/api/v1/reconciliations').set(owner.headers).send({
      bankAccountId, statementId: res.body.statement.id, asOfDate: '2026-01-10',
    });
    expect(recRes.body.difference).toBe('0.00');

    const completeRes = await request(app).post(`/api/v1/reconciliations/${recRes.body.id}/complete`).set(owner.headers).send();
    expect(completeRes.status).toBe(200);

    const reverseRes = await request(app).post(`/api/v1/journal-entries/${r1.journalEntry.id}/reverse`).set(owner.headers).send({
      reason: 'wrong receipt', reversalDate: '2026-01-11',
    });
    expect(reverseRes.status).toBe(422);
    expect(reverseRes.body.error.code).toBe('reconciled_period');

    const stillReconciled = await prisma.bankStatementLine.findUniqueOrThrow({ where: { id: lineId } });
    expect(stillReconciled.status).toBe('RECONCILED');
  });
});
