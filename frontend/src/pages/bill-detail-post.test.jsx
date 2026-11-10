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

const SUPPLIER_ID = '11111111-1111-4111-8111-111111111111';
const EXPENSE_ID = '22222222-2222-4222-8222-222222222222';
const AP_ID = '22222222-2222-4222-8222-222222222226';
const VAT_ID = '22222222-2222-4222-8222-222222222227';
const BILL_ID = '44444444-4444-4444-8444-444444444444';
const JOURNAL_ID = '55555555-5555-4555-8555-555555555555';

const supplier = { id: SUPPLIER_ID, type: 'supplier', code: 'SUP-001', name: 'Kathmandu Stationers', creditDays: 30, isActive: true };
const accounts = [
  { id: EXPENSE_ID, code: '5100', name: 'Office Supplies', type: 'EXPENSE', isActive: true },
  { id: AP_ID, code: '2100', name: 'Accounts Payable', type: 'LIABILITY', isActive: true },
  { id: VAT_ID, code: '2210', name: 'VAT Receivable (Input)', type: 'ASSET', isActive: true },
];

const draftBill = {
  id: BILL_ID, docType: 'bill', docNo: null, docDate: '2025-07-20', postingDate: '2025-07-25', dueDate: '2025-08-19',
  partyId: SUPPLIER_ID, status: 'draft', referenceNo: 'INV-12', notes: null,
  subtotal: '2500.00', discountAmount: '0.00', taxableAmount: '2500.00', taxAmount: '325.00', grandTotal: '2825.00',
  outstandingAmount: '0.00', journalEntryId: null, version: 0,
  lines: [{
    id: '66666666-6666-4666-8666-666666666666', lineNo: 1, description: 'Printer paper', accountId: EXPENSE_ID,
    quantity: '10', unitPrice: '250.00', discountPct: '0.00', taxCodeId: null,
    taxableAmount: '2500.00', taxAmount: '325.00', lineTotal: '2825.00',
  }],
};
const postedBill = { ...draftBill, status: 'posted', docNo: 'BILL-2082-0001', outstandingAmount: '2825.00', journalEntryId: JOURNAL_ID, version: 1 };
const journalEntry = {
  id: JOURNAL_ID, entryNumber: 'JE-2082-0001', documentType: 'bill', entryDate: '2025-07-25', description: 'Bill BILL-2082-0001',
  status: 'posted', sourceId: BILL_ID, reversalOfId: null, postedAt: '2025-07-25T10:00:00.000Z',
  lines: [
    { id: 'jl-1', accountId: EXPENSE_ID, partyId: null, debit: '2500.00', credit: '0.00', description: 'Printer paper', lineNumber: 1 },
    { id: 'jl-2', accountId: VAT_ID, partyId: null, debit: '325.00', credit: '0.00', description: 'VAT Receivable (Input)', lineNumber: 2 },
    { id: 'jl-3', accountId: AP_ID, partyId: SUPPLIER_ID, debit: '0.00', credit: '2825.00', description: 'Accounts Payable', lineNumber: 3 },
  ],
};

