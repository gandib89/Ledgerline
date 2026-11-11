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
import { ReceiptDetailPage } from './ReceiptDetailPage.jsx';
import { SupplierPaymentDetailPage } from './SupplierPaymentDetailPage.jsx';

const partyId = '11111111-1111-4111-8111-111111111111';
const paymentId = '77777777-7777-4777-8777-777777777777';
const idOf = (n) => `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`;

// One scenario per payment kind: same panel, different words and endpoints.
const KINDS = [
  {
    name: 'Receipt', Page: ReceiptDetailPage, route: '/receipts/:id', at: `/receipts/${paymentId}`, permission: 'payment.create',
    paymentApi: '/api/v1/receipts', listApi: '/api/v1/invoices', idField: 'invoiceId', docPrefix: 'INV-2082-', docType: 'invoice',
    panel: 'Apply to invoices', partyType: 'customer', heading: 'RCP-2082-0001', afterKey: 'invoiceOutstandingAfter',
  },
  {
    name: 'Supplier Payment', Page: SupplierPaymentDetailPage, route: '/supplier-payments/:id', at: `/supplier-payments/${paymentId}`, permission: 'supplier_payment.create',
    paymentApi: '/api/v1/supplier-payments', listApi: '/api/v1/bills', idField: 'billId', docPrefix: 'BILL-2082-', docType: 'bill',
    panel: 'Apply to bills', partyType: 'supplier', heading: 'SPAY-2082-0001', afterKey: 'billOutstandingAfter',
  },
];

