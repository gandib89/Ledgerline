import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App.jsx';
import { AuthProvider } from '../auth/AuthContext.jsx';
import { ToastProvider } from '../components/ToastProvider.jsx';
import { mockSession } from '../mocks/handlers.js';
import { server } from '../mocks/server.js';
import { createAppQueryClient } from '../query-client.js';

const invoiceId = '44444444-4444-4444-8444-444444444444';
const creditId = '77777777-7777-4777-8777-777777777777';
const receiptId = '88888888-8888-4888-8888-888888888888';
const accountId = '22222222-2222-4222-8222-222222222222';
const taxCodeId = '33333333-3333-4333-8333-333333333333';
const partyId = '11111111-1111-4111-8111-111111111111';
const invoice = {
  id: invoiceId, docNo: 'INV-2082-0003', docDate: '2025-08-15', dueDate: '2025-09-14', partyId,
  status: 'posted', referenceNo: null, notes: null, subtotal: '1000.00', discountAmount: '0.00',
  taxableAmount: '1000.00', taxAmount: '130.00', grandTotal: '1130.00', outstandingAmount: '1130.00',
  journalEntryId: null, version: 1,
  lines: [{ id: 'invoice-line', lineNo: 1, accountId, description: 'Consulting', quantity: '2.0000', unitPrice: '500.00', discountPct: '0.00', taxCodeId, taxableAmount: '1000.00', taxAmount: '130.00', lineTotal: '1130.00' }],
};
const credit = {
  id: creditId, docType: 'credit_note', docNo: 'CRN-2082-0001', docDate: '2025-08-21', partyId,
  parentDocumentId: invoiceId, status: 'posted', referenceNo: 'RETURN-1', notes: 'Service adjustment',
  subtotal: '500.00', discountAmount: '0.00', taxableAmount: '500.00', taxAmount: '65.00', grandTotal: '565.00',
  journalEntryId: null,
  lines: [{ ...invoice.lines[0], id: 'credit-line', quantity: '1.0000', taxableAmount: '500.00', taxAmount: '65.00', lineTotal: '565.00' }],
};

function renderApp(path) {
  return render(
    <QueryClientProvider client={createAppQueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <ToastProvider><AuthProvider><App /></AuthProvider></ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('credit note and receipt endpoint UI', () => {
  beforeEach(() => {
    mockSession.active = true;
    server.use(
      http.get('/api/v1/fiscal-years', () => HttpResponse.json([{ id: 'fy-1', label: 'FY 2082/83', isClosed: false }])),
      http.get('/api/v1/invoices/:id', () => HttpResponse.json(invoice)),
      http.get('/api/v1/parties', () => HttpResponse.json([{ id: partyId, code: 'CUS-001', name: 'Himalayan Trek Supplies', type: 'customer', isActive: true }])),
      http.get('/api/v1/accounts', () => HttpResponse.json([{ id: accountId, code: '4100', name: 'Service Revenue', type: 'REVENUE', isActive: true }])),
      http.get('/api/v1/tax-codes', () => HttpResponse.json([{ id: taxCodeId, code: 'VAT13', name: 'VAT 13%', rate: '0.1300', isActive: true }])),
    );
  });

  it('issues a credit note from a posted invoice and opens its detail', async () => {
    const user = userEvent.setup();
    const createCredit = vi.fn();
    server.use(
      http.post('/api/v1/credit-notes', async ({ request }) => {
        const input = await request.json(); createCredit(input);
        return HttpResponse.json({ creditNote: credit, journalEntry: { id: 'journal-credit' }, invoiceOutstandingAfter: '565.00' }, { status: 201 });
      }),
      http.get('/api/v1/credit-notes/:id', () => HttpResponse.json(credit)),
    );

    renderApp(`/invoices/${invoiceId}/credit-note`);
    expect(await screen.findByRole('heading', { name: 'Issue credit note' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Credit note date'), '2025-08-21');
    await user.type(screen.getByLabelText('Reference'), 'RETURN-1');
    const quantity = screen.getByLabelText('Line 1 quantity');
    await user.clear(quantity);
    await user.type(quantity, '1');
    await user.click(screen.getByRole('button', { name: 'Post credit note' }));

    await waitFor(() => expect(createCredit).toHaveBeenCalledWith({
      invoiceId, docDate: '2025-08-21', referenceNo: 'RETURN-1', notes: '',
      lines: [{ accountId, description: 'Consulting', quantity: '1', unitPrice: '500.00', discountPct: '0.00', taxCodeId }],
    }));
    expect(await screen.findByRole('heading', { name: 'CRN-2082-0001' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open original invoice' })).toHaveAttribute('href', `/invoices/${invoiceId}`);
  });

  it('shows a receipt, its allocation, source invoice, and journal link', async () => {
    server.use(http.get('/api/v1/receipts/:id', () => HttpResponse.json({
      id: receiptId, docNo: 'RCP-2082-0004', docDate: '2025-08-21', partyId, status: 'posted',
      referenceNo: 'BANK-44', notes: null, grandTotal: '1130.00', allocatedAmount: '1130.00', outstandingAmount: '0.00',
      journalEntryId: '66666666-6666-4666-8666-666666666661',
      allocations: [{ invoiceId, amount: '1130.00', allocatedAt: '2025-08-21T10:00:00.000Z' }],
    })));

    renderApp(`/receipts/${receiptId}`);
    expect(await screen.findByRole('heading', { name: 'RCP-2082-0004' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'INV-2082-0003' })).toHaveAttribute('href', `/invoices/${invoiceId}`);
    expect(screen.getByRole('link', { name: 'Open journal entry' })).toHaveAttribute('href', '/journals?entry=66666666-6666-4666-8666-666666666661');
  });
});
