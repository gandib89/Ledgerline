import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { ToastProvider } from '../components/ToastProvider.jsx';
import { resetApiClient, setActiveOrganization } from '../lib/api-client.js';
import { server } from '../mocks/server.js';
import { createAppQueryClient } from '../query-client.js';
import { InvoiceDetailPage } from './InvoiceDetailPage.jsx';
import { InvoiceEditorPage } from './InvoiceEditorPage.jsx';
import { InvoicesPage } from './InvoicesPage.jsx';
import { TrialBalancePage } from './TrialBalancePage.jsx';

const PARTY_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const TAX_ID = '33333333-3333-4333-8333-333333333333';
const INVOICE_ID = '44444444-4444-4444-8444-444444444444';
const JOURNAL_ID = '55555555-5555-4555-8555-555555555555';

const party = {
  id: PARTY_ID,
  type: 'customer',
  code: 'CUS-001',
  name: 'Himalayan Trek Supplies',
  email: 'accounts@himalayan.test',
  phone: null,
  creditDays: 30,
  isActive: true,
};

const account = {
  id: ACCOUNT_ID,
  code: '4100',
  name: 'Sales Revenue',
  type: 'REVENUE',
  isControlAccount: false,
  isBankAccount: false,
  isActive: true,
};

const taxCode = { id: TAX_ID, code: 'VAT13', name: 'VAT 13%', rate: '0.1300', type: 'VAT', isActive: true };

const draftInvoice = {
  id: INVOICE_ID,
  docType: 'invoice',
  docNo: null,
  docDate: '2025-07-20',
  dueDate: '2025-08-19',
  partyId: PARTY_ID,
  status: 'draft',
  referenceNo: 'PO-44',
  notes: 'Deliver to warehouse',
  subtotal: '100000.00',
  discountAmount: '0.00',
  taxableAmount: '100000.00',
  taxAmount: '13000.00',
  grandTotal: '113000.00',
  outstandingAmount: '113000.00',
  journalEntryId: null,
  version: 0,
  lines: [{
    id: '66666666-6666-4666-8666-666666666666',
    lineNo: 1,
    description: 'Trekking backpacks',
    accountId: ACCOUNT_ID,
    quantity: '10',
    unitPrice: '10000.00',
    discountPct: '0.00',
    taxCodeId: TAX_ID,
    taxableAmount: '100000.00',
    taxAmount: '13000.00',
    lineTotal: '113000.00',
  }],
};

