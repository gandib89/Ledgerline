import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetApiClient, setActiveOrganization } from '../lib/api-client.js';
import { server } from '../mocks/server.js';
import { createAppQueryClient } from '../query-client.js';
import { BalanceSheetPage } from './BalanceSheetPage.jsx';
import { BankReconciliationPage } from './BankReconciliationPage.jsx';
import { ProfitLossPage } from './ProfitLossPage.jsx';

function renderReport(path) {
  return render(<QueryClientProvider client={createAppQueryClient()}><MemoryRouter initialEntries={[path]}><Routes><Route element={<Outlet context={{ activeOrganizationId: 'org-1' }} />}><Route path="/reports/profit-loss" element={<ProfitLossPage />} /><Route path="/reports/balance-sheet" element={<BalanceSheetPage />} /><Route path="/reports/bank-reconciliation" element={<BankReconciliationPage />} /></Route></Routes></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => { resetApiClient(); setActiveOrganization('org-1'); });

describe('Day 5 financial reports', () => {
  it('renders revenue, expenses, and net profit', async () => {
    server.use(http.get('/api/v1/reports/profit-loss', () => HttpResponse.json({ from: '2025-07-16', to: '2026-07-15', revenue: [{ code: '4100', name: 'Sales Revenue', amount: '195000.00' }], revenueTotal: '195000.00', expense: [{ code: '5100', name: 'Bank Charges', amount: '2500.00' }], expenseTotal: '2500.00', netProfit: '192500.00' })));
    renderReport('/reports/profit-loss');
    expect(await screen.findByText('Sales Revenue')).toBeInTheDocument();
    expect(screen.getByText('Net profit')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeInTheDocument();
  });

  it('renders current-year earnings and a balanced integrity result', async () => {
    server.use(http.get('/api/v1/reports/balance-sheet', () => HttpResponse.json({ asOf: '2026-07-15', assets: [{ code: '1010', name: 'Cash at Bank', amount: '305500.00' }], liabilities: [{ code: '2200', name: 'VAT Payable', amount: '13000.00' }], equity: [{ code: null, name: 'Current Year Earnings', amount: '292500.00' }], totals: { assets: '305500.00', liabilities: '13000.00', equity: '292500.00' }, integrity: { balanced: true, difference: '0.00' } })));
    renderReport('/reports/balance-sheet');
    expect(await screen.findByText('Current Year Earnings')).toBeInTheDocument();
    expect(screen.getByText('Assets equal liabilities plus equity')).toBeInTheDocument();
  });

  it('renders book, bank, difference, and matching counts', async () => {
    server.use(
      http.get('/api/v1/bank-accounts', () => HttpResponse.json([{ id: 'bank-1', accountId: 'account-1', bankName: 'Nabil Bank', accountNoMasked: '****9231', openingBalance: '0.00', isActive: true }])),
      http.get('/api/v1/reports/bank-reconciliation', () => HttpResponse.json({ asOf: '2025-08-20', bankAccountId: 'bank-1', statementId: 'statement-1', bankBalance: '305500.00', bookBalance: '305500.00', difference: '0.00', integrity: { balanced: true }, counts: { autoMatched: 2, manualMatched: 1, suggested: 0, unmatched: 0, ignored: 1, matched: 3, total: 4 } })),
    );
    renderReport('/reports/bank-reconciliation');
    expect(await screen.findByText('Nabil Bank')).toBeInTheDocument();
    expect(await screen.findByText('Zero difference')).toBeInTheDocument();
    expect(screen.getByText('3 matched')).toBeInTheDocument();
  });
});
