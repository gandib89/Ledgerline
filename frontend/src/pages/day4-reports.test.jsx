import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetApiClient, setActiveOrganization } from '../lib/api-client.js';
import { server } from '../mocks/server.js';
import { createAppQueryClient } from '../query-client.js';
import { ArAgingPage } from './ArAgingPage.jsx';
import { GeneralLedgerPage } from './GeneralLedgerPage.jsx';

function renderPage(path) {
  return render(<QueryClientProvider client={createAppQueryClient()}><MemoryRouter initialEntries={[path]}><Routes><Route element={<Outlet context={{ activeOrganizationId: 'org-1' }} />}><Route path="/reports/ar-aging" element={<ArAgingPage />} /><Route path="/reports/general-ledger" element={<GeneralLedgerPage />} /><Route path="/invoices/:id" element={<div>Invoice source</div>} /></Route></Routes></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => { resetApiClient(); setActiveOrganization('org-1'); });

describe('Day 4 reports', () => {
  it('shows aging buckets, contributing invoices, and AR control reconciliation', async () => {
    const user = userEvent.setup();
    server.use(http.get('/api/v1/reports/ar-aging', () => HttpResponse.json({
      asOf: '2025-08-20',
      buckets: [{ key: 'current', label: 'Current' }, { key: 'd1_30', label: '1-30 days' }, { key: 'd31_60', label: '31-60 days' }, { key: 'd61_90', label: '61-90 days' }, { key: 'd90_plus', label: '90+ days' }],
      rows: [{ partyId: 'party-1', partyName: 'Himalayan Trek Supplies', buckets: { current: '0.00', d1_30: '63000.00', d31_60: '0.00', d61_90: '0.00', d90_plus: '0.00' }, total: '63000.00', invoices: [{ id: 'invoice-1', docNo: 'INV-2082-0001', dueDate: '2025-08-19', outstandingAmount: '63000.00', bucket: 'd1_30' }] }],
      totals: { grandTotal: '63000.00' },
      integrity: { arControlBalance: '63000.00', balanced: true },
    })));

    renderPage('/reports/ar-aging');
    expect(await screen.findByText('Himalayan Trek Supplies')).toBeInTheDocument();
    expect(screen.getByText('AR control account agrees')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show invoices for Himalayan Trek Supplies' }));
    expect(screen.getByRole('link', { name: 'INV-2082-0001' })).toHaveAttribute('href', '/invoices/invoice-1');
  });

  it('shows opening and running balances for the selected account', async () => {
    server.use(
      http.get('/api/v1/accounts', () => HttpResponse.json([{ id: 'account-1', code: '1100', name: 'Accounts Receivable', type: 'ASSET', isActive: true }])),
      http.get('/api/v1/reports/general-ledger', () => HttpResponse.json({ account: { id: 'account-1', code: '1100', name: 'Accounts Receivable', type: 'ASSET' }, from: '2025-07-16', to: '2025-08-20', openingBalance: '0.00', lines: [{ entryDate: '2025-07-20', entryNumber: 'JE-2082-0001', description: 'Customer invoice', debit: '113000.00', credit: '0.00', runningBalance: '113000.00', journalEntryId: 'journal-1', sourceDocumentId: 'invoice-1', sourceDocType: 'invoice', sourceDocNo: 'INV-2082-0001' }], closingBalance: '113000.00' })),
    );

    renderPage('/reports/general-ledger');
    await screen.findByRole('option', { name: '1100 - Accounts Receivable' });
    await userEvent.setup().selectOptions(await screen.findByLabelText('Account'), 'account-1');
    const row = (await screen.findByText('JE-2082-0001')).closest('tr');
    expect(within(row).getAllByText(/113,000\.00/)).toHaveLength(2);
    expect(screen.getByText('Closing balance')).toBeInTheDocument();
  });
});
