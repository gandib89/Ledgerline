import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { ToastProvider } from '../components/ToastProvider.jsx';
import { resetApiClient, setActiveOrganization } from '../lib/api-client.js';
import { server } from '../mocks/server.js';
import { createAppQueryClient } from '../query-client.js';
import { SupplierPaymentDetailPage } from './SupplierPaymentDetailPage.jsx';
import { SupplierPaymentPage } from './SupplierPaymentPage.jsx';

const supplierId = '11111111-1111-4111-8111-111111111111';
const customerId = '11111111-1111-4111-8111-111111111112';
const bankId = '22222222-2222-4222-8222-222222222225';
const cashId = '22222222-2222-4222-8222-222222222224';
const expenseId = '22222222-2222-4222-8222-222222222223';
const apId = '22222222-2222-4222-8222-222222222226';
const billId = '44444444-4444-4444-8444-444444444444';
const paymentId = '77777777-7777-4777-8777-777777777777';
const journalId = '55555555-5555-4555-8555-555555555555';

const suppliers = [
  { id: supplierId, code: 'SUP-001', name: 'Kathmandu Stationers', type: 'supplier', isActive: true },
  { id: customerId, code: 'CUS-001', name: 'Himalayan Trek', type: 'customer', isActive: true },
];
const accounts = [
  { id: bankId, code: '1020', name: 'Nabil Bank', type: 'ASSET', isBankAccount: true, isActive: true },
  { id: cashId, code: '1010', name: 'Cash in Hand', type: 'ASSET', isBankAccount: false, isActive: true },
  { id: expenseId, code: '5100', name: 'Office Supplies', type: 'EXPENSE', isBankAccount: false, isActive: true },
  { id: apId, code: '2100', name: 'Accounts Payable', type: 'LIABILITY', isBankAccount: false, isActive: true },
];
const openBill = { id: billId, docNo: 'BILL-2082-0001', referenceNo: 'INV-12', docDate: '2025-07-20', dueDate: '2025-08-19', partyId: supplierId, status: 'posted', grandTotal: '2825.00', outstandingAmount: '2825.00' };

