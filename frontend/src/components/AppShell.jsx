import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/auth-context.js';
import { apiRequest, setActiveOrganization } from '../lib/api-client.js';
import { todayInNepal } from '../lib/date.js';
import { AsyncState } from './AsyncState.jsx';
import { Icon } from './Icon.jsx';
import { useToast } from './toast-context.js';

const navigation = [
  ['dashboard', 'Dashboard', '/dashboard'],
  ['customers', 'Customers', '/customers'],
  ['invoices', 'Invoices', '/invoices'],
  ['receipts', 'Receipts', '/receipts'],
  ['banking', 'Banking', '/banking'],
  ['reports', 'Trial Balance', '/reports/trial-balance'],
  ['reports', 'General Ledger', '/reports/general-ledger'],
  ['reports', 'AR Aging', '/reports/ar-aging'],
  ['reports', 'Profit & Loss', '/reports/profit-loss'],
  ['reports', 'Balance Sheet', '/reports/balance-sheet'],
  ['reports', 'Bank Reconciliation', '/reports/bank-reconciliation'],
  ['reports', 'Chart of accounts', '/accounts'],
  ['customers', 'Team', '/team'],
  ['audit', 'Audit trail', '/audit'],
];

export function AppShell() {
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [selectedOrganizationId, setSelectedOrganizationId] = useState('');
  const [newOrgName, setNewOrgName] = useState('');
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { notify } = useToast();
  const organizations = useQuery({
    queryKey: ['organizations'],
    queryFn: () => apiRequest('/orgs'),
  });
  const createOrganization = useMutation({
    mutationFn: async (name) => {
      const org = await apiRequest('/orgs', { method: 'POST', body: { name } });
      // Standard chart of accounts + fiscal year — org id comes from the
      // URL, not the X-Organization-Id header, since the header's org
      // switcher hasn't caught up to this brand-new org yet.
      await apiRequest(`/orgs/${org.id}/starter-kit`, { method: 'POST' });
      return org;
    },
    onSuccess: (org) => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      notify({ title: 'Organization created', message: org.name, tone: 'success' });
      setNewOrgName('');
    },
    onError: (error) => notify({ title: 'Could not create organization', message: error.message, tone: 'error' }),
  });
  const activeOrganizationId = selectedOrganizationId || organizations.data?.[0]?.id || '';
  const activeOrganization = organizations.data?.find(({ id }) => id === activeOrganizationId) ?? null;

  useEffect(() => {
    if (activeOrganizationId) setActiveOrganization(activeOrganizationId);
  }, [activeOrganizationId]);

  const fiscalYears = useQuery({
    queryKey: ['fiscal-years', activeOrganizationId],
    queryFn: () => apiRequest('/fiscal-years'),
    enabled: Boolean(activeOrganizationId),
  });
  const today = todayInNepal();
  // fiscalYears.data is ordered by startDate ascending (API contract) — the
  // last entry is the org's most recent fiscal year even when it's expired.
  const currentFiscalYear = fiscalYears.data?.find((fy) => fy.startDate <= today && today <= fy.endDate)
    ?? fiscalYears.data?.[fiscalYears.data.length - 1]
    ?? null;
  const fiscalYearExpired = Boolean(currentFiscalYear) && today > currentFiscalYear.endDate;
  const canManageOrg = Boolean(activeOrganization?.permissions?.includes('org.manage'));

  const startNextFiscalYear = useMutation({
    mutationFn: () => apiRequest('/fiscal-years', { method: 'POST' }),
    onSuccess: (fy) => {
      queryClient.invalidateQueries({ queryKey: ['fiscal-years'] });
      notify({ title: 'Fiscal year started', message: `FY ${fy.label}`, tone: 'success' });
    },
    onError: (error) => notify({ title: 'Could not start fiscal year', message: error.message, tone: 'error' }),
  });

  async function changeOrganization(event) {
    const id = event.target.value;
    const selected = organizations.data.find((organization) => organization.id === id);
    setSelectedOrganizationId(id);
    setActiveOrganization(id);
    await queryClient.invalidateQueries();
    notify({ title: 'Organization switched', message: selected.name, tone: 'success' });
  }

  function submitNewOrganization(event) {
    event.preventDefault();
    if (!newOrgName.trim()) return;
    createOrganization.mutate(newOrgName.trim());
  }

  async function signOut() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="app-frame">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <aside className={`sidebar ${navigationOpen ? 'sidebar-open' : ''}`}>
        <div className="sidebar-head">
          <NavLink className="brand brand-on-dark" to="/dashboard" onClick={() => setNavigationOpen(false)}>
            <span className="brand-mark" aria-hidden="true">L</span>
            <span>Ledgerline</span>
          </NavLink>
          <button className="icon-button sidebar-close" type="button" aria-label="Close navigation" onClick={() => setNavigationOpen(false)}>
            <Icon name="close" />
          </button>
        </div>

        <div className="workspace-label">Workspace</div>
        <nav className="primary-nav" aria-label="Primary navigation">
          {navigation.map(([icon, label, to]) => (
            <NavLink
              className={({ isActive }) => `nav-link ${isActive && to ? 'nav-link-active' : ''}`}
              key={label}
              to={to ?? `/dashboard?module=${icon}`}
              onClick={() => setNavigationOpen(false)}
            >
              <Icon name={icon} />
              <span>{label}</span>
              {!to && <span className="nav-soon">Soon</span>}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-note">
          <span className="status-dot" />
          <div>
            <strong>System ready</strong>
            <span>Ledger controls active</span>
          </div>
        </div>
      </aside>

      {navigationOpen && <button className="sidebar-scrim" type="button" aria-label="Close navigation" onClick={() => setNavigationOpen(false)} />}

      <div className="app-column">
        <header className="topbar">
          <button className="icon-button mobile-menu" type="button" aria-label="Open navigation" aria-expanded={navigationOpen} onClick={() => setNavigationOpen(true)}>
            <Icon name="menu" />
          </button>

          <div className="organization-control">
            <span className="organization-kicker">Viewing books for</span>
            {organizations.isPending && <span className="organization-loading">Loading organizations…</span>}
            {organizations.isError && (
              <AsyncState tone="error" title="Organizations unavailable" message="Try refreshing this page." />
            )}
            {organizations.data && organizations.data.length > 0 && (
              <select aria-label="Active organization" value={activeOrganizationId} onChange={changeOrganization}>
                {organizations.data.map((organization) => (
                  <option value={organization.id} key={organization.id}>{organization.name}</option>
                ))}
              </select>
            )}
          </div>

          <div className="topbar-meta">
            <span className="fiscal-pill">{currentFiscalYear ? `FY ${currentFiscalYear.label}` : 'No fiscal year'}</span>
            {fiscalYearExpired && canManageOrg && (
              <button
                className="secondary-button compact"
                type="button"
                onClick={() => startNextFiscalYear.mutate()}
                disabled={startNextFiscalYear.isPending}
              >
                {startNextFiscalYear.isPending ? 'Starting…' : 'Start next fiscal year'}
              </button>
            )}
            <div className="user-summary">
              <span className="user-avatar" aria-hidden="true">{user?.email?.slice(0, 1).toUpperCase() ?? 'A'}</span>
              <span><strong>{user?.email ?? 'Account user'}</strong><small>Secure session</small></span>
            </div>
            <button className="secondary-button compact" type="button" onClick={signOut}>Sign out</button>
          </div>
        </header>

        <main className="app-content" id="main-content" tabIndex="-1">
          {organizations.data && organizations.data.length === 0 ? (
            <AsyncState
              title="Create your first organization"
              message="You need an organization before you can add customers, invoices, or accounts."
              action={
                <form onSubmit={submitNewOrganization}>
                  <label className="visually-hidden" htmlFor="new-org-name">Organization name</label>
                  <input
                    id="new-org-name"
                    value={newOrgName}
                    onChange={(event) => setNewOrgName(event.target.value)}
                    placeholder="Organization name"
                  />
                  <button className="primary-button" type="submit" disabled={createOrganization.isPending}>
                    {createOrganization.isPending ? 'Creating…' : 'Create organization'}
                  </button>
                </form>
              }
            />
          ) : (
            <Outlet context={{ activeOrganizationId, activeOrganization, currentFiscalYear }} />
          )}
        </main>
      </div>
    </div>
  );
}
