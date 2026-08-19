import { delay, http, HttpResponse } from 'msw';

export const demoUser = {
  id: 'user-1',
  email: 'sunita@annapurnatrading.com.np',
};

export const demoOrganizations = [
  { id: 'org-annapurna', name: 'Annapurna Trading Pvt. Ltd.', isActive: true, role: { id: 'role-owner', name: 'Owner' }, permissions: ['invoice.create', 'invoice.post', 'payment.create', 'bank.reconcile', 'report.view', 'audit.view', 'org.manage'] },
  { id: 'org-sherpa', name: 'Sherpa Ventures Pvt. Ltd.', isActive: true, role: { id: 'role-owner', name: 'Owner' }, permissions: ['invoice.create', 'invoice.post', 'payment.create', 'bank.reconcile', 'report.view', 'audit.view', 'org.manage'] },
];

const demoParties = [
  { id: '11111111-1111-4111-8111-111111111111', type: 'customer', code: 'CUS-001', name: 'Himalayan Trek Supplies Pvt. Ltd.', email: 'accounts@himalayan.test', phone: '01-5550101', creditDays: 30, isActive: true },
  { id: '11111111-1111-4111-8111-111111111112', type: 'customer', code: 'CUS-002', name: 'Everest Cafe Pvt. Ltd.', email: 'finance@everestcafe.test', phone: '01-5550102', creditDays: 15, isActive: true },
];

const demoAccounts = [
  { id: '22222222-2222-4222-8222-222222222221', code: '1100', name: 'Accounts Receivable', type: 'ASSET', isControlAccount: true, isBankAccount: false, isActive: true },
  { id: '22222222-2222-4222-8222-222222222222', code: '4100', name: 'Sales Revenue — Goods', type: 'REVENUE', isControlAccount: false, isBankAccount: false, isActive: true },
  { id: '22222222-2222-4222-8222-222222222223', code: '4200', name: 'Sales Revenue — Services', type: 'REVENUE', isControlAccount: false, isBankAccount: false, isActive: true },
  { id: '22222222-2222-4222-8222-222222222224', code: '2200', name: 'VAT Payable (Output)', type: 'LIABILITY', isControlAccount: true, isBankAccount: false, isActive: true },
  { id: '22222222-2222-4222-8222-222222222225', code: '1020', name: 'Bank - Nabil Current', type: 'ASSET', isControlAccount: false, isBankAccount: true, isActive: true },
  { id: '22222222-2222-4222-8222-222222222226', code: '5500', name: 'Bank Charges', type: 'EXPENSE', isControlAccount: false, isBankAccount: false, isActive: true },
];

const demoTaxCodes = [
  { id: '33333333-3333-4333-8333-333333333333', code: 'VAT13', name: 'VAT 13%', rate: '0.1300', type: 'VAT', isActive: true },
];

function calculateInvoice(lines) {
  let subtotal = 0;
  let discountAmount = 0;
  let taxableAmount = 0;
  let taxAmount = 0;
  const calculatedLines = lines.map((line, index) => {
    const base = Number(line.quantity) * Number(line.unitPrice);
    const discount = base * Number(line.discountPct ?? 0) / 100;
    const taxable = base - discount;
    const tax = line.taxCodeId ? taxable * 0.13 : 0;
    subtotal += base;
    discountAmount += discount;
    taxableAmount += taxable;
    taxAmount += tax;
    return {
      ...line,
      id: line.id ?? globalThis.crypto.randomUUID(),
      lineNo: index + 1,
      quantity: Number(line.quantity).toFixed(4),
      unitPrice: Number(line.unitPrice).toFixed(2),
      discountPct: Number(line.discountPct ?? 0).toFixed(2),
      taxCodeId: line.taxCodeId ?? null,
      taxableAmount: taxable.toFixed(2),
      taxAmount: tax.toFixed(2),
      lineTotal: (taxable + tax).toFixed(2),
    };
  });
  return {
    lines: calculatedLines,
    totals: {
      subtotal: subtotal.toFixed(2),
      discountAmount: discountAmount.toFixed(2),
      taxableAmount: taxableAmount.toFixed(2),
      taxAmount: taxAmount.toFixed(2),
      grandTotal: (taxableAmount + taxAmount).toFixed(2),
    },
  };
}