function renderDay3(path, permissions = ['invoice.create', 'invoice.post', 'report.view']) {
  return render(
    <QueryClientProvider client={createAppQueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <ToastProvider>
          <Routes>
            <Route element={<Outlet context={{
              activeOrganizationId: 'org-1',
              activeOrganization: { id: 'org-1', name: 'Annapurna Trading', role: { name: 'Owner' }, permissions },
            }} />}>
              <Route path="/invoices" element={<InvoicesPage />} />
              <Route path="/invoices/new" element={<InvoiceEditorPage />} />
              <Route path="/invoices/:id/edit" element={<InvoiceEditorPage />} />
              <Route path="/invoices/:id" element={<InvoiceDetailPage />} />
              <Route path="/reports/trial-balance" element={<TrialBalancePage />} />
            </Route>
          </Routes>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  resetApiClient();
  setActiveOrganization('org-1');
});

describe('Day 3 invoice list', () => {
  it('shows customer, status and outstanding amount and sends selected filters', async () => {
    const user = userEvent.setup();
    let lastQuery = '';
    server.use(
      http.get('/api/v1/parties', () => HttpResponse.json([party])),
      http.get('/api/v1/invoices', ({ request }) => {
        lastQuery = new URL(request.url).search;
        return HttpResponse.json([{ ...draftInvoice, lines: undefined }]);
      }),
    );

    renderDay3('/invoices');

    const row = (await screen.findByRole('link', { name: 'Unnumbered draft' })).closest('tr');
    expect(within(row).getByText('Himalayan Trek Supplies')).toBeInTheDocument();
    expect(within(row).getByText('Draft')).toBeInTheDocument();
    expect(within(row).getByText(/113,000\.00/)).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Invoice status'), 'draft');
    await waitFor(() => expect(lastQuery).toContain('status=draft'));
  });
});

describe('Day 3 invoice editor', () => {
  it('validates required fields before saving', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/v1/parties', () => HttpResponse.json([party])),
      http.get('/api/v1/accounts', () => HttpResponse.json([account])),
      http.get('/api/v1/tax-codes', () => HttpResponse.json([taxCode])),
    );

    renderDay3('/invoices/new');
    await user.click(await screen.findByRole('button', { name: 'Save draft' }));

    expect(screen.getByText('Customer is required')).toBeInTheDocument();
    expect(screen.getByText('Revenue account is required')).toBeInTheDocument();
    expect(screen.getByText('Description is required')).toBeInTheDocument();
  });

  it('previews valid lines before the invoice header is complete', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/v1/parties', () => HttpResponse.json([party])),
      http.get('/api/v1/accounts', () => HttpResponse.json([account])),
      http.get('/api/v1/tax-codes', () => HttpResponse.json([taxCode])),
      http.post('/api/v1/invoices/preview', () => HttpResponse.json({
        lines: [{ lineNo: 1, taxableAmount: '100000.00', taxAmount: '13000.00', lineTotal: '113000.00' }],
        totals: { subtotal: '100000.00', discountAmount: '0.00', taxableAmount: '100000.00', taxAmount: '13000.00', grandTotal: '113000.00' },
      })),
    );

    renderDay3('/invoices/new');
    await user.type(await screen.findByLabelText('Line 1 description'), 'Trekking backpacks');
    await user.selectOptions(screen.getByLabelText('Line 1 revenue account'), ACCOUNT_ID);
    await user.clear(screen.getByLabelText('Line 1 unit price'));
    await user.type(screen.getByLabelText('Line 1 unit price'), '100000');
    await user.selectOptions(screen.getByLabelText('Line 1 VAT'), TAX_ID);

    expect(await screen.findByText(/113,000\.00/)).toBeInTheDocument();
  });

  it('renders server preview totals and saves only accounting inputs', async () => {
    const user = userEvent.setup();
    let savedBody;
    server.use(
      http.get('/api/v1/parties', () => HttpResponse.json([party])),
      http.get('/api/v1/accounts', () => HttpResponse.json([account])),
      http.get('/api/v1/tax-codes', () => HttpResponse.json([taxCode])),
      http.post('/api/v1/invoices/preview', async () => HttpResponse.json({
        lines: [{ lineNo: 1, taxableAmount: '100000.00', taxAmount: '13000.00', lineTotal: '113000.00' }],
        totals: { subtotal: '100000.00', discountAmount: '0.00', taxableAmount: '100000.00', taxAmount: '13000.00', grandTotal: '113000.00' },
      })),
      http.post('/api/v1/invoices', async ({ request }) => {
        savedBody = await request.json();
        return HttpResponse.json(draftInvoice, { status: 201 });
      }),
      http.get('/api/v1/invoices/:id', () => HttpResponse.json(draftInvoice)),
    );

    renderDay3('/invoices/new');

    await user.selectOptions(await screen.findByLabelText('Customer'), PARTY_ID);
    await user.type(screen.getByLabelText('Document date'), '2025-07-20');
    await user.type(screen.getByLabelText('Due date'), '2025-08-19');
    await user.type(screen.getByLabelText('Line 1 description'), 'Trekking backpacks');
    await user.selectOptions(screen.getByLabelText('Line 1 revenue account'), ACCOUNT_ID);
    await user.clear(screen.getByLabelText('Line 1 unit price'));
    await user.type(screen.getByLabelText('Line 1 unit price'), '10000');
    await user.selectOptions(screen.getByLabelText('Line 1 VAT'), TAX_ID);

    expect(await screen.findByText(/113,000\.00/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => expect(savedBody).toBeDefined());
    expect(savedBody).toMatchObject({ partyId: PARTY_ID, docDate: '2025-07-20' });
    expect(savedBody.lines[0]).toMatchObject({ accountId: ACCOUNT_ID, quantity: 1, unitPrice: 10000, taxCodeId: TAX_ID });
    expect(savedBody).not.toHaveProperty('subtotal');
    expect(savedBody).not.toHaveProperty('grandTotal');
  });

  it('sends the current version when editing and explains a version conflict', async () => {
    const user = userEvent.setup();
    let savedBody;
    server.use(
      http.get('/api/v1/parties', () => HttpResponse.json([party])),
      http.get('/api/v1/accounts', () => HttpResponse.json([account])),
      http.get('/api/v1/tax-codes', () => HttpResponse.json([taxCode])),
      http.get('/api/v1/invoices/:id', () => HttpResponse.json(draftInvoice)),
      http.post('/api/v1/invoices/preview', () => HttpResponse.json({
        lines: [{ lineNo: 1, taxableAmount: '100000.00', taxAmount: '13000.00', lineTotal: '113000.00' }],
        totals: { subtotal: '100000.00', discountAmount: '0.00', taxableAmount: '100000.00', taxAmount: '13000.00', grandTotal: '113000.00' },
      })),
      http.patch('/api/v1/invoices/:id', async ({ request }) => {
        savedBody = await request.json();
        return HttpResponse.json({ error: { code: 'version_conflict', message: 'Invoice changed in another session' } }, { status: 409 });
      }),
    );

    renderDay3(`/invoices/${INVOICE_ID}/edit`);
    await user.click(await screen.findByRole('button', { name: 'Save draft' }));

    await waitFor(() => expect(savedBody.version).toBe(0));
    expect(screen.getByText('This invoice changed in another session.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload invoice' })).toBeInTheDocument();
  });
});

