import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetApiClient, setActiveOrganization } from '../lib/api-client.js';
import { server } from '../mocks/server.js';
import { createAppQueryClient } from '../query-client.js';
import { ApAgingPage } from './ApAgingPage.jsx';

function renderPage() {
  return render(<QueryClientProvider client={createAppQueryClient()}><MemoryRouter initialEntries={['/reports/ap-aging']}><Routes><Route element={<Outlet context={{ activeOrganizationId: 'org-1' }} />}><Route path="/reports/ap-aging" element={<ApAgingPage />} /><Route path="/bills/:id" element={<div>Bill source</div>} /></Route></Routes></MemoryRouter></QueryClientProvider>);
}

const buckets = [{ key: 'current', label: 'Current' }, { key: 'd1_30', label: '1-30 days' }, { key: 'd31_60', label: '31-60 days' }, { key: 'd61_90', label: '61-90 days' }, { key: 'd90_plus', label: '90+ days' }];
const report = (integrity) => ({
  asOf: '2025-11-15', buckets,
  rows: [{ partyId: 'party-1', partyName: 'Alpha Stationers', buckets: { current: '0.00', d1_30: '5000.00', d31_60: '0.00', d61_90: '0.00', d90_plus: '0.00' }, unapplied: '-800.00', total: '4200.00', invoices: [{ id: 'bill-1', docNo: 'BILL-2082-0001', dueDate: '2025-10-31', outstandingAmount: '5000.00', bucket: 'd1_30' }] }],
  totals: { grandTotal: '4200.00' },
  integrity,
});

beforeEach(() => { resetApiClient(); setActiveOrganization('org-1'); });

describe('AP Aging page', () => {
  it('reads "as of today" with no date picker, shows Unapplied payments, Bills and the AP control check', async () => {
    const user = userEvent.setup();
    let requestedUrl;
    server.use(http.get('/api/v1/reports/ap-aging', ({ request }) => { requestedUrl = new URL(request.url); return HttpResponse.json(report({ apControlBalance: '4200.00', balanced: true })); }));

    renderPage();
    expect(await screen.findByText('Alpha Stationers')).toBeInTheDocument();
    expect(requestedUrl.search).toBe('');
    expect(screen.getByText(/as of today/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('As of')).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Supplier' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Unapplied payments' })).toBeInTheDocument();
    expect(within(screen.getByText('Alpha Stationers').closest('tr')).getByLabelText('NPR (800.00)')).toBeInTheDocument();
    expect(screen.getByText('AP control account agrees')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show Bills for Alpha Stationers' }));
    expect(screen.getByRole('link', { name: 'BILL-2082-0001' })).toHaveAttribute('href', '/bills/bill-1');
  });

  it('flags a difference from the AP control account', async () => {
    server.use(http.get('/api/v1/reports/ap-aging', () => HttpResponse.json(report({ apControlBalance: '4000.00', balanced: false }))));
    renderPage();
    expect(await screen.findByText('AP control difference detected')).toBeInTheDocument();
  });
});