const initialCalculation = calculateInvoice([{ accountId: demoAccounts[1].id, description: 'Trekking backpacks', quantity: 10, unitPrice: 10000, discountPct: 0, taxCodeId: demoTaxCodes[0].id }]);
const demoInvoices = [{
  id: '44444444-4444-4444-8444-444444444444',
  docType: 'invoice',
  docNo: null,
  docDate: '2025-07-20',
  dueDate: '2025-08-19',
  partyId: demoParties[0].id,
  status: 'draft',
  referenceNo: 'PO-2082-044',
  notes: 'Deliver to the Balaju warehouse.',
  ...initialCalculation.totals,
  outstandingAmount: initialCalculation.totals.grandTotal,
  journalEntryId: null,
  version: 0,
  lines: initialCalculation.lines,
}];

const demoJournals = new Map();
const demoPayments = new Map();
const demoBankAccounts = [{
  id: '55555555-5555-4555-8555-555555555555',
  accountId: demoAccounts[4].id,
  bankName: 'Nabil Bank',
  accountNoMasked: '****9231',
  openingBalance: '500000.00',
  isActive: true,
}];
let demoStatement = null;
let demoStatementLines = [];
let demoReconciliation = null;
let demoBookBalance = '625850.00';

[
  ['66666666-6666-4666-8666-666666666661', 'JE-2082-0001', 'Opening balance', '2025-07-17', '500000.00'],
  ['66666666-6666-4666-8666-666666666662', 'JE-2082-0004', 'Himalayan Trek receipt', '2026-02-05', '100000.00'],
  ['66666666-6666-4666-8666-666666666663', 'JE-2082-0005', 'Everest Cafe receipt', '2026-02-08', '50850.00'],
].forEach(([id, entryNumber, description, entryDate, debit]) => demoJournals.set(id, {
  id, entryNumber, description, entryDate, documentType: 'RECEIPT', status: 'posted',
  lines: [{ id: `${id}-bank`, accountId: demoAccounts[4].id, debit, credit: '0.00', description }],
}));

function money(value) { return Number(value ?? 0).toFixed(2); }

function currentBankSummary() {
  const counts = demoStatementLines.reduce((result, line) => {
    result.total += 1;
    if (line.status === 'matched') {
      result.matched += 1;
      if (line.matchedBy === 'manual') result.manualMatched += 1;
      else result.autoMatched += 1;
    } else if (line.status === 'suggested') result.suggested += 1;
    else if (line.status === 'unmatched') result.unmatched += 1;
    else if (line.status === 'ignored') result.ignored += 1;
    return result;
  }, { autoMatched: 0, manualMatched: 0, suggested: 0, unmatched: 0, ignored: 0, matched: 0, total: 0 });
  const bankBalance = demoStatement?.closingBalance ?? '624720.00';
  const difference = money(Number(bankBalance) - Number(demoBookBalance));
  return {
    asOf: demoStatement?.periodEnd ?? '2026-02-25',
    bankAccountId: demoBankAccounts[0].id,
    statementId: demoStatement?.id ?? null,
    bankBalance,
    bookBalance: demoBookBalance,
    difference,
    integrity: { balanced: Number(difference) === 0 },
    counts,
  };
}

// Stands in for the httpOnly refresh cookie the mock layer cannot observe.
export const mockSession = { active: false };

const ok = (data, init) => HttpResponse.json({ data }, init);
const fail = (code, message, status = 400) =>
  HttpResponse.json(
    { error: { code, message, requestId: `mock-${code}` } },
    { status },
  );