function renderDetail(permissions = ['report.view', 'bill.create', 'bill.post']) {
  return render(
    <QueryClientProvider client={createAppQueryClient()}>
      <MemoryRouter initialEntries={[`/bills/${BILL_ID}`]}>
        <ToastProvider>
          <Routes>
            <Route element={<Outlet context={{ activeOrganizationId: 'org-1', activeOrganization: { id: 'org-1', name: 'Annapurna', permissions } }} />}>
              <Route path="/bills/:id" element={<BillDetailPage />} />
            </Route>
          </Routes>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function serve(bill) {
  server.use(
    http.get('/api/v1/bills/:id', () => HttpResponse.json(bill)),
    http.get('/api/v1/parties', () => HttpResponse.json([supplier])),
    http.get('/api/v1/accounts', () => HttpResponse.json(accounts)),
    http.get('/api/v1/journal-entries/:id', () => HttpResponse.json(journalEntry)),
    http.get('/api/v1/bills/:id/payments', () => HttpResponse.json({ billId: BILL_ID, outstandingAmount: '2825.00', payments: [] })),
  );
}

beforeEach(() => {
  resetApiClient();
  setActiveOrganization('org-1');
});

describe('Bill detail: posting', () => {
  it('shows the posted Bill with its dates, totals and journal entry', async () => {
    serve(postedBill);
    renderDetail();

    expect(await screen.findByRole('heading', { name: 'BILL-2082-0001' })).toBeInTheDocument();
    expect(screen.getByText('posted')).toBeInTheDocument();
    expect(screen.getByText('Bill date 2025-07-20')).toBeInTheDocument();
    expect(screen.getByText('Posting date 2025-07-25')).toBeInTheDocument();
    expect(screen.getByText('Due 2025-08-19')).toBeInTheDocument();
    expect(screen.getByText('INV-12', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText('Printer paper', { selector: 'td' })).toBeInTheDocument();
    expect(await screen.findByText('JE-2082-0001')).toBeInTheDocument();
    expect(screen.getByText('Debits equal credits')).toBeInTheDocument();
    expect(screen.getAllByText('2100 · Accounts Payable').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Post bill' })).not.toBeInTheDocument();
  });

  it('hides Post bill without bill.post', async () => {
    serve(draftBill);
    renderDetail(['report.view', 'bill.create']);

    expect(await screen.findByText('Draft bill')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Post bill' })).not.toBeInTheDocument();
  });

  it('hides Post bill when the permission list is missing altogether', async () => {
    serve(draftBill);
    renderDetail(null);

    expect(await screen.findByText('Draft bill')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Post bill' })).not.toBeInTheDocument();
  });

  it('confirms posting, then shows the BILL number and the returned journal', async () => {
    const user = userEvent.setup();
    serve(draftBill);
    server.use(http.post('/api/v1/bills/:id/post', () => HttpResponse.json({ bill: postedBill, journalEntry })));
    renderDetail();

    await user.click(await screen.findByRole('button', { name: 'Post bill' }));
    const dialog = screen.getByRole('dialog', { name: 'Post bill' });
    await user.click(within(dialog).getByRole('button', { name: 'Confirm posting' }));

    expect(await screen.findByRole('heading', { name: 'BILL-2082-0001' })).toBeInTheDocument();
    expect(await screen.findByText('Debits equal credits')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Post bill' })).not.toBeInTheDocument();
  });

  it('keeps the dialog open and shows the server message when posting fails', async () => {
    const user = userEvent.setup();
    serve(draftBill);
    server.use(http.post('/api/v1/bills/:id/post', () => HttpResponse.json(
      { error: { code: 'period_locked', message: 'Accounting period containing 2025-07-25 is locked' } }, { status: 422 },
    )));
    renderDetail();

    await user.click(await screen.findByRole('button', { name: 'Post bill' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Post bill' })).getByRole('button', { name: 'Confirm posting' }));

    expect(await screen.findByText(/is locked/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Draft bill' })).toBeInTheDocument();
  });
});

describe('Bill detail: reversing', () => {
  const reverserPermissions = ['report.view', 'bill.post', 'journal.post'];

  it('reverses a posted Bill through its journal entry with a reason', async () => {
    const user = userEvent.setup();
    let body;
    serve(postedBill);
    server.use(
      http.post('/api/v1/journal-entries/:id/reverse', async ({ request, params }) => {
        body = { id: params.id, ...(await request.json()) };
        server.use(http.get('/api/v1/bills/:id', () => HttpResponse.json({ ...postedBill, status: 'reversed', outstandingAmount: '0.00' })));
        return HttpResponse.json({ original: { ...journalEntry, status: 'reversed' }, reversal: { ...journalEntry, id: 'rev-1', entryNumber: 'JE-2082-0002', reversalOfId: JOURNAL_ID } });
      }),
    );
    renderDetail(reverserPermissions);

    await user.click(await screen.findByRole('button', { name: 'Reverse bill' }));
    const dialog = screen.getByRole('dialog', { name: 'Reverse bill' });
    await user.type(within(dialog).getByLabelText('Reason'), 'Entered twice');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm reversal' }));

    await waitFor(() => expect(body).toEqual({ id: JOURNAL_ID, reason: 'Entered twice' }));
    expect(await screen.findByText('reversed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reverse bill' })).not.toBeInTheDocument();
  });

  it('shows the server message when a Bill with payments cannot be reversed', async () => {
    const user = userEvent.setup();
    serve(postedBill);
    server.use(http.post('/api/v1/journal-entries/:id/reverse', () => HttpResponse.json(
      { error: { code: 'cannot_reverse_bill_with_payments', message: 'Bill has payments applied — reverse the Supplier Payment first' } }, { status: 422 },
    )));
    renderDetail(reverserPermissions);

    await user.click(await screen.findByRole('button', { name: 'Reverse bill' }));
    const dialog = screen.getByRole('dialog', { name: 'Reverse bill' });
    await user.type(within(dialog).getByLabelText('Reason'), 'oops');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm reversal' }));

    expect((await screen.findAllByText(/reverse the Supplier Payment first/)).length).toBeGreaterThan(0);
  });

  it('offers Reverse bill only to journal.post holders and only while the Bill is posted', async () => {
    serve(postedBill);
    const { unmount } = renderDetail(['report.view', 'bill.post']);
    expect(await screen.findByRole('heading', { name: 'BILL-2082-0001' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reverse bill' })).not.toBeInTheDocument();
    unmount();

    serve({ ...postedBill, status: 'partially_paid' });
    renderDetail(reverserPermissions);
    expect(await screen.findByRole('heading', { name: 'BILL-2082-0001' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reverse bill' })).not.toBeInTheDocument();
  });
});

describe('Bill detail: payments applied', () => {
  it('lists the Supplier Payments applied to a Bill with the current outstanding amount, linking to each payment', async () => {
    serve({ ...postedBill, status: 'partially_paid', outstandingAmount: '1825.00' });
    server.use(http.get('/api/v1/bills/:id/payments', () => HttpResponse.json({
      billId: BILL_ID,
      outstandingAmount: '1825.00',
      payments: [{ supplierPaymentId: 'sp-1', supplierPaymentNo: 'SPAY-2082-0001', docDate: '2025-07-28', referenceNo: 'CHQ-77', amount: '1000.00', allocatedAt: '2025-07-28T08:00:00.000Z' }],
    })));
    renderDetail();

    const link = await screen.findByRole('link', { name: 'SPAY-2082-0001' });
    expect(link).toHaveAttribute('href', '/supplier-payments/sp-1');
    expect(screen.getByText('CHQ-77')).toBeInTheDocument();
    const section = screen.getByRole('region', { name: 'Payments applied' });
    expect(within(section).getByText(/1,000\.00/)).toBeInTheDocument();
    expect(within(section).getByText(/1,825\.00/)).toBeInTheDocument();
  });

  it('says nothing has been paid when no payments are allocated, and does not ask for payments on a draft', async () => {
    serve(postedBill);
    const { unmount } = renderDetail();
    expect(await screen.findByText('No payments applied')).toBeInTheDocument();
    unmount();

    let asked = false;
    serve(draftBill);
    server.use(http.get('/api/v1/bills/:id/payments', () => { asked = true; return HttpResponse.json({ billId: BILL_ID, outstandingAmount: '0.00', payments: [] }); }));
    renderDetail();
    expect(await screen.findByText('Draft bill')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Payments applied' })).not.toBeInTheDocument();
    expect(asked).toBe(false);
  });
});
