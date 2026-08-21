import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App.jsx';
import { AuthProvider } from '../auth/AuthContext.jsx';
import { ToastProvider } from '../components/ToastProvider.jsx';
import { demoOrganizations, mockSession } from '../mocks/handlers.js';
import { server } from '../mocks/server.js';
import { createAppQueryClient } from '../query-client.js';

function renderApp(path) {
  return render(
    <QueryClientProvider client={createAppQueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <ToastProvider>
          <AuthProvider><App /></AuthProvider>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const roles = [
  { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Accountant' },
  { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Owner' },
];
const members = [{
  id: 'member-owner', user: { id: 'user-1', email: 'owner@example.com' },
  role: roles[1], isActive: true,
}];
const fiscalYears = [{
  id: 'fy-1', label: 'FY 2082/83', startDate: '2025-07-16', endDate: '2026-07-15', isClosed: false,
}];
const periods = [{
  id: 'period-1', fiscalYearId: 'fy-1', label: 'August 2025', startDate: '2025-08-01', endDate: '2025-08-31', isOpen: true,
}];

function settingsHandlers(overrides = {}) {
  server.use(
    http.get('/api/v1/roles', () => HttpResponse.json(roles)),
    http.get('/api/v1/orgs/:id/members', () => HttpResponse.json(members)),
    http.get('/api/v1/fiscal-years', () => HttpResponse.json(fiscalYears)),
    http.get('/api/v1/periods', () => HttpResponse.json(periods)),
    ...(overrides.handlers ?? []),
  );
}

describe('complete endpoint settings UI', () => {
  beforeEach(() => { mockSession.active = true; });

  it('creates the first organization and unlocks the application shell', async () => {
    const user = userEvent.setup();
    let organizations = [];
    server.use(
      http.get('/api/v1/orgs', () => HttpResponse.json(organizations)),
      http.post('/api/v1/orgs', async ({ request }) => {
        const input = await request.json();
        organizations = [{ ...demoOrganizations[0], id: 'org-new', name: input.name }];
        return HttpResponse.json({ id: 'org-new', name: input.name, isActive: true }, { status: 201 });
      }),
      http.post('/api/v1/orgs/:id/starter-kit', () => HttpResponse.json({ provisioned: true }, { status: 201 })),
    );

    renderApp('/dashboard');

    expect(await screen.findByRole('heading', { name: 'Create your first organization' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Organization name'), 'Koshi Traders');
    await user.click(screen.getByRole('button', { name: 'Create organization' }));

    expect(await screen.findByLabelText('Active organization')).toHaveValue('org-new');
  });

  it('adds an organization member with a discoverable role', async () => {
    const user = userEvent.setup();
    let submitted;
    settingsHandlers({ handlers: [
      http.post('/api/v1/orgs/:id/members', async ({ request }) => {
        submitted = await request.json();
        return HttpResponse.json({ id: 'member-2', user: { id: 'user-2', email: submitted.email }, role: roles[0], isActive: true }, { status: 201 });
      }),
    ] });

    renderApp('/settings');

    expect(await screen.findByRole('heading', { name: 'Organization settings' })).toBeInTheDocument();
    await user.type(await screen.findByLabelText('Member email'), 'accountant@example.com');
    await user.selectOptions(screen.getByLabelText('Member role'), roles[0].id);
    await user.click(screen.getByRole('button', { name: 'Add member' }));

    await waitFor(() => expect(submitted).toEqual({ email: 'accountant@example.com', roleId: roles[0].id }));
    expect(await screen.findByText('accountant@example.com')).toBeInTheDocument();
  });

  it('creates ledger and bank accounts through their API contracts', async () => {
    const user = userEvent.setup();
    const createAccount = vi.fn();
    const createBank = vi.fn();
    settingsHandlers({ handlers: [
      http.post('/api/v1/accounts', async ({ request }) => {
        const input = await request.json(); createAccount(input);
        return HttpResponse.json({ id: 'account-new', ...input, isControlAccount: false, isBankAccount: false, isActive: true }, { status: 201 });
      }),
      http.post('/api/v1/bank-accounts', async ({ request }) => {
        const input = await request.json(); createBank(input);
        return HttpResponse.json({ id: 'bank-new', ...input, isActive: true }, { status: 201 });
      }),
    ] });

    renderApp('/settings');
    await screen.findByRole('heading', { name: 'Organization settings' });

    await user.type(await screen.findByLabelText('Account code'), '6100');
    await user.type(screen.getByLabelText('Account name'), 'Office Supplies');
    await user.selectOptions(screen.getByLabelText('Account type'), 'EXPENSE');
    await user.click(screen.getByRole('button', { name: 'Create ledger account' }));
    await waitFor(() => expect(createAccount).toHaveBeenCalledWith({ code: '6100', name: 'Office Supplies', type: 'EXPENSE' }));

    await user.selectOptions(screen.getByLabelText('Bank ledger account'), '22222222-2222-4222-8222-222222222225');
    await user.type(screen.getByLabelText('Bank name'), 'Global IME Bank');
    await user.type(screen.getByLabelText('Masked account number'), '****4412');
    const openingBalance = screen.getByLabelText('Opening balance');
    await user.clear(openingBalance);
    await user.type(openingBalance, '10000');
    await user.click(screen.getByRole('button', { name: 'Create bank account' }));
    await waitFor(() => expect(createBank).toHaveBeenCalledWith({
      accountId: '22222222-2222-4222-8222-222222222225', bankName: 'Global IME Bank',
      accountNoMasked: '****4412', openingBalance: '10000',
    }));
  });

  it('loads fiscal years and locks an open accounting period', async () => {
    const user = userEvent.setup();
    const updatePeriod = vi.fn();
    let periodOpen = true;
    settingsHandlers({ handlers: [
      http.get('/api/v1/periods', () => HttpResponse.json([{ ...periods[0], isOpen: periodOpen }])),
      http.patch('/api/v1/periods/:id', async ({ request, params }) => {
        const input = await request.json(); updatePeriod(params.id, input); periodOpen = input.isOpen;
        return HttpResponse.json({ ...periods[0], isOpen: periodOpen });
      }),
    ] });

    renderApp('/settings');

    expect(await screen.findByText('FY 2082/83')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Lock August 2025' }));
    await waitFor(() => expect(updatePeriod).toHaveBeenCalledWith('period-1', { isOpen: false }));
    expect(await screen.findByRole('button', { name: 'Reopen August 2025' })).toBeInTheDocument();
  });
});
