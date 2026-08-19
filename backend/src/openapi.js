import { z } from 'zod';
import { extendZodWithOpenApi, OpenAPIRegistry, OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';

// Patches `.openapi()` onto every Zod schema in this module. Zod is a single
// cached module instance across the app, so this only needs to run once —
// but this file deliberately does NOT touch the route files' own schemas
// (that would mean annotating ~40 endpoints' worth of zod.object() calls in
// place); it re-describes each route's shape here instead, in one file, at
// the cost of the two copies drifting if a route's contract changes without
// updating this file too.
extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();

registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http', scheme: 'bearer', bearerFormat: 'JWT',
});
const orgHeader = registry.registerParameter(
  'OrganizationId',
  z.string().uuid().openapi({ param: { name: 'X-Organization-Id', in: 'header' }, description: 'Active organization — required on every tenant-scoped route' })
);
const AUTH = [{ bearerAuth: [] }];

// ---- shared field shapes -------------------------------------------------
const money = () => z.string().openapi({ example: '1250.00', description: 'Decimal string, 2dp on the wire' });
const dateStr = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/).openapi({ example: '2025-08-20' });
const uuid = () => z.string().uuid();
const errorResponse = { description: 'Error', content: { 'application/json': { schema: z.object({
  error: z.object({ code: z.string(), message: z.string(), requestId: z.string().optional(), details: z.array(z.object({ path: z.string(), message: z.string() })).optional() }),
}) } } };
const json = (schema) => ({ content: { 'application/json': { schema } } });
const tenantParams = [orgHeader];

// ---- auth -----------------------------------------------------------------
const authUser = z.object({ id: uuid(), email: z.string().email() });

registry.registerPath({
  method: 'post', path: '/api/v1/auth/register', tags: ['Auth'], summary: 'Register a new user',
  request: { body: { content: { 'application/json': { schema: z.object({ email: z.string().email(), password: z.string().min(8) }) } } } },
  responses: { 201: { description: 'Created', ...json(z.object({ user: authUser, accessToken: z.string() })) }, 400: errorResponse },
});
registry.registerPath({
  method: 'post', path: '/api/v1/auth/login', tags: ['Auth'], summary: 'Log in',
  request: { body: { content: { 'application/json': { schema: z.object({ email: z.string().email(), password: z.string() }) } } } },
  responses: { 200: { description: 'OK', ...json(z.object({ user: authUser, accessToken: z.string() })) }, 401: errorResponse },
});
registry.registerPath({
  method: 'post', path: '/api/v1/auth/refresh', tags: ['Auth'], summary: 'Rotate the refresh token (cookie-based)',
  responses: { 200: { description: 'OK', ...json(z.object({ user: authUser, accessToken: z.string() })) }, 401: errorResponse },
});
registry.registerPath({
  method: 'post', path: '/api/v1/auth/logout', tags: ['Auth'], summary: 'Revoke the current refresh token family',
  responses: { 204: { description: 'No Content' } },
});

// ---- orgs -------------------------------------------------------------------
const org = z.object({ id: uuid(), name: z.string() });

registry.registerPath({
  method: 'get', path: '/api/v1/orgs', tags: ['Organizations'], summary: "List the caller's organizations",
  security: AUTH, responses: { 200: { description: 'OK', ...json(z.array(org)) } },
});
registry.registerPath({
  method: 'post', path: '/api/v1/orgs', tags: ['Organizations'], summary: 'Create an organization (caller becomes Owner)',
  security: AUTH, request: { body: { content: { 'application/json': { schema: z.object({ name: z.string().min(1) }) } } } },
  responses: { 201: { description: 'Created', ...json(org) } },
});
registry.registerPath({
  method: 'post', path: '/api/v1/orgs/{id}/members', tags: ['Organizations'], summary: 'Invite a member into an organization',
  security: AUTH, request: { params: z.object({ id: uuid() }), body: { content: { 'application/json': { schema: z.object({ email: z.string().email(), roleId: uuid() }) } } } },
  responses: { 201: { description: 'Created' }, 403: errorResponse },
});

