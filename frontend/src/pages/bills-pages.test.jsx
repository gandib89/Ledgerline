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
import { BillDetailPage } from './BillDetailPage.jsx';
import { BillEditorPage } from './BillEditorPage.jsx';
import { BillsPage } from './BillsPage.jsx';

const SUPPLIER_ID = '11111111-1111-4111-8111-111111111111';
const EXPENSE_ID = '22222222-2222-4222-8222-222222222222';
const ASSET_ID = '22222222-2222-4222-8222-222222222223';
const CONTROL_ID = '22222222-2222-4222-8222-222222222224';
const BANK_ID = '22222222-2222-4222-8222-222222222225';
const TAX_ID = '33333333-3333-4333-8333-333333333333';
const BILL_ID = '44444444-4444-4444-8444-444444444444';

const supplier = { id: SUPPLIER_ID, type: 'supplier', code: 'SUP-001', name: 'Kathmandu Stationers', creditDays: 30, isActive: true };
const account = (id, code, name, type, extra = {}) => ({ id, code, name, type, isControlAccount: false, isBankAccount: false, isActive: true, ...extra });
const accounts = [
  account(EXPENSE_ID, '5100', 'Office Supplies', 'EXPENSE'),
  account(ASSET_ID, '1500', 'Equipment', 'ASSET'),
  account(CONTROL_ID, '1210', 'Prepaid Control', 'ASSET', { isControlAccount: true }),
  account(BANK_ID, '1020', 'Bank - Nabil', 'ASSET', { isBankAccount: true }),
];
const taxCode = { id: TAX_ID, code: 'VAT13', name: 'VAT 13%', rate: '0.1300', type: 'VAT', isActive: true };

const draftBill = {
  id: BILL_ID,
  docType: 'bill',
  docNo: null,
  docDate: '2025-07-20',
  postingDate: '2025-07-20',
  dueDate: '2025-08-19',
  partyId: SUPPLIER_ID,
  status: 'draft',
  referenceNo: 'INV-12',
  notes: null,
  subtotal: '2500.00',
  discountAmount: '0.00',
  taxableAmount: '2500.00',
  taxAmount: '325.00',
  grandTotal: '2825.00',
  outstandingAmount: '0.00',
  journalEntryId: null,
  version: 0,
  lines: [{
    id: '66666666-6666-4666-8666-666666666666', lineNo: 1, description: 'Printer paper', accountId: EXPENSE_ID,
    quantity: '10', unitPrice: '250.00', discountPct: '0.00', taxCodeId: TAX_ID,
    taxableAmount: '2500.00', taxAmount: '325.00', lineTotal: '2825.00',
  }],
};

