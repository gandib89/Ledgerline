import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/auth-context.js';
import { apiRequest, setActiveOrganization } from '../lib/api-client.js';
import { AsyncState } from './AsyncState.jsx';
import { Icon } from './Icon.jsx';
import { useToast } from './toast-context.js';

// `to` is set for shipped screens; the rest stay parked until their day.
const navigation = [
  ['dashboard', 'Dashboard', '/dashboard'],
  ['customers', 'Customers', '/customers'],
  ['reports', 'Chart of accounts', '/accounts'],
  ['invoices', 'Invoices'],
  ['receipts', 'Receipts'],
  ['banking', 'Banking'],
  ['audit', 'Audit trail'],
];

export function AppShell() {
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [selectedOrganizationId, setSelectedOrganizationId] = useState('');
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { notify } = useToast();
  const organizations = useQuery({
    queryKey: ['organizations'],
    queryFn: () => apiRequest('/orgs'),
  });
  const activeOrganizationId = selectedOrganizationId || organizations.data?.[0]?.id || '';

  useEffect(() => {
    if (activeOrganizationId) setActiveOrganization(activeOrganizationId);
  }, [activeOrganizationId]);

  async function changeOrganization(event) {
    const id = event.target.value;
    const selected = organizations.data.find((organization) => organization.id === id);
    setSelectedOrganizationId(id);
    setActiveOrganization(id);
    await queryClient.invalidateQueries();
    notify({ title: 'Organization switched', message: selected.name, tone: 'success' });
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
            <span>Frontend foundation</span>
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
              <AsyncState title="Organizations unavailable" message="Try refreshing this page." />
            )}
            {organizations.data && (
              <select aria-label="Active organization" value={activeOrganizationId} onChange={changeOrganization}>
                {organizations.data.map((organization) => (
                  <option value={organization.id} key={organization.id}>{organization.name}</option>
                ))}
              </select>
            )}
          </div>

          <div className="topbar-meta">
            <span className="fiscal-pill">FY 2082/83</span>
            <div className="user-summary">
              <span className="user-avatar" aria-hidden="true">{user?.email?.slice(0, 1).toUpperCase() ?? 'A'}</span>
              <span><strong>{user?.email ?? 'Account user'}</strong><small>Secure session</small></span>
            </div>
            <button className="secondary-button compact" type="button" onClick={signOut}>Sign out</button>
          </div>
        </header>

        <main className="app-content" id="main-content" tabIndex="-1">
          <Outlet context={{ activeOrganizationId }} />
        </main>
      </div>
    </div>
  );
}
