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
import { ReceiptPage } from './ReceiptPage.jsx';

const partyId = '11111111-1111-4111-8111-111111111111';
const invoiceId = '44444444-4444-4444-8444-444444444444';
const bankAccountId = '22222222-2222-4222-8222-222222222225';

function renderReceipt() {
  return render(
    <QueryClientProvider client={createAppQueryClient()}>
      <MemoryRouter initialEntries={['/receipts/new']}>
        <ToastProvider>
          <Routes>
            <Route element={<Outlet context={{ activeOrganizationId: 'org-1', activeOrganization: { permissions: ['payment.create', 'report.view'] } }} />}>
              <Route path="/receipts/new" element={<ReceiptPage />} />
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

describe('Day 4 receipt allocation', () => {
  it('allocates a customer receipt and shows the unallocated remainder and balanced journal', async () => {
    const user = userEvent.setup();
    let submitted;
    server.use(
      http.get('/api/v1/parties', () => HttpResponse.json([{ id: partyId, code: 'CUS-001', name: 'Himalayan Trek Supplies', type: 'customer', isActive: true }])),
      http.get('/api/v1/accounts', () => HttpResponse.json([{ id: bankAccountId, code: '1010', name: 'Nabil Bank', type: 'ASSET', isBankAccount: true, isActive: true }])),
      http.get('/api/v1/invoices', () => HttpResponse.json([{ id: invoiceId, docNo: 'INV-2082-0001', docDate: '2025-07-20', dueDate: '2025-08-19', partyId, status: 'posted', grandTotal: '113000.00', outstandingAmount: '113000.00' }])),
      http.post('/api/v1/receipts', async ({ request }) => {
        submitted = await request.json();
        return HttpResponse.json({
          receipt: { id: 'receipt-1', docNo: 'REC-2082-0001', docDate: '2025-08-20', partyId, status: 'posted', grandTotal: '60000.00', allocatedAmount: '50000.00', outstandingAmount: '10000.00', journalEntryId: 'journal-1' },
          allocations: [{ invoiceId, amount: '50000.00' }],
          journalEntry: { id: 'journal-1', entryNumber: 'JE-2082-0002', lines: [{ id: 'dr', accountId: bankAccountId, debit: '60000.00', credit: '0.00' }, { id: 'cr', accountId: bankAccountId, debit: '0.00', credit: '60000.00' }] },
        }, { status: 201 });
      }),
    );

    renderReceipt();
    await user.selectOptions(await screen.findByLabelText('Customer'), partyId);
    await user.selectOptions(await screen.findByLabelText('Deposit account'), bankAccountId);
    await user.type(screen.getByLabelText('Receipt date'), '2025-08-20');
    await user.type(screen.getByLabelText('Amount received'), '60000.00');
    const row = (await screen.findByText('INV-2082-0001')).closest('tr');
    await user.type(within(row).getByLabelText('Allocate to INV-2082-0001'), '50000.00');

    expect(screen.getByText(/10,000\.00/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Post receipt' }));

    expect(await screen.findByText('REC-2082-0001')).toBeInTheDocument();
    expect(screen.getByText('Debits equal credits')).toBeInTheDocument();
    expect(submitted.allocations).toEqual([{ invoiceId, amount: '50000.00' }]);
  });

  it('blocks an allocation above the invoice outstanding amount', async () => {
    const user = userEvent.setup();
    server.use(http.get('/api/v1/invoices', () => HttpResponse.json([{ id: invoiceId, docNo: 'INV-2082-0001', docDate: '2025-07-20', dueDate: '2025-08-19', partyId, status: 'posted', grandTotal: '113000.00', outstandingAmount: '113000.00' }])));
    renderReceipt();
    await user.selectOptions(await screen.findByLabelText('Customer'), partyId);
    await user.type(screen.getByLabelText('Amount received'), '120000.00');
    const allocation = await screen.findByLabelText('Allocate to INV-2082-0001');
    await user.type(allocation, '114000.00');
    await user.click(screen.getByRole('button', { name: 'Post receipt' }));
    expect(screen.getByText('An allocation cannot exceed the invoice outstanding amount.')).toBeInTheDocument();
  });
});
