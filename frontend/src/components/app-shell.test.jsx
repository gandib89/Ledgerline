import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../auth/AuthContext.jsx';
import { getActiveOrganization, resetApiClient } from '../lib/api-client.js';
import { createAppQueryClient } from '../query-client.js';
import { DashboardPage } from '../pages/DashboardPage.jsx';
import { AppShell } from './AppShell.jsx';
import { ToastProvider } from './ToastProvider.jsx';

describe('AppShell', () => {
  beforeEach(() => resetApiClient());

  it('sets the active organization and invalidates cached organization data on switch', async () => {
    const user = userEvent.setup();
    const queryClient = createAppQueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/dashboard']}>
          <ToastProvider>
            <AuthProvider>
              <Routes>
                <Route element={<AppShell />}>
                  <Route path="/dashboard" element={<DashboardPage />} />
                </Route>
              </Routes>
            </AuthProvider>
          </ToastProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const organization = await screen.findByLabelText('Active organization');
    expect(organization).toHaveValue('org-annapurna');
    expect(getActiveOrganization()).toBe('org-annapurna');

    await user.selectOptions(organization, 'org-sherpa');

    await waitFor(() => expect(getActiveOrganization()).toBe('org-sherpa'));
    expect(invalidate).toHaveBeenCalledWith();
    expect(await screen.findByRole('heading', { name: 'Financial overview' })).toBeInTheDocument();
  });

  it('offers an accessible mobile navigation control', async () => {
    const queryClient = createAppQueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/dashboard']}>
          <ToastProvider>
            <AuthProvider>
              <Routes>
                <Route element={<AppShell />}>
                  <Route path="/dashboard" element={<DashboardPage />} />
                </Route>
              </Routes>
            </AuthProvider>
          </ToastProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole('button', { name: 'Open navigation' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('links to the shipped cash, banking, and reporting screens', async () => {
    render(
      <QueryClientProvider client={createAppQueryClient()}>
        <MemoryRouter initialEntries={['/dashboard']}>
          <ToastProvider>
            <AuthProvider>
              <Routes>
                <Route element={<AppShell />}>
                  <Route path="/dashboard" element={<DashboardPage />} />
                </Route>
              </Routes>
            </AuthProvider>
          </ToastProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole('link', { name: 'Invoices' })).toHaveAttribute('href', '/invoices');
    expect(screen.getByRole('link', { name: 'Receipts' })).toHaveAttribute('href', '/receipts');
    expect(screen.getByRole('link', { name: 'Banking' })).toHaveAttribute('href', '/banking');
    expect(screen.getByRole('link', { name: 'Trial Balance' })).toHaveAttribute('href', '/reports/trial-balance');
    expect(screen.getByRole('link', { name: 'General Ledger' })).toHaveAttribute('href', '/reports/general-ledger');
    expect(screen.getByRole('link', { name: 'AR Aging' })).toHaveAttribute('href', '/reports/ar-aging');
    expect(screen.getByRole('link', { name: 'Profit & Loss' })).toHaveAttribute('href', '/reports/profit-loss');
    expect(screen.getByRole('link', { name: 'Balance Sheet' })).toHaveAttribute('href', '/reports/balance-sheet');
    expect(screen.getByRole('link', { name: 'Bank Reconciliation' })).toHaveAttribute('href', '/reports/bank-reconciliation');
    expect(screen.getByRole('link', { name: 'Audit trail' })).toHaveAttribute('href', '/audit');
  });
});
