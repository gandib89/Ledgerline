import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApiClient, setActiveOrganization } from '../lib/api-client.js';
import { server } from '../mocks/server.js';
import { createAppQueryClient } from '../query-client.js';
import { AuditTrailPage } from './AuditTrailPage.jsx';

const entries = [{
  id: 'audit-1', action: 'reconciliation.completed', entityType: 'Reconciliation', entityId: 'recon-1',
  before: { status: 'IN_PROGRESS', difference: '1130.00' },
  after: { status: 'COMPLETED', difference: '0.00' },
  actorId: '11111111-1111-4111-8111-111111111111',
  actor: { id: '11111111-1111-4111-8111-111111111111', email: 'sunita@ledgerline.test' },
  ipAddress: '127.0.0.1', requestId: 'req-day6-001', createdAt: '2026-02-25T08:15:00.000Z',
}];

function renderPage(activeOrganization = { permissions: ['audit.view'] }) {
  return render(
    <QueryClientProvider client={createAppQueryClient()}>
      <MemoryRouter initialEntries={['/audit']}>
        <Routes>
          <Route element={<Outlet context={{ activeOrganizationId: 'org-1', activeOrganization }} />}>
            <Route path="/audit" element={<AuditTrailPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  resetApiClient();
  setActiveOrganization('org-1');
});

describe('Day 6 audit trail', () => {
  it('shows trace metadata and an expandable before/after diff', async () => {
    server.use(http.get('/api/v1/audit-log', () => HttpResponse.json(entries)));
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('reconciliation.completed')).toBeInTheDocument();
    expect(screen.getByText('sunita@ledgerline.test')).toBeInTheDocument();
    expect(screen.getByText('127.0.0.1')).toBeInTheDocument();
    expect(screen.getByText('req-day6-001')).toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: /view changes for reconciliation.completed/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    const changes = screen.getByRole('region', { name: /changes for reconciliation.completed/i });
    expect(within(changes).getByText('IN_PROGRESS')).toBeInTheDocument();
    expect(within(changes).getByText('COMPLETED')).toBeInTheDocument();
    expect(within(changes).getByText('1130.00')).toBeInTheDocument();
    expect(within(changes).getByText('0.00')).toBeInTheDocument();
  });

  it('applies entity, actor, and entity-id filters to the request', async () => {
    const seen = vi.fn();
    server.use(http.get('/api/v1/audit-log', ({ request }) => {
      seen(Object.fromEntries(new URL(request.url).searchParams));
      return HttpResponse.json(entries);
    }));
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('reconciliation.completed');

    await user.selectOptions(screen.getByLabelText('Entity type'), 'Reconciliation');
    await user.type(screen.getByLabelText('Actor ID'), '11111111-1111-4111-8111-111111111111');
    await user.type(screen.getByLabelText('Entity ID'), 'recon-1');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));

    expect(await screen.findByText('Showing filtered activity')).toBeInTheDocument();
    expect(seen).toHaveBeenLastCalledWith({
      entityType: 'Reconciliation', actorId: '11111111-1111-4111-8111-111111111111', entityId: 'recon-1', page: '1',
    });
  });

  it('does not request audit data when the membership lacks permission', async () => {
    const called = vi.fn();
    server.use(http.get('/api/v1/audit-log', () => { called(); return HttpResponse.json(entries); }));
    renderPage({ permissions: ['report.view'] });

    expect(screen.getByText('Audit access required')).toBeInTheDocument();
    expect(called).not.toHaveBeenCalled();
  });
});
