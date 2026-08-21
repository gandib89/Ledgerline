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

const accounts = [
  { id: '22222222-2222-4222-8222-222222222225', code: '1020', name: 'Bank', type: 'ASSET', isActive: true },
  { id: '22222222-2222-4222-8222-222222222226', code: '5500', name: 'Bank Charges', type: 'EXPENSE', isActive: true },
];
const entry = {
  id: '66666666-6666-4666-8666-666666666661', entryNumber: 'JE-2082-0001', documentType: 'MANUAL',
  entryDate: '2025-08-21', description: 'Monthly bank fee', status: 'posted', sourceId: null, reversalOfId: null,
  lines: [
    { id: 'line-1', accountId: accounts[1].id, debit: '500.00', credit: '0.00', description: 'Bank fee', lineNumber: 1 },
    { id: 'line-2', accountId: accounts[0].id, debit: '0.00', credit: '500.00', description: 'Cash at bank', lineNumber: 2 },
  ],
};

function renderApp() {
  return render(
    <QueryClientProvider client={createAppQueryClient()}>
      <MemoryRouter initialEntries={['/journals']}>
        <ToastProvider><AuthProvider><App /></AuthProvider></ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('journal entries endpoint UI', () => {
  beforeEach(() => {
    mockSession.active = true;
    demoOrganizations[0].permissions = [...new Set([...demoOrganizations[0].permissions, 'journal.post'])];
  });

  it('lists entries, opens their lines, and posts a balanced manual journal', async () => {
    const user = userEvent.setup();
    const postJournal = vi.fn();
    server.use(
      http.get('/api/v1/journal-entries', () => HttpResponse.json([Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'lines'))])),
      http.get('/api/v1/journal-entries/:id', () => HttpResponse.json(entry)),
      http.post('/api/v1/journal-entries', async ({ request }) => {
        const input = await request.json(); postJournal(input);
        return HttpResponse.json({ ...entry, id: 'entry-new', entryNumber: 'JE-2082-0002', entryDate: input.entryDate, description: input.narration, lines: input.lines }, { status: 201 });
      }),
    );

    renderApp();
    expect(await screen.findByRole('heading', { name: 'Journal entries' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /JE-2082-0001/ }));
    expect(await screen.findByText('Bank fee')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Entry date'), '2025-08-22');
    await user.type(screen.getByLabelText('Narration'), 'Office bank charge');
    await user.selectOptions(screen.getByLabelText('Line 1 account'), accounts[1].id);
    await user.type(screen.getByLabelText('Line 1 debit'), '750');
    await user.selectOptions(screen.getByLabelText('Line 2 account'), accounts[0].id);
    await user.type(screen.getByLabelText('Line 2 credit'), '750');
    await user.click(screen.getByRole('button', { name: 'Post journal' }));

    await waitFor(() => expect(postJournal).toHaveBeenCalledWith({
      entryDate: '2025-08-22', narration: 'Office bank charge',
      lines: [
        { accountId: accounts[1].id, debit: '750', credit: '0', description: '' },
        { accountId: accounts[0].id, debit: '0', credit: '750', description: '' },
      ],
    }));
    expect(await screen.findByText('JE-2082-0002')).toBeInTheDocument();
  });

  it('reverses a posted entry with a reason and date', async () => {
    const user = userEvent.setup();
    const reverseJournal = vi.fn();
    server.use(
      http.get('/api/v1/journal-entries', () => HttpResponse.json([Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'lines'))])),
      http.get('/api/v1/journal-entries/:id', () => HttpResponse.json(entry)),
      http.post('/api/v1/journal-entries/:id/reverse', async ({ request, params }) => {
        const input = await request.json(); reverseJournal(params.id, input);
        return HttpResponse.json({ original: { ...entry, status: 'reversed' }, reversal: { ...entry, id: 'reversal-1', entryNumber: 'JE-2082-0002', reversalOfId: entry.id } });
      }),
    );

    renderApp();
    await user.click(await screen.findByRole('button', { name: /JE-2082-0001/ }));
    await user.type(await screen.findByLabelText('Reversal reason'), 'Entered twice');
    await user.type(screen.getByLabelText('Reversal date'), '2025-08-22');
    await user.click(screen.getByRole('button', { name: 'Reverse entry' }));

    await waitFor(() => expect(reverseJournal).toHaveBeenCalledWith(entry.id, { reason: 'Entered twice', reversalDate: '2025-08-22' }));
    expect(await screen.findByText('Entry reversed')).toBeInTheDocument();
  });
});
