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
import { SuppliersPage } from './SuppliersPage.jsx';

function renderPage(permissions = ['org.manage']) {
  return render(
    <QueryClientProvider client={createAppQueryClient()}>
      <MemoryRouter initialEntries={['/']}>
        <ToastProvider>
          <Routes>
            <Route element={<Outlet context={{ activeOrganizationId: 'org-1', activeOrganization: { permissions } }} />}>
              <Route index element={<SuppliersPage />} />
            </Route>
          </Routes>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const seed = () => [
  { id: 'p-1', type: 'supplier', code: 'SUP-001', name: 'Annapurna Traders', panVatNo: '600100200', email: null, phone: null, creditDays: 45, isActive: true },
  { id: 'p-2', type: 'both', code: 'SUP-002', name: 'Rara Wholesale', panVatNo: null, email: null, phone: null, creditDays: 15, isActive: true },
];

let parties;
let requestedTypes;

beforeEach(() => {
  resetApiClient();
  setActiveOrganization('org-1');
  parties = seed();
  requestedTypes = [];
  server.use(
    http.get('/api/v1/parties', ({ request }) => {
      requestedTypes.push(new URL(request.url).searchParams.get('type'));
      return HttpResponse.json(parties);
    }),
    http.post('/api/v1/parties', async ({ request }) => {
      const created = { id: 'p-new', email: null, phone: null, panVatNo: null, isActive: true, ...(await request.json()) };
      parties = [...parties, created];
      return HttpResponse.json(created, { status: 201 });
    }),
    http.patch('/api/v1/parties/:id', async ({ params, request }) => {
      const body = await request.json();
      parties = parties.map((party) => (party.id === params.id ? { ...party, ...body } : party));
      return HttpResponse.json(parties.find((party) => party.id === params.id));
    }),
  );
});

describe('Suppliers page', () => {
  it('lists suppliers with PAN/VAT and credit days, asking the server for the supplier type', async () => {
    renderPage();

    const row = (await screen.findByText('Annapurna Traders')).closest('tr');
    expect(within(row).getByText('SUP-001')).toBeInTheDocument();
    expect(within(row).getByText('600100200')).toBeInTheDocument();
    expect(within(row).getByText('45')).toBeInTheDocument();
    expect(screen.getByText('Rara Wholesale')).toBeInTheDocument();
    expect(requestedTypes).toEqual(['supplier']);
  });

  it('creates a supplier', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'New supplier' }));
    const dialog = screen.getByRole('dialog', { name: 'New supplier' });
    await user.type(within(dialog).getByLabelText('Code'), 'SUP-003');
    await user.type(within(dialog).getByLabelText('Name'), 'Mustang Foods');
    await user.type(within(dialog).getByLabelText('PAN/VAT number'), '123456789');
    await user.clear(within(dialog).getByLabelText('Credit days'));
    await user.type(within(dialog).getByLabelText('Credit days'), '60');
    await user.click(within(dialog).getByRole('button', { name: 'Create supplier' }));

    const row = (await screen.findByRole('cell', { name: 'Mustang Foods' })).closest('tr');
    expect(within(row).getByText('123456789')).toBeInTheDocument();
    expect(parties.at(-1)).toMatchObject({ type: 'supplier', code: 'SUP-003', panVatNo: '123456789', creditDays: 60 });
    expect(screen.getByText('Supplier created')).toBeInTheDocument();
  });

  it('edits a supplier, including marking it as both a customer and a supplier', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Edit Annapurna Traders' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit supplier' });
    await user.selectOptions(within(dialog).getByLabelText('Type'), 'both');
    await user.clear(within(dialog).getByLabelText('Credit days'));
    await user.type(within(dialog).getByLabelText('Credit days'), '90');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Supplier updated')).toBeInTheDocument();
    expect(parties[0]).toMatchObject({ type: 'both', creditDays: 90 });
    expect(within(screen.getByRole('cell', { name: 'Annapurna Traders' }).closest('tr')).getByText('90')).toBeInTheDocument();
  });

  it('hides the create and edit controls without the party-management permission', async () => {
    renderPage([]);

    expect(await screen.findByText('Annapurna Traders')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New supplier' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit / })).not.toBeInTheDocument();
  });

  it('hides the controls when the organization has no permission list at all', async () => {
    renderPage(null);

    expect(await screen.findByText('Annapurna Traders')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New supplier' })).not.toBeInTheDocument();
  });
});