// ---- masters ----------------------------------------------------------------
const account = z.object({ id: uuid(), code: z.string(), name: z.string(), type: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']), isControlAccount: z.boolean(), isBankAccount: z.boolean() });
const party = z.object({ id: uuid(), type: z.enum(['CUSTOMER', 'VENDOR']), code: z.string(), name: z.string(), creditDays: z.number().optional() });

registry.registerPath({
  method: 'get', path: '/api/v1/accounts', tags: ['Masters'], summary: 'List chart-of-accounts',
  security: AUTH, request: { headers: tenantParams }, responses: { 200: { description: 'OK', ...json(z.array(account)) } },
});
registry.registerPath({
  method: 'post', path: '/api/v1/accounts', tags: ['Masters'], summary: 'Create an account',
  security: AUTH, request: { headers: tenantParams, body: { content: { 'application/json': { schema: z.object({ code: z.string(), name: z.string(), type: z.string() }) } } } },
  responses: { 201: { description: 'Created', ...json(account) } },
});
registry.registerPath({
  method: 'get', path: '/api/v1/parties', tags: ['Masters'], summary: 'List customers/vendors',
  security: AUTH, request: { headers: tenantParams }, responses: { 200: { description: 'OK', ...json(z.array(party)) } },
});
registry.registerPath({
  method: 'post', path: '/api/v1/parties', tags: ['Masters'], summary: 'Create a party',
  security: AUTH, request: { headers: tenantParams, body: { content: { 'application/json': { schema: z.object({ type: z.string(), code: z.string(), name: z.string(), creditDays: z.number().optional() }) } } } },
  responses: { 201: { description: 'Created', ...json(party) } },
});
registry.registerPath({
  method: 'patch', path: '/api/v1/parties/{id}', tags: ['Masters'], summary: 'Update a party',
  security: AUTH, request: { headers: tenantParams, params: z.object({ id: uuid() }), body: { content: { 'application/json': { schema: z.object({ name: z.string().optional(), email: z.string().optional(), creditDays: z.number().optional() }) } } } },
  responses: { 200: { description: 'OK', ...json(party) }, 404: errorResponse },
});
registry.registerPath({
  method: 'get', path: '/api/v1/tax-codes', tags: ['Masters'], summary: 'List active tax codes',
  security: AUTH, request: { headers: tenantParams },
  responses: { 200: { description: 'OK', ...json(z.array(z.object({ id: uuid(), code: z.string(), name: z.string(), rate: z.string(), type: z.string(), isActive: z.boolean() }))) } },
});
registry.registerPath({
  method: 'get', path: '/api/v1/fiscal-years', tags: ['Masters'], summary: 'List fiscal years',
  security: AUTH, request: { headers: tenantParams }, responses: { 200: { description: 'OK', ...json(z.array(z.object({ id: uuid(), label: z.string(), startDate: dateStr(), endDate: dateStr() }))) } },
});
registry.registerPath({
  method: 'get', path: '/api/v1/periods', tags: ['Masters'], summary: 'List accounting periods',
  security: AUTH, request: { headers: tenantParams }, responses: { 200: { description: 'OK', ...json(z.array(z.object({ id: uuid(), label: z.string(), isOpen: z.boolean() }))) } },
});
registry.registerPath({
  method: 'patch', path: '/api/v1/periods/{id}', tags: ['Masters'], summary: 'Open or lock an accounting period',
  security: AUTH, request: { headers: tenantParams, params: z.object({ id: uuid() }), body: { content: { 'application/json': { schema: z.object({ isOpen: z.boolean() }) } } } },
  responses: { 200: { description: 'OK', ...json(z.object({ id: uuid(), isOpen: z.boolean() })) }, 404: errorResponse },
});

// ---- invoices -----------------------------------------------------------------
const invoiceLineInput = z.object({ accountId: uuid(), description: z.string(), quantity: z.number(), unitPrice: z.number(), discountPct: z.number().optional(), taxCodeId: uuid().optional() });
const invoice = z.object({
  id: uuid(), docType: z.literal('invoice'), docNo: z.string().nullable(), docDate: dateStr(), partyId: uuid(),
  status: z.enum(['draft', 'posted', 'partially_paid', 'paid', 'reversed']), version: z.number(),
  subtotal: money(), discountAmount: money(), taxableAmount: money(), taxAmount: money(), grandTotal: money(), outstandingAmount: money(),
});
const journalLine = z.object({ id: uuid(), accountId: uuid(), partyId: uuid().nullable(), debit: money(), credit: money(), description: z.string().nullable(), lineNumber: z.number() });
const journalEntry = z.object({
  id: uuid(), entryNumber: z.string(), documentType: z.string(), entryDate: dateStr(), description: z.string(),
  status: z.enum(['draft', 'posted', 'reversed']), sourceId: uuid().nullable(), reversalOfId: uuid().nullable(), lines: z.array(journalLine).optional(),
});

registry.registerPath({
  method: 'post', path: '/api/v1/invoices/preview', tags: ['Invoices'], summary: 'Recompute totals for a set of lines without persisting',
  security: AUTH, request: { headers: tenantParams, body: { content: { 'application/json': { schema: z.object({ lines: z.array(invoiceLineInput) }) } } } },
  responses: { 200: { description: 'OK', ...json(z.object({ totals: z.object({ grandTotal: money() }) })) } },
});
registry.registerPath({
  method: 'post', path: '/api/v1/invoices', tags: ['Invoices'], summary: 'Create a draft invoice',
  security: AUTH, request: { headers: tenantParams, body: { content: { 'application/json': { schema: z.object({ partyId: uuid(), docDate: dateStr(), lines: z.array(invoiceLineInput).min(1) }) } } } },
  responses: { 201: { description: 'Created', ...json(invoice) }, 400: errorResponse },
});
registry.registerPath({
  method: 'get', path: '/api/v1/invoices', tags: ['Invoices'], summary: 'List invoices',
  security: AUTH, request: { headers: tenantParams, query: z.object({ from: dateStr().optional(), to: dateStr().optional() }) },
  responses: { 200: { description: 'OK', ...json(z.array(invoice)) } },
});
registry.registerPath({
  method: 'get', path: '/api/v1/invoices/{id}', tags: ['Invoices'], summary: 'Get an invoice',
  security: AUTH, request: { headers: tenantParams, params: z.object({ id: uuid() }) },
  responses: { 200: { description: 'OK', ...json(invoice) }, 404: errorResponse },
});
registry.registerPath({
  method: 'patch', path: '/api/v1/invoices/{id}', tags: ['Invoices'], summary: 'Edit a draft invoice (optimistic concurrency via `version`)',
  security: AUTH, request: { headers: tenantParams, params: z.object({ id: uuid() }), body: { content: { 'application/json': { schema: z.object({ version: z.number(), lines: z.array(invoiceLineInput) }) } } } },
  responses: { 200: { description: 'OK', ...json(invoice) }, 409: errorResponse },
});
registry.registerPath({
  method: 'post', path: '/api/v1/invoices/{id}/post', tags: ['Invoices'], summary: 'Post a draft invoice — creates its journal entry',
  security: AUTH, request: { headers: tenantParams, params: z.object({ id: uuid() }) },
  responses: { 200: { description: 'OK', ...json(z.object({ invoice, journalEntry })) }, 422: errorResponse },
});

// ---- journal entries ------------------------------------------------------------
const manualLine = z.object({ accountId: uuid(), debit: z.number().min(0).default(0), credit: z.number().min(0).default(0), partyId: uuid().optional(), description: z.string().optional() });

registry.registerPath({
  method: 'post', path: '/api/v1/journal-entries', tags: ['Journal Entries'], summary: 'Post a manual journal voucher',
  security: AUTH, request: { headers: tenantParams, body: { content: { 'application/json': { schema: z.object({ entryDate: dateStr(), narration: z.string(), lines: z.array(manualLine).min(2) }) } } } },
  responses: { 201: { description: 'Created', ...json(journalEntry) }, 422: errorResponse },
});
registry.registerPath({
  method: 'get', path: '/api/v1/journal-entries', tags: ['Journal Entries'], summary: 'List journal entries',
  security: AUTH, request: { headers: tenantParams, query: z.object({ page: z.number().optional() }) },
  responses: { 200: { description: 'OK', ...json(z.array(journalEntry)) } },
});
registry.registerPath({
  method: 'get', path: '/api/v1/journal-entries/{id}', tags: ['Journal Entries'], summary: 'Get a journal entry',
  security: AUTH, request: { headers: tenantParams, params: z.object({ id: uuid() }) },
  responses: { 200: { description: 'OK', ...json(journalEntry) }, 404: errorResponse },
});
registry.registerPath({
  method: 'post', path: '/api/v1/journal-entries/{id}/reverse', tags: ['Journal Entries'], summary: 'Reverse a posted entry with an offsetting entry',
  security: AUTH, request: { headers: tenantParams, params: z.object({ id: uuid() }), body: { content: { 'application/json': { schema: z.object({ reason: z.string(), reversalDate: dateStr().optional() }) } } } },
  responses: { 200: { description: 'OK', ...json(z.object({ original: journalEntry, reversal: journalEntry })) }, 422: errorResponse },
});

// ---- receipts ---------------------------------------------------------------
const receipt = z.object({ id: uuid(), docType: z.literal('receipt'), docNo: z.string(), grandTotal: money(), outstandingAmount: money() });

registry.registerPath({
  method: 'post', path: '/api/v1/receipts', tags: ['Receipts'], summary: 'Record a customer receipt and allocate it against invoices',
  security: AUTH,
  request: {
    headers: [...tenantParams, z.string().optional().openapi({ param: { name: 'Idempotency-Key', in: 'header' } })],
    body: { content: { 'application/json': { schema: z.object({
      partyId: uuid(), docDate: dateStr(), depositAccountId: uuid(), amount: z.number().positive(),
      allocations: z.array(z.object({ invoiceId: uuid(), amount: z.number().positive() })),
    }) } } },
  },
  responses: { 201: { description: 'Created', ...json(z.object({ receipt, journalEntry })) }, 422: errorResponse },
});
registry.registerPath({
  method: 'get', path: '/api/v1/receipts/{id}', tags: ['Receipts'], summary: 'Get a receipt',
  security: AUTH, request: { headers: tenantParams, params: z.object({ id: uuid() }) },
  responses: { 200: { description: 'OK', ...json(receipt) }, 404: errorResponse },
});

// ---- credit notes -------------------------------------------------------------
const creditNote = z.object({ id: uuid(), docType: z.literal('credit_note'), docNo: z.string(), parentDocumentId: uuid(), grandTotal: money() });

registry.registerPath({
  method: 'post', path: '/api/v1/credit-notes', tags: ['Credit Notes'], summary: 'Issue a credit note against a posted invoice',
  security: AUTH, request: { headers: tenantParams, body: { content: { 'application/json': { schema: z.object({ invoiceId: uuid(), docDate: dateStr(), lines: z.array(invoiceLineInput).min(1) }) } } } },
  responses: { 201: { description: 'Created', ...json(z.object({ creditNote, journalEntry, invoiceOutstandingAfter: money() })) }, 422: errorResponse },
});
registry.registerPath({
  method: 'get', path: '/api/v1/credit-notes/{id}', tags: ['Credit Notes'], summary: 'Get a credit note',
  security: AUTH, request: { headers: tenantParams, params: z.object({ id: uuid() }) },
  responses: { 200: { description: 'OK', ...json(creditNote) }, 404: errorResponse },
});

// ---- banking / reconciliation ----------------------------------------------------
const bankAccount = z.object({ id: uuid(), accountId: uuid(), bankName: z.string(), accountNoMasked: z.string() });
const statementLine = z.object({ id: uuid(), txnDate: dateStr(), description: z.string(), debit: money(), credit: money(), status: z.enum(['unmatched', 'suggested', 'matched', 'ignored', 'reconciled']), matchConfidence: z.string().nullable(), matchedBy: z.string().nullable() });
const importResult = z.object({ statement: z.object({ id: uuid() }), imported: z.number(), autoMatched: z.number(), suggested: z.number(), unmatched: z.number() });
const reconciliation = z.object({ id: uuid(), bookBalance: money(), bankBalance: money(), difference: money(), status: z.enum(['in_progress', 'completed']) });

registry.registerPath({
  method: 'get', path: '/api/v1/bank-accounts', tags: ['Banking'], summary: 'List bank accounts',
  security: AUTH, request: { headers: tenantParams }, responses: { 200: { description: 'OK', ...json(z.array(bankAccount)) } },
});
registry.registerPath({
  method: 'post', path: '/api/v1/bank-accounts', tags: ['Banking'], summary: 'Link a GL account as a bank account',
  security: AUTH, request: { headers: tenantParams, body: { content: { 'application/json': { schema: z.object({ accountId: uuid(), bankName: z.string(), accountNoMasked: z.string() }) } } } },
  responses: { 201: { description: 'Created', ...json(bankAccount) } },
});
registry.registerPath({
  method: 'post', path: '/api/v1/bank-accounts/{id}/statements', tags: ['Banking'], summary: 'Upload a bank statement CSV (idempotent by file hash) — runs the matcher synchronously',
  security: AUTH,
  request: {
    headers: [...tenantParams, z.string().optional().openapi({ param: { name: 'Idempotency-Key', in: 'header' } })],
    params: z.object({ id: uuid() }),
    body: { content: { 'multipart/form-data': { schema: { type: 'object', properties: {
      file: { type: 'string', format: 'binary', description: 'CSV file, text/csv or application/vnd.ms-excel, <= 2MB, <= 5000 rows' },
      columnMapping: { type: 'string', description: 'JSON string: {dateFormat, columns: {date, description, reference, debit, credit, balance}}' },
    }, required: ['file', 'columnMapping'] } } } },
  },
  responses: { 200: { description: 'OK', ...json(importResult) }, 422: errorResponse },
});
registry.registerPath({
  method: 'get', path: '/api/v1/statements/{id}/lines', tags: ['Banking'], summary: 'List a statement’s lines',
  security: AUTH, request: { headers: tenantParams, params: z.object({ id: uuid() }) },
  responses: { 200: { description: 'OK', ...json(z.object({ lines: z.array(statementLine) })) } },
});
registry.registerPath({
  method: 'post', path: '/api/v1/lines/{id}/match', tags: ['Banking'], summary: 'Manually match a statement line to a journal line',
  security: AUTH, request: { headers: tenantParams, params: z.object({ id: uuid() }), body: { content: { 'application/json': { schema: z.object({ journalLineId: uuid() }) } } } },
  responses: { 200: { description: 'OK', ...json(statementLine) } },
});
registry.registerPath({
  method: 'post', path: '/api/v1/lines/{id}/create-entry', tags: ['Banking'], summary: 'Post a real journal entry for an unmatched line (bank charge, interest, etc) and auto-match it',
  security: AUTH, request: { headers: tenantParams, params: z.object({ id: uuid() }), body: { content: { 'application/json': { schema: z.object({ accountId: uuid(), narration: z.string().optional() }) } } } },
  responses: { 201: { description: 'Created', ...json(z.object({ statementLine, journalEntryId: uuid() })) } },
});
registry.registerPath({
  method: 'post', path: '/api/v1/lines/{id}/ignore', tags: ['Banking'], summary: 'Mark a statement line as an internal transfer, excluded from the difference',
  security: AUTH, request: { headers: tenantParams, params: z.object({ id: uuid() }), body: { content: { 'application/json': { schema: z.object({ reason: z.string() }) } } } },
  responses: { 200: { description: 'OK', ...json(statementLine) } },
});
registry.registerPath({
  method: 'post', path: '/api/v1/reconciliations', tags: ['Banking'], summary: 'Start a reconciliation for a bank statement as of a date',
  security: AUTH, request: { headers: tenantParams, body: { content: { 'application/json': { schema: z.object({ bankAccountId: uuid(), statementId: uuid(), asOfDate: dateStr() }) } } } },
  responses: { 201: { description: 'Created', ...json(reconciliation) } },
});
registry.registerPath({
  method: 'post', path: '/api/v1/reconciliations/{id}/complete', tags: ['Banking'], summary: 'Complete a reconciliation — requires zero difference and zero unresolved lines',
  security: AUTH, request: { headers: tenantParams, params: z.object({ id: uuid() }) },
  responses: { 200: { description: 'OK', ...json(reconciliation) }, 422: errorResponse },
});

// ---- reports ------------------------------------------------------------------
const integrity = z.object({ balanced: z.boolean() });

registry.registerPath({
  method: 'get', path: '/api/v1/reports/trial-balance', tags: ['Reports'], summary: 'Trial balance as of a date',
  security: AUTH, request: { headers: tenantParams, query: z.object({ asOf: dateStr().optional() }) },
  responses: { 200: { description: 'OK', ...json(z.object({ rows: z.array(z.object({ code: z.string(), debitBalance: money(), creditBalance: money() })), totals: z.object({ debit: money(), credit: money() }), integrity })) } },
});
registry.registerPath({
  method: 'get', path: '/api/v1/reports/ar-aging', tags: ['Reports'], summary: 'AR aging buckets, self-checked against the control account',
  security: AUTH, request: { headers: tenantParams, query: z.object({ asOf: dateStr().optional() }) },
  responses: { 200: { description: 'OK', ...json(z.object({ rows: z.array(z.object({ partyId: uuid(), total: money() })), totals: z.object({ grandTotal: money() }), integrity: z.object({ balanced: z.boolean(), arControlBalance: money() }) })) } },
});
registry.registerPath({
  method: 'get', path: '/api/v1/reports/general-ledger', tags: ['Reports'], summary: 'Running-balance ledger for one account over a date range',
  security: AUTH, request: { headers: tenantParams, query: z.object({ accountId: uuid(), from: dateStr(), to: dateStr() }) },
  responses: { 200: { description: 'OK', ...json(z.object({ account: z.object({ code: z.string() }), openingBalance: money(), lines: z.array(z.object({ runningBalance: money() })), closingBalance: money() })) } },
});
registry.registerPath({
  method: 'get', path: '/api/v1/reports/profit-loss', tags: ['Reports'], summary: 'Profit & loss over a date range',
  security: AUTH, request: { headers: tenantParams, query: z.object({ from: dateStr().optional(), to: dateStr().optional() }) },
  responses: { 200: { description: 'OK', ...json(z.object({ revenueTotal: money(), expenseTotal: money(), netProfit: money() })) } },
});
registry.registerPath({
  method: 'get', path: '/api/v1/reports/balance-sheet', tags: ['Reports'], summary: 'Balance sheet as of a date, with computed Current Year Earnings',
  security: AUTH, request: { headers: tenantParams, query: z.object({ asOf: dateStr().optional() }) },
  responses: { 200: { description: 'OK', ...json(z.object({ totals: z.object({ assets: money(), liabilities: money(), equity: money() }), integrity: z.object({ balanced: z.boolean(), difference: money() }) })) } },
});
registry.registerPath({
  method: 'get', path: '/api/v1/reports/bank-reconciliation', tags: ['Reports'], summary: 'Live book/bank/difference summary for a bank account',
  security: AUTH, request: { headers: tenantParams, query: z.object({ bankAccountId: uuid(), statementId: uuid().optional(), asOf: dateStr().optional() }) },
  responses: { 200: { description: 'OK', ...json(z.object({ bookBalance: money(), bankBalance: money(), difference: money() })) } },
});

const generator = new OpenApiGeneratorV3(registry.definitions);

export const openApiDocument = generator.generateDocument({
  openapi: '3.0.0',
  info: {
    title: 'Ledgerline API',
    version: '1.0.0',
    description: 'Multi-tenant double-entry accounting API. Every write goes through a posting engine that only ever produces balanced journal entries — see the invariant test suite for the proof.',
  },
  servers: [{ url: '/' }],
});
