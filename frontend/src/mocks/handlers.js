import { delay, http, HttpResponse } from 'msw';

export const demoUser = {
  id: 'user-1',
  email: 'sunita@annapurnatrading.com.np',
};

export const demoOrganizations = [
  { id: 'org-annapurna', name: 'Annapurna Trading Pvt. Ltd.', isActive: true, role: { id: 'role-owner', name: 'Owner' }, permissions: ['invoice.create', 'invoice.post', 'report.view', 'org.manage'] },
  { id: 'org-sherpa', name: 'Sherpa Ventures Pvt. Ltd.', isActive: true, role: { id: 'role-owner', name: 'Owner' }, permissions: ['invoice.create', 'invoice.post', 'report.view', 'org.manage'] },
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