describe('Day 3 invoice detail and posting', () => {
  it('hides posting when the active membership lacks invoice.post', async () => {
    server.use(
      http.get('/api/v1/invoices/:id', () => HttpResponse.json(draftInvoice)),
      http.get('/api/v1/parties', () => HttpResponse.json([party])),
      http.get('/api/v1/accounts', () => HttpResponse.json([account])),
    );

    renderDay3(`/invoices/${INVOICE_ID}`, ['report.view']);

    expect(await screen.findByText('Draft invoice')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Post invoice' })).not.toBeInTheDocument();
  });

  it('confirms posting and renders the returned balanced journal', async () => {
    const user = userEvent.setup();
    const postedInvoice = { ...draftInvoice, status: 'posted', docNo: 'INV-2082-0001', journalEntryId: JOURNAL_ID };
    const journalEntry = {
      id: JOURNAL_ID,
      entryNumber: 'JE-2082-0001',
      documentType: 'INVOICE',
      entryDate: '2025-07-20',
      description: 'Invoice INV-2082-0001',
      status: 'posted',
      sourceId: INVOICE_ID,
      postedAt: '2025-07-20T10:00:00.000Z',
      lines: [
        { id: 'line-dr', accountId: ACCOUNT_ID, partyId: PARTY_ID, debit: '113000.00', credit: '0.00', description: 'Receivable', lineNumber: 1 },
        { id: 'line-cr', accountId: ACCOUNT_ID, partyId: null, debit: '0.00', credit: '113000.00', description: 'Revenue and VAT', lineNumber: 2 },
      ],
    };
    server.use(
      http.get('/api/v1/invoices/:id', () => HttpResponse.json(draftInvoice)),
      http.get('/api/v1/parties', () => HttpResponse.json([party])),
      http.get('/api/v1/accounts', () => HttpResponse.json([account])),
      http.post('/api/v1/invoices/:id/post', () => HttpResponse.json({ invoice: postedInvoice, journalEntry })),
    );

    renderDay3(`/invoices/${INVOICE_ID}`);
    await user.click(await screen.findByRole('button', { name: 'Post invoice' }));
    let dialog = screen.getByRole('dialog', { name: 'Post invoice' });
    expect(within(dialog).getByText(/permanent journal entry/i)).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Post invoice' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Post invoice' }));
    dialog = screen.getByRole('dialog', { name: 'Post invoice' });
    await user.click(within(dialog).getByRole('button', { name: 'Confirm posting' }));

    expect(await screen.findByText('INV-2082-0001')).toBeInTheDocument();
    expect(screen.getByText('Debits equal credits')).toBeInTheDocument();
  });
});

describe('Day 3 Trial Balance', () => {
  it('renders ledger rows, totals and a textual zero-difference result', async () => {
    server.use(http.get('/api/v1/reports/trial-balance', () => HttpResponse.json({
      asOf: '2025-08-14',
      rows: [{ code: '4100', name: 'Sales Revenue', type: 'REVENUE', totalDebit: '0.00', totalCredit: '113000.00', debitBalance: '0.00', creditBalance: '113000.00' }],
      totals: { debit: '113000.00', credit: '113000.00' },
      integrity: { balanced: true, difference: '0.00' },
    })));

    renderDay3('/reports/trial-balance');

    expect(await screen.findByRole('heading', { name: 'Trial Balance' })).toBeInTheDocument();
    expect(await screen.findByText('Sales Revenue')).toBeInTheDocument();
    expect(screen.getByText('Balanced — zero difference')).toBeInTheDocument();
  });
});
