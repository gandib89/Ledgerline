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
import { BankingPage } from './BankingPage.jsx';

function renderBanking() {
  return render(<QueryClientProvider client={createAppQueryClient()}><MemoryRouter initialEntries={['/banking']}><ToastProvider><Routes><Route element={<Outlet context={{ activeOrganizationId: 'org-1', activeOrganization: { permissions: ['bank.reconcile', 'report.view'] } }} />}><Route path="/banking" element={<BankingPage />} /></Route></Routes></ToastProvider></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => { resetApiClient(); setActiveOrganization('org-1'); });

describe('Day 5 banking workflow', () => {
  it('maps a CSV, imports it, and shows matching results', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/v1/bank-accounts', () => HttpResponse.json([{ id: 'bank-1', accountId: 'cash-1', bankName: 'Nabil Bank', accountNoMasked: '****9231', openingBalance: '250000.00', isActive: true }])),
      http.get('/api/v1/accounts', () => HttpResponse.json([{ id: 'expense-1', code: '5100', name: 'Bank Charges', type: 'EXPENSE', isActive: true }])),
      http.post('/api/v1/bank-accounts/bank-1/statements', () => HttpResponse.json({ statement: { id: 'statement-1', bankAccountId: 'bank-1', fileName: 'statement.csv', periodStart: '2025-08-19', periodEnd: '2025-08-20', openingBalance: '250000.00', closingBalance: '305500.00', lineCount: 2 }, imported: 2, autoMatched: 1, suggested: 1, unmatched: 0 })),
      http.get('/api/v1/statements/statement-1/lines', () => HttpResponse.json({ id: 'statement-1', bankAccountId: 'bank-1', fileName: 'statement.csv', periodStart: '2025-08-19', periodEnd: '2025-08-20', openingBalance: '250000.00', closingBalance: '305500.00', lineCount: 2, lines: [{ id: 'line-1', statementId: 'statement-1', txnDate: '2025-08-19', description: 'HIMALAYAN TREK INV-2082-0001', reference: 'INV-1', debit: '0.00', credit: '60000.00', runningBalance: '310000.00', status: 'matched', matchedJournalLineId: 'jl-1', matchConfidence: '0.950', matchedBy: 'auto', ignoreReason: null }, { id: 'line-2', statementId: 'statement-1', txnDate: '2025-08-20', description: 'BANK CHARGE', reference: 'FEE', debit: '4500.00', credit: '0.00', runningBalance: '305500.00', status: 'suggested', matchedJournalLineId: 'jl-2', matchConfidence: '0.780', matchedBy: null, ignoreReason: null }] })),
      http.get('/api/v1/journal-entries', () => HttpResponse.json([])),
      http.get('/api/v1/reports/bank-reconciliation', () => HttpResponse.json({ asOf: '2025-08-20', bankAccountId: 'bank-1', statementId: 'statement-1', bankBalance: '305500.00', bookBalance: '305500.00', difference: '0.00', integrity: { balanced: true }, counts: { autoMatched: 1, manualMatched: 0, suggested: 1, unmatched: 0, ignored: 0, matched: 1, total: 2 } })),
    );

    renderBanking();
    const file = new File(['Date,Description,Reference,Debit,Credit,Balance\n2025-08-19,Receipt,INV-1,0,60000,310000'], 'statement.csv', { type: 'text/csv' });
    await user.upload(await screen.findByLabelText('Bank statement CSV'), file);
    expect(await screen.findByLabelText('Date column')).toHaveValue('Date');
    await user.click(screen.getByRole('button', { name: 'Import statement' }));

    expect(await screen.findByText('2 lines imported')).toBeInTheDocument();
    expect(screen.getByLabelText('Balance column')).toHaveValue('Balance');
    const suggested = (await screen.findByText('BANK CHARGE')).closest('article');
    expect(within(suggested).getByText('78% confidence')).toBeInTheDocument();
  });

  it('rejects a suggestion and returns it to unmatched work', async () => {
    const user = userEvent.setup();
    let rejected = false;
    const suggestedLine = { id: 'line-2', statementId: 'statement-1', txnDate: '2025-08-20', description: 'BANK CHARGE', reference: 'FEE', debit: '4500.00', credit: '0.00', runningBalance: '305500.00', status: 'suggested', matchedJournalLineId: 'jl-2', matchConfidence: '0.780', matchedBy: null, ignoreReason: null };
    server.use(
      http.get('/api/v1/bank-accounts', () => HttpResponse.json([{ id: 'bank-1', accountId: 'cash-1', bankName: 'Nabil Bank', accountNoMasked: '****9231', openingBalance: '250000.00', isActive: true }])),
      http.get('/api/v1/accounts', () => HttpResponse.json([{ id: 'expense-1', code: '5100', name: 'Bank Charges', type: 'EXPENSE', isActive: true }])),
      http.post('/api/v1/bank-accounts/bank-1/statements', () => HttpResponse.json({ statement: { id: 'statement-1', bankAccountId: 'bank-1', fileName: 'statement.csv', periodStart: '2025-08-20', periodEnd: '2025-08-20', openingBalance: '310000.00', closingBalance: '305500.00', lineCount: 1 }, imported: 1, autoMatched: 0, suggested: 1, unmatched: 0 })),
      http.get('/api/v1/statements/statement-1/lines', () => HttpResponse.json({ id: 'statement-1', bankAccountId: 'bank-1', fileName: 'statement.csv', periodStart: '2025-08-20', periodEnd: '2025-08-20', openingBalance: '310000.00', closingBalance: '305500.00', lineCount: 1, lines: [suggestedLine] })),
      http.get('/api/v1/journal-entries', () => HttpResponse.json([])),
      http.get('/api/v1/reports/bank-reconciliation', () => HttpResponse.json({ asOf: '2025-08-20', bankAccountId: 'bank-1', statementId: 'statement-1', bankBalance: '305500.00', bookBalance: '305500.00', difference: '0.00', integrity: { balanced: true }, counts: { autoMatched: 0, manualMatched: 0, suggested: rejected ? 0 : 1, unmatched: rejected ? 1 : 0, ignored: 0, matched: 0, total: 1 } })),
      http.post('/api/v1/lines/line-2/reject', () => { rejected = true; return HttpResponse.json({ ...suggestedLine, status: 'unmatched', matchedJournalLineId: null, matchConfidence: null }); }),
    );
    renderBanking();
    const file = new File(['Date,Description,Reference,Debit,Credit,Balance\n2025-08-20,BANK CHARGE,FEE,4500,0,305500'], 'statement.csv', { type: 'text/csv' });
    await user.upload(await screen.findByLabelText('Bank statement CSV'), file);
    await user.click(screen.getByRole('button', { name: 'Import statement' }));
    const suggested = (await screen.findByText('BANK CHARGE')).closest('article');
    await user.click(within(suggested).getByRole('button', { name: 'Reject suggestion' }));
    expect(rejected).toBe(true);
    expect(await within(suggested).findByText('Needs resolution')).toBeInTheDocument();
  });

  it('resolves the demo statement and completes reconciliation at zero difference', async () => {
    const user = userEvent.setup();
    renderBanking();
    const file = new File([
      'Date,Description,Reference,Debit,Credit,Balance\n2026-02-25,MONTHLY SERVICE CHARGE,,1130,0,624720',
    ], 'nabil-current-jan-feb-2026.csv', { type: 'text/csv' });

    await user.upload(await screen.findByLabelText('Bank statement CSV'), file);
    await user.click(screen.getByRole('button', { name: 'Import statement' }));

    const suggestion = (await screen.findByText('IPS EVEREST CAFE')).closest('article');
    await user.click(within(suggestion).getByRole('button', { name: 'Confirm match' }));

    const charge = (await screen.findByText('MONTHLY SERVICE CHARGE')).closest('article');
    await user.selectOptions(within(charge).getByLabelText('Other account for MONTHLY SERVICE CHARGE'), '22222222-2222-4222-8222-222222222226');
    await user.click(within(charge).getByRole('button', { name: 'Create entry' }));

    const prepare = await screen.findByRole('button', { name: 'Prepare reconciliation' });
    expect(prepare).toBeEnabled();
    await user.click(prepare);
    const complete = await screen.findByRole('button', { name: 'Complete reconciliation' });
    expect(complete).toBeEnabled();
    await user.click(complete);

    expect(await screen.findByRole('button', { name: 'Completed' })).toBeDisabled();
  });

  it('switches the mobile reconciliation workspace between linked statement and ledger tabs', async () => {
    const user = userEvent.setup();
    renderBanking();
    const file = new File([
      'Date,Description,Reference,Debit,Credit,Balance\n2026-02-25,MONTHLY SERVICE CHARGE,,1130,0,624720',
    ], 'nabil-current-jan-feb-2026.csv', { type: 'text/csv' });

    await user.upload(await screen.findByLabelText('Bank statement CSV'), file);
    await user.click(screen.getByRole('button', { name: 'Import statement' }));
    expect((await screen.findAllByText('MONTHLY SERVICE CHARGE')).length).toBeGreaterThan(0);

    const tablist = screen.getByRole('tablist', { name: 'Reconciliation workspace' });
    const statementTab = within(tablist).getByRole('tab', { name: 'Statement lines' });
    const ledgerTab = within(tablist).getByRole('tab', { name: 'Ledger movements' });
    expect(statementTab).toHaveAttribute('aria-selected', 'true');
    expect(statementTab).toHaveAttribute('aria-controls', 'statement-lines-panel');
    expect(screen.getByRole('tabpanel', { name: 'Statement lines' })).toHaveAttribute('data-mobile-active', 'true');

    await user.click(ledgerTab);
    expect(ledgerTab).toHaveAttribute('aria-selected', 'true');
    expect(ledgerTab).toHaveAttribute('aria-controls', 'ledger-movements-panel');
    expect(screen.getByRole('tabpanel', { name: 'Ledger movements' })).toHaveAttribute('data-mobile-active', 'true');
    expect(screen.getByRole('tabpanel', { name: 'Statement lines' })).toHaveAttribute('data-mobile-active', 'false');
  });
});