function renderAt(path, element, routePath, permissions) {
  return render(
    <QueryClientProvider client={createAppQueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <ToastProvider>
          <Routes>
            <Route element={<Outlet context={{ activeOrganizationId: 'org-1', activeOrganization: permissions === null ? {} : { permissions } }} />}>
              <Route path={routePath} element={element} />
            </Route>
          </Routes>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const renderForm = (permissions = ['supplier_payment.create', 'report.view']) =>
  renderAt('/supplier-payments/new', <SupplierPaymentPage />, '/supplier-payments/new', permissions);

function serveForm() {
  server.use(
    http.get('/api/v1/parties', () => HttpResponse.json(suppliers)),
    http.get('/api/v1/accounts', () => HttpResponse.json(accounts)),
    http.get('/api/v1/bills', ({ request }) => {
      const url = new URL(request.url);
      const status = url.searchParams.get('status');
      const wanted = url.searchParams.get('partyId') === supplierId && status === 'posted';
      return HttpResponse.json(wanted ? [openBill] : []);
    }),
  );
}

beforeEach(() => {
  resetApiClient();
  setActiveOrganization('org-1');
});

describe('Supplier Payment form', () => {
  it('shows the Supplier\'s open Bills, allocates part of a payment and posts it with an Idempotency-Key', async () => {
    const user = userEvent.setup();
    serveForm();
    let submitted;
    let key;
    server.use(http.post('/api/v1/supplier-payments', async ({ request }) => {
      submitted = await request.json();
      key = request.headers.get('Idempotency-Key');
      return HttpResponse.json({
        supplierPayment: { id: paymentId, docNo: 'SPAY-2082-0001', grandTotal: '3000.00', allocatedAmount: '2825.00', outstandingAmount: '175.00' },
        allocations: [{ billId, amount: '2825.00', billOutstandingAfter: '0.00' }],
        journalEntry: { id: journalId, lines: [{ id: 'dr', accountId: apId, debit: '3000.00', credit: '0.00' }, { id: 'cr', accountId: bankId, debit: '0.00', credit: '3000.00' }] },
      }, { status: 201 });
    }));

    renderForm();
    // Only Suppliers are offered; the Customer is not.
    const supplierSelect = await screen.findByLabelText('Supplier');
    expect(within(supplierSelect).queryByText(/Himalayan Trek/)).not.toBeInTheDocument();
    await user.selectOptions(supplierSelect, supplierId);
    // Paid-from lists the bank account and Cash in Hand only.
    const paidFrom = screen.getByLabelText('Paid from');
    expect(within(paidFrom).getByText(/Nabil Bank/)).toBeInTheDocument();
    expect(within(paidFrom).getByText(/Cash in Hand/)).toBeInTheDocument();
    expect(within(paidFrom).queryByText(/Office Supplies/)).not.toBeInTheDocument();
    await user.selectOptions(paidFrom, bankId);
    await user.type(screen.getByLabelText('Payment date'), '2025-08-01');
    await user.type(screen.getByLabelText('Amount paid'), '3000.00');
    const row = (await screen.findByText('BILL-2082-0001')).closest('tr');
    expect(within(row).getByText('INV-12')).toBeInTheDocument();
    await user.type(within(row).getByLabelText('Allocate to BILL-2082-0001'), '2825.00');

    expect(screen.getByText('Unapplied amount').nextSibling).toHaveTextContent('175.00');
    await user.click(screen.getByRole('button', { name: 'Post supplier payment' }));

    expect(await screen.findByText('SPAY-2082-0001')).toBeInTheDocument();
    expect(screen.getByText('Debits equal credits')).toBeInTheDocument();
    expect(submitted).toMatchObject({
      partyId: supplierId, docDate: '2025-08-01', paidFromAccountId: bankId, amount: '3000.00',
      allocations: [{ billId, amount: '2825.00' }],
    });
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('blocks an allocation above the Bill outstanding amount and above the payment amount', async () => {
    const user = userEvent.setup();
    serveForm();
    renderForm();
    await user.selectOptions(await screen.findByLabelText('Supplier'), supplierId);
    await user.type(screen.getByLabelText('Amount paid'), '5000.00');
    await user.type(await screen.findByLabelText('Allocate to BILL-2082-0001'), '2825.01');
    await user.click(screen.getByRole('button', { name: 'Post supplier payment' }));
    expect(screen.getByText('An allocation cannot exceed the Bill outstanding amount.')).toBeInTheDocument();

    await user.clear(screen.getByLabelText('Amount paid'));
    await user.type(screen.getByLabelText('Amount paid'), '100.00');
    await user.clear(screen.getByLabelText('Allocate to BILL-2082-0001'));
    await user.type(screen.getByLabelText('Allocate to BILL-2082-0001'), '200.00');
    await user.click(screen.getByRole('button', { name: 'Post supplier payment' }));
    expect(screen.getByText('Allocated total cannot exceed the payment amount.')).toBeInTheDocument();
  });

  it('hides the form without supplier_payment.create', async () => {
    serveForm();
    renderForm(['report.view']);
    expect(await screen.findByText('Permission required')).toBeInTheDocument();
    expect(screen.queryByLabelText('Supplier')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Post supplier payment' })).not.toBeInTheDocument();
  });

  it('defaults to hidden when the permission list is missing altogether', async () => {
    serveForm();
    renderForm(null);
    expect(await screen.findByText('Permission required')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Post supplier payment' })).not.toBeInTheDocument();
  });
});

describe('Supplier Payment detail', () => {
  it('shows the amount, paid-from account, allocations, Unapplied Amount and journal entry', async () => {
    server.use(
      http.get('/api/v1/supplier-payments/:id', () => HttpResponse.json({
        id: paymentId, docType: 'supplier_payment', docNo: 'SPAY-2082-0001', docDate: '2025-08-01', partyId: supplierId, status: 'posted',
        referenceNo: 'CHQ-9', notes: null, grandTotal: '3000.00', allocatedAmount: '2825.00', outstandingAmount: '175.00', journalEntryId: journalId,
        allocations: [{ billId, amount: '2825.00', allocatedAt: '2025-08-01T08:00:00.000Z' }],
      })),
      http.get('/api/v1/parties', () => HttpResponse.json(suppliers)),
      http.get('/api/v1/accounts', () => HttpResponse.json(accounts)),
      http.get(`/api/v1/bills/${billId}`, () => HttpResponse.json({ ...openBill, status: 'paid', outstandingAmount: '0.00' })),
      http.get(`/api/v1/journal-entries/${journalId}`, () => HttpResponse.json({
        id: journalId, entryNumber: 'JE-2082-0007', documentType: 'supplierPayment', entryDate: '2025-08-01', description: 'Supplier Payment SPAY-2082-0001', status: 'posted',
        lines: [
          { id: 'dr', accountId: apId, partyId: supplierId, debit: '3000.00', credit: '0.00', description: 'Accounts Payable', lineNumber: 1 },
          { id: 'cr', accountId: bankId, partyId: null, debit: '0.00', credit: '3000.00', description: 'Supplier payment', lineNumber: 2 },
        ],
      })),
    );

    renderAt(`/supplier-payments/${paymentId}`, <SupplierPaymentDetailPage />, '/supplier-payments/:id', ['report.view']);

    expect(await screen.findByRole('heading', { name: 'SPAY-2082-0001' })).toBeInTheDocument();
    expect(screen.getByText(/Kathmandu Stationers/)).toBeInTheDocument();
    expect(screen.getByText('1020 · Nabil Bank', { selector: 'strong' })).toBeInTheDocument(); // paid-from, from the credit line
    const link = await screen.findByRole('link', { name: 'BILL-2082-0001' });
    expect(link).toHaveAttribute('href', `/bills/${billId}`);
    expect(screen.getByText('Unapplied').nextSibling).toHaveTextContent('175.00');
    expect(await screen.findByText('JE-2082-0007')).toBeInTheDocument();
    expect(screen.getByText('Debits equal credits')).toBeInTheDocument();
  });
});
