import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { AsyncState } from '../components/AsyncState.jsx';
import { apiRequest } from '../lib/api-client.js';
import { useToast } from '../components/toast-context.js';

// Balance-sheet accounts first, then P&L — the order every accountant expects
// to read a chart of accounts in.
const TYPE_ORDER = [
  ['ASSET', 'Assets'],
  ['LIABILITY', 'Liabilities'],
  ['EQUITY', 'Equity'],
  ['REVENUE', 'Revenue'],
  ['EXPENSE', 'Expenses'],
];

const EMPTY_FORM = { code: '', name: '', type: 'ASSET' };

export function AccountsPage() {
  const { activeOrganizationId, activeOrganization } = useOutletContext();
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const canManageOrg = Boolean(activeOrganization?.permissions?.includes('org.manage'));

  const accounts = useQuery({
    // The org id is part of the key so switching orgs refetches rather than
    // showing the previous tenant's chart from cache.
    queryKey: ['accounts', activeOrganizationId],
    queryFn: () => apiRequest('/accounts'),
    enabled: Boolean(activeOrganizationId),
  });

  const createAccount = useMutation({
    mutationFn: (input) => apiRequest('/accounts', { method: 'POST', body: input }),
    onSuccess: (account) => {
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      notify({ title: 'Account added', message: `${account.code} · ${account.name}`, tone: 'success' });
      setDrawerOpen(false);
      setForm(EMPTY_FORM);
    },
    onError: (error) => notify({ title: 'Could not add account', message: error.message, tone: 'error' }),
  });

  function submit(event) {
    event.preventDefault();
    if (!form.code.trim() || !form.name.trim()) return;
    createAccount.mutate({ code: form.code.trim(), name: form.name.trim(), type: form.type });
  }

  return (
    <div className="accounts-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Masters</p>
          <h1>Chart of accounts</h1>
          <p>Every ledger posting lands in one of these accounts.</p>
        </div>
        {canManageOrg && (
          <button className="primary-button" type="button" onClick={() => setDrawerOpen(true)}>
            New account
          </button>
        )}
      </div>

      {!activeOrganizationId || accounts.isPending ? (
        <AsyncState title="Loading accounts" message="Fetching this organization's chart of accounts." />
      ) : accounts.isError ? (
        <AsyncState tone="error" title="Accounts unavailable" message={accounts.error.message} />
      ) : accounts.data.length === 0 ? (
        <AsyncState tone="empty" title="No accounts yet" message="This organization has no chart of accounts." />
      ) : (
        TYPE_ORDER.map(([type, label]) => {
          const group = accounts.data.filter((account) => account.type === type);
          if (group.length === 0) return null;

          return (
            <section className="account-group" key={type}>
              <h2>{label}</h2>
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Code</th>
                    <th scope="col">Name</th>
                    <th scope="col">Flags</th>
                  </tr>
                </thead>
                <tbody>
                  {group.map((account) => (
                    <tr key={account.id}>
                      <td className="numeric">{account.code}</td>
                      <td>{account.name}</td>
                      <td>
                        {/* A control account is reconciled against a subledger,
                            so manual journals into it are blocked server-side. */}
                        {account.isControlAccount && <span className="badge badge-control">Control</span>}
                        {account.isBankAccount && <span className="badge badge-bank">Bank</span>}
                        {!account.isActive && <span className="badge">Inactive</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          );
        })
      )}

      {drawerOpen && (
        <div className="drawer" role="dialog" aria-modal="true" aria-label="New account">
          <form className="drawer-panel" onSubmit={submit} noValidate>
            <h2>New account</h2>

            <label>
              Code
              <input autoFocus value={form.code} onChange={(e) => setForm((current) => ({ ...current, code: e.target.value }))} />
            </label>

            <label>
              Name
              <input value={form.name} onChange={(e) => setForm((current) => ({ ...current, name: e.target.value }))} />
            </label>

            <label>
              Type
              <select value={form.type} onChange={(e) => setForm((current) => ({ ...current, type: e.target.value }))}>
                {TYPE_ORDER.map(([type, label]) => (
                  <option key={type} value={type}>{label}</option>
                ))}
              </select>
            </label>

            <div className="drawer-actions">
              <button className="secondary-button" type="button" onClick={() => setDrawerOpen(false)}>
                Cancel
              </button>
              <button className="primary-button" type="submit" disabled={createAccount.isPending}>
                {createAccount.isPending ? 'Adding…' : 'Add account'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