function renderBills(path, permissions = ['bill.create', 'report.view']) {
  return render(
    <QueryClientProvider client={createAppQueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <ToastProvider>
          <Routes>
            <Route element={<Outlet context={{ activeOrganizationId: 'org-1', activeOrganization: { id: 'org-1', name: 'Annapurna', permissions } }} />}>
              <Route path="/bills" element={<BillsPage />} />
              <Route path="/bills/new" element={<BillEditorPage />} />
              <Route path="/bills/:id/edit" element={<BillEditorPage />} />
              <Route path="/bills/:id" element={<BillDetailPage />} />
            </Route>
          </Routes>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

let partyQueries;
let accountQueries;

beforeEach(() => {
  resetApiClient();
  setActiveOrganization('org-1');
  partyQueries = [];
  accountQueries = [];
  server.use(
    http.get('/api/v1/parties', ({ request }) => {
      partyQueries.push(new URL(request.url).searchParams.get('type'));
      return HttpResponse.json([supplier]);
    }),
    http.get('/api/v1/accounts', ({ request }) => {
      const type = new URL(request.url).searchParams.get('type');
      accountQueries.push(type);
      return HttpResponse.json(type ? accounts.filter((a) => a.type === type) : accounts);
    }),
    http.get('/api/v1/tax-codes', () => HttpResponse.json([taxCode])),
  );
});

describe('Bills list', () => {
  it('shows supplier reference, supplier, status and total, and sends the supplier and status filters', async () => {
    const user = userEvent.setup();
    let lastQuery = '';
    server.use(http.get('/api/v1/bills', ({ request }) => {
      lastQuery = new URL(request.url).search;
      return HttpResponse.json([{ ...draftBill, lines: undefined }]);
    }));

    renderBills('/bills');

    const row = (await screen.findByRole('link', { name: 'INV-12' })).closest('tr');
    expect(within(row).getByText('Kathmandu Stationers')).toBeInTheDocument();
    expect(within(row).getByText('Draft')).toBeInTheDocument();
    expect(within(row).getByText(/2,825\.00/)).toBeInTheDocument();
    expect(partyQueries).toContain('supplier'); // server-side type filter

    await user.selectOptions(screen.getByLabelText('Bill supplier'), SUPPLIER_ID);
    await waitFor(() => expect(lastQuery).toContain(`partyId=${SUPPLIER_ID}`));
    await user.selectOptions(screen.getByLabelText('Bill status'), 'draft');
    await waitFor(() => expect(lastQuery).toContain('status=draft'));
  });

  it('offers New bill with bill.create and hides it without', async () => {
    server.use(http.get('/api/v1/bills', () => HttpResponse.json([{ ...draftBill, lines: undefined }])));
    const { unmount } = renderBills('/bills');
    expect(await screen.findByRole('link', { name: 'New bill' })).toHaveAttribute('href', '/bills/new');
    unmount();

    renderBills('/bills', ['report.view']);
    await screen.findByRole('link', { name: 'INV-12' });
    expect(screen.queryByRole('link', { name: 'New bill' })).not.toBeInTheDocument();
  });

  it('hides New bill when the organization has no permission list', async () => {
    server.use(http.get('/api/v1/bills', () => HttpResponse.json([])));
    renderBills('/bills', null);
    await screen.findByText('No bills found');
    expect(screen.queryByRole('link', { name: 'New bill' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Create bill' })).not.toBeInTheDocument();
  });
});

describe('Bill editor', () => {
  it('validates the Supplier, Supplier Reference, Bill date and line account before saving', async () => {
    const user = userEvent.setup();
    let saved = false;
    server.use(http.post('/api/v1/bills', () => { saved = true; return HttpResponse.json(draftBill, { status: 201 }); }));

    renderBills('/bills/new');
    await user.click(await screen.findByRole('button', { name: 'Save draft' }));

    expect(screen.getByText('Supplier is required')).toBeInTheDocument();
    expect(screen.getByText('Supplier reference is required')).toBeInTheDocument();
    expect(screen.getByText('Bill date is required')).toBeInTheDocument();
    expect(screen.getByText('Account is required')).toBeInTheDocument();
    expect(screen.getByText('Description is required')).toBeInTheDocument();
    expect(saved).toBe(false);
  });

  it('treats a blank-looking Supplier Reference as missing and rejects a Posting Date before the Bill date', async () => {
    const user = userEvent.setup();
    renderBills('/bills/new');

    await user.selectOptions(await screen.findByLabelText('Supplier'), SUPPLIER_ID);
    await user.type(screen.getByLabelText('Supplier reference'), '   ');
    await user.type(screen.getByLabelText('Bill date'), '2025-07-20');
    await user.type(screen.getByLabelText('Posting date'), '2025-07-10');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    expect(screen.getByText('Supplier reference is required')).toBeInTheDocument();
    expect(screen.getByText('Posting date cannot be before bill date')).toBeInTheDocument();
  });

  it('offers only suppliers and expense or asset accounts that are neither control nor bank', async () => {
    renderBills('/bills/new');

    const account = await screen.findByLabelText('Line 1 account');
    const options = within(account).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Select account', '5100 · Office Supplies', '1500 · Equipment']);
    expect(partyQueries).toEqual(['supplier']);
    expect(accountQueries.sort()).toEqual(['ASSET', 'EXPENSE']);
  });

  it('shows server-calculated totals and saves only the accounting inputs', async () => {
    const user = userEvent.setup();
    let savedBody;
    server.use(
      http.post('/api/v1/bills/preview', () => HttpResponse.json({
        lines: [{ lineNo: 1, taxableAmount: '2500.00', taxAmount: '325.00', lineTotal: '2825.00' }],
        totals: { subtotal: '2500.00', discountAmount: '0.00', taxableAmount: '2500.00', taxAmount: '325.00', grandTotal: '2825.00' },
      })),
      http.post('/api/v1/bills', async ({ request }) => {
        savedBody = await request.json();
        return HttpResponse.json(draftBill, { status: 201 });
      }),
      http.get('/api/v1/bills/:id', () => HttpResponse.json(draftBill)),
    );

    renderBills('/bills/new');
    await user.selectOptions(await screen.findByLabelText('Supplier'), SUPPLIER_ID);
    await user.type(screen.getByLabelText('Supplier reference'), '  INV-12 ');
    await user.type(screen.getByLabelText('Bill date'), '2025-07-20');
    await user.type(screen.getByLabelText('Line 1 description'), 'Printer paper');
    await user.selectOptions(screen.getByLabelText('Line 1 account'), EXPENSE_ID);
    await user.clear(screen.getByLabelText('Line 1 quantity'));
    await user.type(screen.getByLabelText('Line 1 quantity'), '10');
    await user.clear(screen.getByLabelText('Line 1 unit price'));
    await user.type(screen.getByLabelText('Line 1 unit price'), '250');
    await user.selectOptions(screen.getByLabelText('Line 1 VAT'), TAX_ID);

    expect(await screen.findByText(/2,825\.00/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Bill totals' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    await screen.findByRole('heading', { name: 'Draft bill' });
    expect(savedBody).toEqual({
      partyId: SUPPLIER_ID,
      referenceNo: 'INV-12',
      docDate: '2025-07-20',
      lines: [{ accountId: EXPENSE_ID, description: 'Printer paper', quantity: 10, unitPrice: 250, discountPct: 0, taxCodeId: TAX_ID }],
    });
  });

  it('on a duplicate Supplier Reference, says it is already saved and links to the existing Bill', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/api/v1/bills/preview', () => HttpResponse.json({
        lines: [{ lineNo: 1, taxableAmount: '2500.00', taxAmount: '0.00', lineTotal: '2500.00' }],
        totals: { subtotal: '2500.00', discountAmount: '0.00', taxableAmount: '2500.00', taxAmount: '0.00', grandTotal: '2500.00' },
      })),
      http.post('/api/v1/bills', () => HttpResponse.json({
        error: {
          code: 'duplicate_supplier_reference',
          message: 'A Bill with Supplier Reference "INV-12" already exists for this Supplier. Open and edit it instead of entering it again.',
          details: { billId: BILL_ID, referenceNo: 'INV-12' },
        },
      }, { status: 409 })),
    );

    renderBills('/bills/new');
    await user.selectOptions(await screen.findByLabelText('Supplier'), SUPPLIER_ID);
    await user.type(screen.getByLabelText('Supplier reference'), 'inv-12');
    await user.type(screen.getByLabelText('Bill date'), '2025-07-20');
    await user.type(screen.getByLabelText('Line 1 description'), 'Printer paper');
    await user.selectOptions(screen.getByLabelText('Line 1 account'), EXPENSE_ID);
    await user.clear(screen.getByLabelText('Line 1 quantity'));
    await user.type(screen.getByLabelText('Line 1 quantity'), '10');
    await user.clear(screen.getByLabelText('Line 1 unit price'));
    await user.type(screen.getByLabelText('Line 1 unit price'), '250');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    const alert = await screen.findByRole('alert', { name: /already saved/i });
    expect(within(alert).getByText(/INV-12/)).toBeInTheDocument();
    expect(within(alert).getByRole('link', { name: 'Open existing bill' })).toHaveAttribute('href', `/bills/${BILL_ID}`);
  });

  it('hides the Save action without bill.create', async () => {
    renderBills('/bills/new', ['report.view']);

    await screen.findByLabelText('Supplier');
    expect(screen.queryByRole('button', { name: 'Save draft' })).not.toBeInTheDocument();
    expect(screen.getByText('Bill creation permission is required.')).toBeInTheDocument();
  });

  it('loads a draft for editing and treats a Posting Date equal to the Bill date as blank', async () => {
    server.use(http.get('/api/v1/bills/:id', () => HttpResponse.json(draftBill)));
    renderBills(`/bills/${BILL_ID}/edit`);

    expect(await screen.findByLabelText('Supplier reference')).toHaveValue('INV-12');
    expect(screen.getByLabelText('Bill date')).toHaveValue('2025-07-20');
    expect(screen.getByLabelText('Posting date')).toHaveValue('');
    expect(screen.getByLabelText('Due date')).toHaveValue('2025-08-19');
  });
});

describe('Bill detail', () => {
  it('shows the Bill with its dates and offers editing a draft only with bill.create', async () => {
    server.use(http.get('/api/v1/bills/:id', () => HttpResponse.json({ ...draftBill, postingDate: '2025-07-25' })));
    const { unmount } = renderBills(`/bills/${BILL_ID}`);

    expect(await screen.findByRole('heading', { name: 'Draft bill' })).toBeInTheDocument();
    expect(screen.getByText('Posting date 2025-07-25')).toBeInTheDocument();
    expect(screen.getByText('5100 · Office Supplies')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Edit draft' })).toHaveAttribute('href', `/bills/${BILL_ID}/edit`);
    unmount();

    renderBills(`/bills/${BILL_ID}`, ['report.view']);
    await screen.findByRole('heading', { name: 'Draft bill' });
    expect(screen.queryByRole('link', { name: 'Edit draft' })).not.toBeInTheDocument();
  });
});
