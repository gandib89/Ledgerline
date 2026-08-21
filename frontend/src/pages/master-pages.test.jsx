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
import { AccountsPage } from './AccountsPage.jsx';
import { CustomersPage } from './CustomersPage.jsx';

function renderPage(element) {
  return render(
    <QueryClientProvider client={createAppQueryClient()}>
      <MemoryRouter initialEntries={['/']}>
        <ToastProvider>
          <Routes>
            <Route element={<Outlet context={{ activeOrganizationId: 'org-1', activeOrganization: { permissions: ['org.manage'] } }} />}>
              <Route index element={element} />
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

describe('master data pages', () => {
  it('groups the chart of accounts and identifies control and bank accounts', async () => {
    server.use(http.get('/api/v1/accounts', () => HttpResponse.json([
      { id: 'a-1', code: '1100', name: 'Cash at Bank', type: 'ASSET', isControlAccount: false, isBankAccount: true, isActive: true },
      { id: 'a-2', code: '1200', name: 'Accounts Receivable', type: 'ASSET', isControlAccount: true, isBankAccount: false, isActive: true },
      { id: 'a-3', code: '4100', name: 'Sales Revenue', type: 'REVENUE', isControlAccount: false, isBankAccount: false, isActive: true },
    ])));

    renderPage(<AccountsPage />);

    expect(await screen.findByRole('heading', { name: 'Assets' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Revenue' })).toBeInTheDocument();
    expect(within(screen.getByText('Cash at Bank').closest('tr')).getByText('Bank')).toBeInTheDocument();
    expect(within(screen.getByText('Accounts Receivable').closest('tr')).getByText('Control')).toBeInTheDocument();
  });

  it('edits an existing customer and refreshes the list', async () => {
    const user = userEvent.setup();
    let customer = {
      id: 'party-1',
      type: 'customer',
      code: 'CUS-001',
      name: 'Kathmandu Books',
      email: 'old@books.test',
      phone: null,
      creditDays: 30,
      isActive: true,
    };

    server.use(
      http.get('/api/v1/parties', () => HttpResponse.json([customer])),
      http.patch('/api/v1/parties/:id', async ({ params, request }) => {
        expect(params.id).toBe(customer.id);
        customer = { ...customer, ...(await request.json()) };
        return HttpResponse.json(customer);
      }),
    );

    renderPage(<CustomersPage />);

    await user.click(await screen.findByRole('button', { name: 'Edit Kathmandu Books' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit customer' });
    const name = within(dialog).getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Kathmandu Books Pvt. Ltd.');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    const updatedAction = await screen.findByRole('button', {
      name: 'Edit Kathmandu Books Pvt. Ltd.',
    });
    expect(within(updatedAction.closest('tr')).getByText('Kathmandu Books Pvt. Ltd.')).toBeInTheDocument();
    expect(screen.getByText('Customer updated')).toBeInTheDocument();
  });

  it('shows shared validation errors before creating a customer', async () => {
    const user = userEvent.setup();
    server.use(http.get('/api/v1/parties', () => HttpResponse.json([])));

    renderPage(<CustomersPage />);

    await user.click(await screen.findByRole('button', { name: 'New customer' }));
    await user.click(screen.getByRole('button', { name: 'Create customer' }));

    expect(screen.getByText('Code is required')).toBeInTheDocument();
    expect(screen.getByText('Name is required')).toBeInTheDocument();
  });
});