export const handlers = [
  http.post('/api/v1/auth/login', async ({ request }) => {
    const body = await request.json();
    await delay(120);
    if (body.email !== 'sunita@annapurnatrading.com.np' || body.password !== 'Demo@2026') {
      return fail('invalid_credentials', 'Email or password is incorrect', 401);
    }
    mockSession.active = true;
    return ok({ user: demoUser, accessToken: 'mock-access-token' });
  }),

  http.post('/api/v1/auth/register', async ({ request }) => {
    const body = await request.json();
    await delay(120);
    mockSession.active = true;
    return ok(
      { user: { ...demoUser, email: body.email }, accessToken: 'mock-access-token' },
      { status: 201 },
    );
  }),

  // The real refresh cookie is httpOnly and MSW cannot see it, so session state
  // is modelled here. Without this the mock would refresh successfully with no
  // prior login — the app boots by trying /auth/refresh, and every test would
  // start authenticated.
  http.post('/api/v1/auth/refresh', () => {
    if (!mockSession.active) {
      return fail('refresh_invalid', 'Refresh token invalid, reused, or expired', 401);
    }
    return ok({ user: demoUser, accessToken: 'mock-refreshed-access-token' });
  }),

  http.post('/api/v1/auth/logout', () => {
    mockSession.active = false;
    return new HttpResponse(null, { status: 204 });
  }),

  http.get('/api/v1/orgs', () => ok(demoOrganizations)),

  http.get('/api/v1/audit-log', ({ request }) => {
    const params = new URL(request.url).searchParams;
    const records = [{
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', action: 'reconciliation.completed',
      entityType: 'Reconciliation', entityId: '99999999-9999-4999-8999-999999999999',
      before: { status: 'IN_PROGRESS', difference: '1130.00', unreconciledCount: 1 },
      after: { status: 'COMPLETED', difference: '0.00', unreconciledCount: 0 },
      actorId: demoUser.id, actor: demoUser, ipAddress: '127.0.0.1',
      requestId: 'demo-reconciliation-complete', createdAt: '2026-02-25T10:15:00.000Z',
    }, {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', action: 'invoice.posted',
      entityType: 'Document', entityId: '44444444-4444-4444-8444-444444444444',
      before: { status: 'DRAFT', docNo: null }, after: { status: 'POSTED', docNo: 'INV-2082-0003' },
      actorId: demoUser.id, actor: demoUser, ipAddress: '127.0.0.1',
      requestId: 'demo-invoice-post', createdAt: '2026-02-18T08:35:00.000Z',
    }].filter((entry) =>
      (!params.get('entityType') || entry.entityType === params.get('entityType'))
      && (!params.get('entityId') || entry.entityId === params.get('entityId'))
      && (!params.get('actorId') || entry.actorId === params.get('actorId')));
    return ok(records);
  }),

  http.get('/api/v1/dashboard/summary', ({ request }) => {
    const orgId = request.headers.get('X-Organization-Id') ?? demoOrganizations[0].id;
    const sherpa = orgId === 'org-sherpa';
    return ok({
      totalReceivables: sherpa ? '128400.00' : '69500.00',
      overdue: sherpa ? '24200.00' : '17520.00',
      revenue: sherpa ? '248000.00' : '195000.00',
      cashAtBank: sherpa ? '812340.00' : '624720.00',
      periodLabel: 'FY 2082/83 · Current period',
    });
  }),

  http.get('/api/v1/parties', () => ok(demoParties)),

  http.get('/api/v1/accounts', ({ request }) => {
    const type = new URL(request.url).searchParams.get('type');
    return ok(type ? demoAccounts.filter((account) => account.type === type) : demoAccounts);
  }),

  http.get('/api/v1/tax-codes', () => ok(demoTaxCodes)),

  http.get('/api/v1/invoices', ({ request }) => {
    const params = new URL(request.url).searchParams;
    const page = Number(params.get('page') ?? 1);
    const filtered = demoInvoices.filter((invoice) =>
      (!params.get('partyId') || invoice.partyId === params.get('partyId'))
      && (!params.get('status') || invoice.status === params.get('status'))
      && (!params.get('from') || invoice.docDate >= params.get('from'))
      && (!params.get('to') || invoice.docDate <= params.get('to')));
    return ok(filtered.slice((page - 1) * 20, page * 20).map((invoice) =>
      Object.fromEntries(Object.entries(invoice).filter(([key]) => key !== 'lines'))));
  }),

  http.get('/api/v1/invoices/:id', ({ params }) => {
    const invoice = demoInvoices.find(({ id }) => id === params.id);
    return invoice ? ok(invoice) : fail('not_found', 'Invoice not found', 404);
  }),

  http.post('/api/v1/invoices/preview', async ({ request }) => {
    const { lines } = await request.json();
    const calculated = calculateInvoice(lines);
    return ok({
      lines: calculated.lines.map(({ lineNo, taxableAmount, taxAmount, lineTotal }) => ({ lineNo, taxableAmount, taxAmount, lineTotal })),
      totals: calculated.totals,
    });
  }),

  http.post('/api/v1/invoices', async ({ request }) => {
    const input = await request.json();
    const calculated = calculateInvoice(input.lines);
    const invoice = {
      id: globalThis.crypto.randomUUID(),
      docType: 'invoice',
      docNo: null,
      status: 'draft',
      referenceNo: null,
      notes: null,
      dueDate: null,
      ...input,
      ...calculated.totals,
      outstandingAmount: calculated.totals.grandTotal,
      journalEntryId: null,
      version: 0,
      lines: calculated.lines,
    };
    demoInvoices.unshift(invoice);
    return ok(invoice, { status: 201 });
  }),

  http.patch('/api/v1/invoices/:id', async ({ params, request }) => {
    const index = demoInvoices.findIndex(({ id }) => id === params.id);
    if (index < 0) return fail('not_found', 'Invoice not found', 404);
    const input = await request.json();
    if (input.version !== demoInvoices[index].version) return fail('version_conflict', 'Invoice changed in another session', 409);
    const calculated = calculateInvoice(input.lines);
    demoInvoices[index] = { ...demoInvoices[index], ...input, ...calculated.totals, outstandingAmount: calculated.totals.grandTotal, version: input.version + 1, lines: calculated.lines };
    return ok(demoInvoices[index]);
  }),

  http.post('/api/v1/invoices/:id/post', ({ params }) => {
    const invoice = demoInvoices.find(({ id }) => id === params.id);
    if (!invoice) return fail('not_found', 'Invoice not found', 404);
    const journalEntryId = globalThis.crypto.randomUUID();
    Object.assign(invoice, { status: 'posted', docNo: `INV-2082-${String(demoJournals.size + 1).padStart(4, '0')}`, journalEntryId });
    const journalEntry = {
      id: journalEntryId,
      entryNumber: `JE-2082-${String(demoJournals.size + 1).padStart(4, '0')}`,
      documentType: 'INVOICE',
      entryDate: invoice.docDate,
      description: `Invoice ${invoice.docNo}`,
      status: 'posted',
      sourceId: invoice.id,
      postedAt: new Date().toISOString(),
      lines: [
        { id: globalThis.crypto.randomUUID(), accountId: demoAccounts[0].id, partyId: invoice.partyId, debit: invoice.grandTotal, credit: '0.00', description: 'Customer receivable', lineNumber: 1 },
        { id: globalThis.crypto.randomUUID(), accountId: demoAccounts[1].id, partyId: null, debit: '0.00', credit: invoice.taxableAmount, description: 'Sales revenue', lineNumber: 2 },
        { id: globalThis.crypto.randomUUID(), accountId: demoAccounts[3].id, partyId: null, debit: '0.00', credit: invoice.taxAmount, description: 'Output VAT', lineNumber: 3 },
      ],
    };
    demoJournals.set(journalEntryId, journalEntry);
    return ok({ invoice, journalEntry });
  }),

  http.get('/api/v1/journal-entries/:id', ({ params }) => {
    const journal = demoJournals.get(params.id);
    return journal ? ok(journal) : fail('not_found', 'Journal entry not found', 404);
  }),

  http.get('/api/v1/journal-entries', () => ok([...demoJournals.values()].map((entry) =>
    Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'lines'))))),

  http.post('/api/v1/receipts', async ({ request }) => {
    const input = await request.json();
    const allocatedAmount = input.allocations.reduce((total, allocation) => total + Number(allocation.amount), 0);
    const receiptId = globalThis.crypto.randomUUID();
    const journalEntryId = globalThis.crypto.randomUUID();
    const receipt = {
      id: receiptId,
      docNo: `RCP-2082-${String(demoPayments.size + 1).padStart(4, '0')}`,
      docDate: input.docDate,
      partyId: input.partyId,
      status: 'posted',
      referenceNo: input.referenceNo || null,
      notes: input.notes || null,
      grandTotal: money(input.amount),
      allocatedAmount: money(allocatedAmount),
      outstandingAmount: money(Number(input.amount) - allocatedAmount),
      journalEntryId,
    };
    const allocations = input.allocations.map((allocation) => {
      const invoice = demoInvoices.find(({ id }) => id === allocation.invoiceId);
      if (invoice) {
        invoice.outstandingAmount = money(Number(invoice.outstandingAmount) - Number(allocation.amount));
        invoice.status = Number(invoice.outstandingAmount) === 0 ? 'paid' : 'partially_paid';
      }
      const payment = {
        receiptId,
        receiptNo: receipt.docNo,
        docDate: receipt.docDate,
        referenceNo: receipt.referenceNo,
        amount: money(allocation.amount),
        allocatedAt: new Date().toISOString(),
      };
      demoPayments.set(allocation.invoiceId, [...(demoPayments.get(allocation.invoiceId) ?? []), payment]);
      return { invoiceId: allocation.invoiceId, amount: money(allocation.amount) };
    });
    const journalEntry = {
      id: journalEntryId,
      entryNumber: `JE-2082-${String(demoJournals.size + 1).padStart(4, '0')}`,
      documentType: 'RECEIPT',
      entryDate: input.docDate,
      description: `Receipt ${receipt.docNo}`,
      status: 'posted',
      sourceId: receiptId,
      lines: [
        { id: globalThis.crypto.randomUUID(), accountId: input.depositAccountId, debit: money(input.amount), credit: '0.00', description: 'Cash received' },
        { id: globalThis.crypto.randomUUID(), accountId: demoAccounts[0].id, debit: '0.00', credit: money(input.amount), description: 'Customer receivable' },
      ],
    };
    demoJournals.set(journalEntryId, journalEntry);
    return ok({ receipt, allocations, journalEntry }, { status: 201 });
  }),

  http.get('/api/v1/invoices/:id/payments', ({ params }) => {
    const invoice = demoInvoices.find(({ id }) => id === params.id);
    if (!invoice) return fail('not_found', 'Invoice not found', 404);
    return ok({ invoiceId: invoice.id, outstandingAmount: invoice.outstandingAmount, payments: demoPayments.get(invoice.id) ?? [] });
  }),

  http.get('/api/v1/reports/ar-aging', () => {
    const buckets = [
      { key: 'current', label: 'Current' },
      { key: 'd1_30', label: '1-30 days' },
      { key: 'd31_60', label: '31-60 days' },
      { key: 'd61_90', label: '61-90 days' },
      { key: 'd90_plus', label: '90+ days' },
    ];
    const open = demoInvoices.filter((invoice) => ['posted', 'partially_paid'].includes(invoice.status) && Number(invoice.outstandingAmount) > 0);
    const rows = demoParties.map((party) => {
      const invoices = open.filter((invoice) => invoice.partyId === party.id);
      const total = invoices.reduce((sum, invoice) => sum + Number(invoice.outstandingAmount), 0);
      return {
        partyId: party.id,
        partyName: party.name,
        buckets: { current: money(total), d1_30: '0.00', d31_60: '0.00', d61_90: '0.00', d90_plus: '0.00' },
        total: money(total),
        invoices: invoices.map((invoice) => ({ id: invoice.id, docNo: invoice.docNo, dueDate: invoice.dueDate, outstandingAmount: invoice.outstandingAmount, bucket: 'current' })),
      };
    }).filter((row) => Number(row.total) > 0);
    const grandTotal = money(rows.reduce((sum, row) => sum + Number(row.total), 0));
    return ok({ asOf: new Date().toISOString().slice(0, 10), buckets, rows, totals: { grandTotal }, integrity: { arControlBalance: grandTotal, balanced: true } });
  }),

  http.get('/api/v1/reports/general-ledger', ({ request }) => {
    const accountId = new URL(request.url).searchParams.get('accountId');
    const account = demoAccounts.find(({ id }) => id === accountId);
    if (!account) return fail('not_found', 'Account not found', 404);
    let running = 0;
    const lines = [...demoJournals.values()].flatMap((entry) => entry.lines.filter((line) => line.accountId === accountId).map((line) => {
      running += Number(line.debit) - Number(line.credit);
      const invoice = demoInvoices.find(({ journalEntryId }) => journalEntryId === entry.id);
      return {
        entryDate: entry.entryDate,
        entryNumber: entry.entryNumber,
        description: line.description ?? entry.description,
        debit: line.debit,
        credit: line.credit,
        runningBalance: money(running),
        journalEntryId: entry.id,
        sourceDocumentId: invoice?.id ?? null,
        sourceDocType: invoice ? 'invoice' : null,
        sourceDocNo: invoice?.docNo ?? null,
      };
    }));
    return ok({ account, from: '2025-07-16', to: new Date().toISOString().slice(0, 10), openingBalance: '0.00', lines, closingBalance: money(running) });
  }),

  http.get('/api/v1/reports/profit-loss', () => ok({
    from: '2025-07-16', to: new Date().toISOString().slice(0, 10),
    revenue: [{ code: '4100', name: 'Sales Revenue - Goods', amount: '150000.00' }, { code: '4200', name: 'Sales Revenue - Services', amount: '45000.00' }],
    revenueTotal: '195000.00',
    expense: [{ code: '5300', name: 'Rent Expense', amount: '25000.00' }, { code: '5500', name: 'Bank Charges', amount: demoBookBalance === '624720.00' ? '1130.00' : '0.00' }],
    expenseTotal: demoBookBalance === '624720.00' ? '26130.00' : '25000.00',
    netProfit: demoBookBalance === '624720.00' ? '168870.00' : '170000.00',
  })),

  http.get('/api/v1/reports/balance-sheet', () => ok({
    asOf: new Date().toISOString().slice(0, 10),
    assets: [{ code: '1020', name: 'Bank - Nabil Current', amount: demoBookBalance }, { code: '1100', name: 'Accounts Receivable', amount: '69500.00' }],
    liabilities: [{ code: '2200', name: 'VAT Payable (Output)', amount: '25350.00' }],
    equity: [{ code: '3100', name: "Owner's Capital", amount: '500000.00' }, { code: null, name: 'Current Year Earnings', amount: demoBookBalance === '624720.00' ? '168870.00' : '170000.00' }],
    totals: { assets: demoBookBalance === '624720.00' ? '694220.00' : '695350.00', liabilities: '25350.00', equity: demoBookBalance === '624720.00' ? '668870.00' : '670000.00' },
    integrity: { balanced: true, difference: '0.00' },
  })),

  http.get('/api/v1/bank-accounts', () => ok(demoBankAccounts)),

  http.post('/api/v1/bank-accounts/:id/statements', ({ params }) => {
    if (!demoBankAccounts.some(({ id }) => id === params.id)) return fail('not_found', 'Bank account not found', 404);
    demoStatement = {
      id: '77777777-7777-4777-8777-777777777777', bankAccountId: params.id, fileName: 'nabil-current-jan-feb-2026.csv',
      periodStart: '2026-01-20', periodEnd: '2026-02-25', openingBalance: '500000.00', closingBalance: '624720.00', lineCount: 4,
    };
    demoStatementLines = [
      { id: '88888888-8888-4888-8888-888888888881', statementId: demoStatement.id, txnDate: '2026-01-20', description: 'RENT PAYMENT ANNAPURNA COMPLEX', reference: 'CHQ 004821', debit: '25000.00', credit: '0.00', runningBalance: '475000.00', status: 'matched', matchedJournalLineId: 'rent-bank-line', matchConfidence: '0.970', matchedBy: 'auto', ignoreReason: null },
      { id: '88888888-8888-4888-8888-888888888882', statementId: demoStatement.id, txnDate: '2026-02-05', description: 'NEFT HIMALAYAN TREK SUPPLIES', reference: 'NEFT8834512', debit: '0.00', credit: '100000.00', runningBalance: '575000.00', status: 'matched', matchedJournalLineId: '66666666-6666-4666-8666-666666666662-bank', matchConfidence: '1.000', matchedBy: 'auto', ignoreReason: null },
      { id: '88888888-8888-4888-8888-888888888883', statementId: demoStatement.id, txnDate: '2026-02-08', description: 'IPS EVEREST CAFE', reference: 'IPS2210094', debit: '0.00', credit: '50850.00', runningBalance: '625850.00', status: 'suggested', matchedJournalLineId: '66666666-6666-4666-8666-666666666663-bank', matchConfidence: '0.840', matchedBy: null, ignoreReason: null },
      { id: '88888888-8888-4888-8888-888888888884', statementId: demoStatement.id, txnDate: '2026-02-25', description: 'MONTHLY SERVICE CHARGE', reference: '', debit: '1130.00', credit: '0.00', runningBalance: '624720.00', status: 'unmatched', matchedJournalLineId: null, matchConfidence: null, matchedBy: null, ignoreReason: null },
    ];
    demoReconciliation = null;
    demoBookBalance = '625850.00';
    return ok({ statement: demoStatement, imported: 4, autoMatched: 2, suggested: 1, unmatched: 1 });
  }),

  http.get('/api/v1/statements/:id/lines', ({ params }) => {
    if (!demoStatement || demoStatement.id !== params.id) return fail('not_found', 'Statement not found', 404);
    return ok({ ...demoStatement, lines: demoStatementLines });
  }),

  http.post('/api/v1/lines/:id/match', async ({ params, request }) => {
    const input = await request.json();
    const line = demoStatementLines.find(({ id }) => id === params.id);
    if (!line) return fail('not_found', 'Statement line not found', 404);
    Object.assign(line, { status: 'matched', matchedJournalLineId: input.journalLineId, matchConfidence: '1.000', matchedBy: 'manual' });
    return ok(line);
  }),

  http.post('/api/v1/lines/:id/reject', ({ params }) => {
    const line = demoStatementLines.find(({ id }) => id === params.id);
    if (!line) return fail('not_found', 'Statement line not found', 404);
    if (line.status !== 'suggested') return fail('line_not_suggested', 'Only a suggested match can be rejected', 422);
    Object.assign(line, { status: 'unmatched', matchedJournalLineId: null, matchConfidence: null, matchedBy: null });
    return ok(line);
  }),

  http.post('/api/v1/lines/:id/create-entry', ({ params }) => {
    const line = demoStatementLines.find(({ id }) => id === params.id);
    if (!line) return fail('not_found', 'Statement line not found', 404);
    const journalEntryId = globalThis.crypto.randomUUID();
    const bankLineId = globalThis.crypto.randomUUID();
    const amount = Number(line.debit) > 0 ? Number(line.debit) : Number(line.credit);
    demoBookBalance = money(Number(demoBookBalance) + (Number(line.credit) > 0 ? amount : -amount));
    demoJournals.set(journalEntryId, {
      id: journalEntryId, entryNumber: `JE-2082-${String(demoJournals.size + 1).padStart(4, '0')}`, entryDate: line.txnDate,
      description: line.description, documentType: 'BANK_ADJUSTMENT', status: 'posted',
      lines: [
        { id: bankLineId, accountId: demoAccounts[4].id, debit: Number(line.credit) > 0 ? money(amount) : '0.00', credit: Number(line.debit) > 0 ? money(amount) : '0.00', description: line.description },
        { id: globalThis.crypto.randomUUID(), accountId: demoAccounts[5].id, debit: Number(line.debit) > 0 ? money(amount) : '0.00', credit: Number(line.credit) > 0 ? money(amount) : '0.00', description: line.description },
      ],
    });
    Object.assign(line, { status: 'matched', matchedJournalLineId: bankLineId, matchConfidence: '1.000', matchedBy: 'auto' });
    return ok({ statementLine: line, journalEntryId }, { status: 201 });
  }),

  http.post('/api/v1/lines/:id/ignore', async ({ params, request }) => {
    const line = demoStatementLines.find(({ id }) => id === params.id);
    if (!line) return fail('not_found', 'Statement line not found', 404);
    const { reason } = await request.json();
    Object.assign(line, { status: 'ignored', ignoreReason: reason });
    return ok(line);
  }),

  http.post('/api/v1/reconciliations', () => {
    const summary = currentBankSummary();
    demoReconciliation = { id: '99999999-9999-4999-8999-999999999999', bankAccountId: summary.bankAccountId, statementId: summary.statementId, asOfDate: summary.asOf, bookBalance: summary.bookBalance, bankBalance: summary.bankBalance, difference: summary.difference, unreconciledCount: summary.counts.suggested + summary.counts.unmatched, status: 'in_progress' };
    return ok(demoReconciliation, { status: 201 });
  }),

  http.post('/api/v1/reconciliations/:id/complete', ({ params }) => {
    if (!demoReconciliation || demoReconciliation.id !== params.id) return fail('not_found', 'Reconciliation not found', 404);
    const summary = currentBankSummary();
    if (!summary.integrity.balanced || summary.counts.suggested + summary.counts.unmatched > 0) return fail('reconciliation_not_balanced', 'Resolve all lines and reduce the difference to zero', 422);
    demoStatementLines.forEach((line) => { if (line.status === 'matched') line.status = 'reconciled'; });
    demoReconciliation = { ...demoReconciliation, status: 'completed', difference: '0.00', unreconciledCount: 0 };
    return ok(demoReconciliation);
  }),

  http.get('/api/v1/reports/bank-reconciliation', () => ok(currentBankSummary())),

  http.get('/api/v1/reports/trial-balance', () => ok({
    asOf: '2026-08-14',
    rows: [
      { code: '1100', name: 'Accounts Receivable', type: 'ASSET', totalDebit: '113000.00', totalCredit: '0.00', debitBalance: '113000.00', creditBalance: '0.00' },
      { code: '2200', name: 'VAT Payable (Output)', type: 'LIABILITY', totalDebit: '0.00', totalCredit: '13000.00', debitBalance: '0.00', creditBalance: '13000.00' },
      { code: '4100', name: 'Sales Revenue — Goods', type: 'REVENUE', totalDebit: '0.00', totalCredit: '100000.00', debitBalance: '0.00', creditBalance: '100000.00' },
    ],
    totals: { debit: '113000.00', credit: '113000.00' },
    integrity: { balanced: true, difference: '0.00' },
  })),
];
