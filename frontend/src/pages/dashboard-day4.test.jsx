import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetApiClient, setActiveOrganization } from '../lib/api-client.js';
import { server } from '../mocks/server.js';
import { createAppQueryClient } from '../query-client.js';
import { DashboardPage } from './DashboardPage.jsx';

beforeEach(() => {
  resetApiClient();
  setActiveOrganization('org-1');
});

describe('Day 4 dashboard', () => {
  it('builds its metrics from live reports instead of a mock-only summary route', async () => {
    server.use(
      http.get('/api/v1/dashboard/summary', () => HttpResponse.json({ error: { code: 'removed', message: 'Do not use this route' } }, { status: 500 })),
      http.get('/api/v1/reports/ar-aging', () => HttpResponse.json({
        buckets: [{ key: 'current', label: 'Current' }, { key: 'd1_30', label: '1-30 days' }],
        rows: [{ partyId: 'p-1', partyName: 'Customer', buckets: { current: '33900.00', d1_30: '35600.00' }, total: '69500.00', invoices: [] }],
        totals: { grandTotal: '69500.00' },
        integrity: { arControlBalance: '69500.00', balanced: true },
      })),
      http.get('/api/v1/reports/profit-loss', () => HttpResponse.json({ revenue: [], expense: [], revenueTotal: '195000.00', expenseTotal: '0.00', netProfit: '195000.00' })),
      http.get('/api/v1/bank-accounts', () => HttpResponse.json([{ id: 'bank-1', accountId: 'cash-1', bankName: 'Nabil Bank', isActive: true }])),
      http.get('/api/v1/reports/general-ledger', () => HttpResponse.json({ account: { id: 'cash-1' }, openingBalance: '0.00', lines: [], closingBalance: '624720.00' })),
    );

    render(<QueryClientProvider client={createAppQueryClient()}><MemoryRouter initialEntries={['/dashboard']}><Routes><Route element={<Outlet context={{ activeOrganizationId: 'org-1' }} />}><Route path="/dashboard" element={<DashboardPage />} /></Route></Routes></MemoryRouter></QueryClientProvider>);

    expect(await screen.findByText('NPR 69,500.00')).toBeInTheDocument();
    expect(screen.getByText('NPR 35,600.00')).toBeInTheDocument();
    expect(screen.getByText('NPR 195,000.00')).toBeInTheDocument();
    expect(screen.getByText('NPR 624,720.00')).toBeInTheDocument();
    expect(screen.queryByText('Dashboard unavailable')).not.toBeInTheDocument();
  });
});