function renderAt(K, permissions) {
  return render(
    <QueryClientProvider client={createAppQueryClient()}>
      <MemoryRouter initialEntries={[K.at]}>
        <ToastProvider>
          <Routes>
            <Route element={<Outlet context={{ activeOrganizationId: 'org-1', activeOrganization: permissions === null ? {} : { permissions } }} />}>
              <Route path={K.route} element={<K.Page />} />
            </Route>
          </Routes>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// Stateful fake of the API for one kind: the payment, its party's documents and
// the allocations endpoint (which updates both, as the real one does).
function serve(K, { status = 'posted', unapplied = '1000.00', documents, onPost } = {}) {
  const state = {
    payment: { id: paymentId, docType: K.name, docNo: K.heading, docDate: '2025-08-01', partyId, status, referenceNo: null, notes: null, grandTotal: '1500.00', allocatedAmount: '500.00', outstandingAmount: unapplied, journalEntryId: null, allocations: [] },
    documents: documents ?? [
      { id: idOf(1), docNo: `${K.docPrefix}0001`, referenceNo: 'REF-1', docDate: '2025-07-20', dueDate: '2025-08-19', partyId, status: 'posted', grandTotal: '600.00', outstandingAmount: '600.00' },
      { id: idOf(2), docNo: `${K.docPrefix}0002`, referenceNo: 'REF-2', docDate: '2025-07-21', dueDate: '2025-08-20', partyId, status: 'partially_paid', grandTotal: '900.00', outstandingAmount: '700.00' },
    ],
    posts: [],
  };
  server.use(
    http.get(`${K.paymentApi}/:id`, () => HttpResponse.json(state.payment)),
    http.get('/api/v1/parties', () => HttpResponse.json([{ id: partyId, code: 'P-001', name: 'Himalayan Party', type: K.partyType, isActive: true }])),
    http.get('/api/v1/accounts', () => HttpResponse.json([])),
    http.get(K.listApi, ({ request }) => {
      const url = new URL(request.url);
      const wanted = url.searchParams.get('partyId') === partyId ? state.documents.filter((d) => d.status === url.searchParams.get('status')) : [];
      const pageNo = Number(url.searchParams.get('page') ?? 1);
      return HttpResponse.json(wanted.slice((pageNo - 1) * 20, pageNo * 20));
    }),
    http.post(`${K.paymentApi}/:id/allocations`, async ({ request, params }) => {
      const body = await request.json();
      const record = { id: params.id, key: request.headers.get('Idempotency-Key'), body };
      state.posts.push(record);
      if (onPost) {
        const forced = onPost(record);
        if (forced) return forced;
      }
      const applied = [];
      let total = 0n;
      for (const a of body.allocations) {
        const doc = state.documents.find((d) => d.id === a[K.idField]);
        const cents = BigInt(a.amount.replace('.', ''));
        total += cents;
        const left = BigInt(doc.outstandingAmount.replace('.', '')) - cents;
        doc.outstandingAmount = `${left / 100n}.${String(left % 100n).padStart(2, '0')}`;
        doc.status = left === 0n ? 'paid' : 'partially_paid';
        applied.push({ [K.idField]: doc.id, amount: a.amount, [K.afterKey]: doc.outstandingAmount });
      }
      const rest = BigInt(state.payment.outstandingAmount.replace('.', '')) - total;
      state.payment.outstandingAmount = `${rest / 100n}.${String(rest % 100n).padStart(2, '0')}`;
      return HttpResponse.json({ [K.name === 'Receipt' ? 'receipt' : 'supplierPayment']: state.payment, allocations: applied }, { status: 201 });
    }),
  );
  return state;
}

beforeEach(() => {
  resetApiClient();
  setActiveOrganization('org-1');
});

describe.each(KINDS)('Apply an Unapplied Amount from a $name', (K) => {
  it("lists the party's open documents and posts the entered allocations with an Idempotency-Key, then refreshes", async () => {
    const user = userEvent.setup();
    const state = serve(K);
    renderAt(K, [K.permission, 'report.view']);

    const panel = await screen.findByRole('region', { name: K.panel });
    expect(await within(panel).findByText(`${K.docPrefix}0001`)).toBeInTheDocument();
    expect(within(panel).getByText(`${K.docPrefix}0002`)).toBeInTheDocument();
    const submit = within(panel).getByRole('button', { name: /^Apply/ });
    expect(submit).toBeDisabled();

    await user.type(within(panel).getByLabelText(`Apply to ${K.docPrefix}0001`), '400.00');
    await user.type(within(panel).getByLabelText(`Apply to ${K.docPrefix}0002`), '150.50');
    expect(within(panel).getByText('Unapplied after')).toBeInTheDocument();
    expect(within(panel).getByText('Unapplied after').nextSibling).toHaveTextContent('449.50');
    await user.click(submit);

    await waitFor(() => expect(state.posts).toHaveLength(1));
    expect(state.posts[0].body).toEqual({ allocations: [{ [K.idField]: idOf(1), amount: '400.00' }, { [K.idField]: idOf(2), amount: '150.50' }] });
    expect(state.posts[0].key).toMatch(/\S{8,}/);
    // Refreshed: documents show their new outstanding amounts and the inputs are cleared.
    const refreshed = await screen.findByRole('region', { name: K.panel });
    expect(await within(refreshed).findByText(/200\.00/)).toBeInTheDocument(); // 600.00 - 400.00
    expect(within(refreshed).getByText(/549\.50/)).toBeInTheDocument(); // 700.00 - 150.50
    expect(within(refreshed).getByLabelText(`Apply to ${K.docPrefix}0001`)).toHaveValue('');
  });

  it('loads every page of the open documents, not just the first 20', async () => {
    const documents = Array.from({ length: 25 }, (_, i) => ({
      id: idOf(i + 1), docNo: `${K.docPrefix}${String(i + 1).padStart(4, '0')}`, referenceNo: `R-${i}`, docDate: '2025-07-20', dueDate: '2025-08-19',
      partyId, status: 'posted', grandTotal: '100.00', outstandingAmount: '100.00',
    }));
    serve(K, { documents });
    renderAt(K, [K.permission]);
    const panel = await screen.findByRole('region', { name: K.panel });
    expect(await within(panel).findByLabelText(`Apply to ${K.docPrefix}0025`)).toBeInTheDocument();
  });

  it('blocks an allocation above the document outstanding amount and a total above the Unapplied Amount, without posting', async () => {
    const user = userEvent.setup();
    const state = serve(K, { unapplied: '1000.00' });
    renderAt(K, [K.permission]);
    const panel = await screen.findByRole('region', { name: K.panel });

    await user.type(await within(panel).findByLabelText(`Apply to ${K.docPrefix}0001`), '600.01');
    await user.click(within(panel).getByRole('button', { name: /^Apply/ }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent(/cannot exceed/i);

    await user.clear(within(panel).getByLabelText(`Apply to ${K.docPrefix}0001`));
    await user.type(within(panel).getByLabelText(`Apply to ${K.docPrefix}0001`), '600.00');
    await user.type(within(panel).getByLabelText(`Apply to ${K.docPrefix}0002`), '700.00');
    await user.click(within(panel).getByRole('button', { name: /^Apply/ }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent(/Unapplied Amount/);

    await user.clear(within(panel).getByLabelText(`Apply to ${K.docPrefix}0002`));
    await user.type(within(panel).getByLabelText(`Apply to ${K.docPrefix}0002`), '1.234');
    await user.click(within(panel).getByRole('button', { name: /^Apply/ }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent(/valid/i);
    expect(state.posts).toHaveLength(0);
  });

  it('reuses the Idempotency-Key when the same request is retried after a failure', async () => {
    const user = userEvent.setup();
    let failures = 1;
    const state = serve(K, { onPost: () => (failures-- > 0 ? HttpResponse.json({ error: { code: 'boom', message: 'Server hiccup' } }, { status: 500 }) : null) });
    renderAt(K, [K.permission]);
    const panel = await screen.findByRole('region', { name: K.panel });
    await user.type(await within(panel).findByLabelText(`Apply to ${K.docPrefix}0001`), '100.00');

    await user.click(within(panel).getByRole('button', { name: /^Apply/ }));
    expect(await screen.findByText('Server hiccup')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: /^Apply/ }));

    await waitFor(() => expect(state.posts).toHaveLength(2));
    expect(state.posts[1].key).toBe(state.posts[0].key);
  });

  it.each([
    ['without the create permission', ['report.view'], {}],
    ['when the permission list is missing altogether', null, {}],
    ['when nothing is left unapplied', 'granted', { unapplied: '0.00' }],
    ['when the payment is reversed', 'granted', { status: 'reversed' }],
  ])('hides the panel %s', async (_label, permissions, serveOptions) => {
    serve(K, serveOptions);
    renderAt(K, permissions === 'granted' ? [K.permission] : permissions);
    expect(await screen.findByRole('heading', { name: K.heading })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: K.panel })).not.toBeInTheDocument();
  });

  it('tells the user when the party has no open documents', async () => {
    serve(K, { documents: [] });
    renderAt(K, [K.permission]);
    const panel = await screen.findByRole('region', { name: K.panel });
    expect(await within(panel).findByText(/no open/i)).toBeInTheDocument();
  });
});
