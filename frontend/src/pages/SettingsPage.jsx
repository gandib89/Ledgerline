import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { AsyncState } from '../components/AsyncState.jsx';
import { Money } from '../components/Money.jsx';
import { OrganizationCreator } from '../components/OrganizationCreator.jsx';
import { useToast } from '../components/toast-context.js';
import { apiRequest } from '../lib/api-client.js';

const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'];

export function SettingsPage() {
  const { activeOrganizationId, activeOrganization } = useOutletContext();
  const canManage = activeOrganization?.permissions?.includes('org.manage') ?? false;
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const [member, setMember] = useState({ email: '', roleId: '' });
  const [account, setAccount] = useState({ code: '', name: '', type: 'EXPENSE' });
  const [bank, setBank] = useState({ accountId: '', bankName: '', accountNoMasked: '', openingBalance: '0.00' });

  const enabled = Boolean(activeOrganizationId && canManage);
  const members = useQuery({ queryKey: ['members', activeOrganizationId], queryFn: () => apiRequest(`/orgs/${activeOrganizationId}/members`), enabled });
  const roles = useQuery({ queryKey: ['roles', activeOrganizationId], queryFn: () => apiRequest('/roles'), enabled });
  const accounts = useQuery({ queryKey: ['accounts', activeOrganizationId], queryFn: () => apiRequest('/accounts'), enabled });
  const fiscalYears = useQuery({ queryKey: ['fiscal-years', activeOrganizationId], queryFn: () => apiRequest('/fiscal-years'), enabled });
  const fiscalYearId = fiscalYears.data?.find((item) => !item.isClosed)?.id ?? fiscalYears.data?.[0]?.id ?? '';
  const periods = useQuery({ queryKey: ['periods', activeOrganizationId, fiscalYearId], queryFn: () => apiRequest(`/periods?fiscalYearId=${fiscalYearId}`), enabled: Boolean(enabled && fiscalYearId) });
  const bankAccounts = useQuery({ queryKey: ['bank-accounts', activeOrganizationId], queryFn: () => apiRequest('/bank-accounts'), enabled });

  function mutation({ mutationFn, success, queries, reset }) {
    return {
      mutationFn,
      onSuccess: async (data) => {
        await Promise.all(queries.map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
        reset?.();
        notify({ title: success, message: data.name ?? data.bankName ?? data.user?.email ?? data.label ?? 'Saved', tone: 'success' });
      },
      onError: (error) => notify({ title: 'Could not save change', message: error.message, tone: 'error' }),
    };
  }

  const addMember = useMutation(mutation({
    mutationFn: (body) => apiRequest(`/orgs/${activeOrganizationId}/members`, { method: 'POST', body }),
    success: 'Member added', queries: ['members'], reset: () => setMember({ email: '', roleId: '' }),
  }));
  const createAccount = useMutation(mutation({
    mutationFn: (body) => apiRequest('/accounts', { method: 'POST', body }),
    success: 'Ledger account created', queries: ['accounts'], reset: () => setAccount({ code: '', name: '', type: 'EXPENSE' }),
  }));
  const createBankAccount = useMutation(mutation({
    mutationFn: (body) => apiRequest('/bank-accounts', { method: 'POST', body }),
    success: 'Bank account created', queries: ['bank-accounts'], reset: () => setBank({ accountId: '', bankName: '', accountNoMasked: '', openingBalance: '0.00' }),
  }));
  const updatePeriod = useMutation({
    mutationFn: ({ id, isOpen }) => apiRequest(`/periods/${id}`, { method: 'PATCH', body: { isOpen } }),
    onSuccess: (updatedPeriod) => {
      queryClient.setQueryData(['periods', activeOrganizationId, fiscalYearId], (current = []) => (
        current.map((period) => (period.id === updatedPeriod.id ? updatedPeriod : period))
      ));
      notify({ title: 'Accounting period updated', message: updatedPeriod.label ?? 'Saved', tone: 'success' });
    },
    onError: (error) => notify({ title: 'Could not save change', message: error.message, tone: 'error' }),
  });

  const loading = [members, roles, accounts, fiscalYears, bankAccounts].some((query) => query.isPending);
  const loadError = [members, roles, accounts, fiscalYears, periods, bankAccounts].find((query) => query.error)?.error;

  return (
    <div className="accounting-page settings-page">
      <div className="page-heading"><div><p className="eyebrow">Administration</p><h1>Organization settings</h1><p>Manage workspaces, access, ledger masters, fiscal controls, and banking setup.</p></div></div>
      <OrganizationCreator />
      {!canManage ? <AsyncState tone="empty" title="Owner access required" message="Only an organization owner can change these settings." />
        : loading ? <AsyncState title="Loading organization settings" message="Fetching members and accounting controls." />
          : loadError ? <AsyncState tone="error" title="Settings unavailable" message={loadError.message} /> : (
            <div className="settings-grid">
              <section className="settings-card settings-wide">
                <div className="section-heading"><div><h2>Team access</h2><p>Assign a role to an existing Ledgerline user.</p></div></div>
                <form className="inline-form" onSubmit={(event) => { event.preventDefault(); addMember.mutate(member); }}>
                  <label>Member email<input type="email" required value={member.email} onChange={(event) => setMember((current) => ({ ...current, email: event.target.value }))} /></label>
                  <label>Member role<select required value={member.roleId} onChange={(event) => setMember((current) => ({ ...current, roleId: event.target.value }))}><option value="">Select role</option>{roles.data.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label>
                  <button className="primary-button" type="submit" disabled={!member.email || !member.roleId || addMember.isPending}>Add member</button>
                </form>
                <div className="table-scroll"><table className="data-table"><thead><tr><th>Email</th><th>Role</th><th>Status</th></tr></thead><tbody>{members.data.map((item) => <tr key={item.id}><td>{item.user.email}</td><td>{item.role.name}</td><td>{item.isActive ? 'Active' : 'Inactive'}</td></tr>)}</tbody></table></div>
              </section>

              <section className="settings-card">
                <div className="section-heading"><div><h2>New ledger account</h2><p>Add a posting destination to the chart.</p></div></div>
                <form className="compact-form" onSubmit={(event) => { event.preventDefault(); createAccount.mutate(account); }}>
                  <label>Account code<input required value={account.code} onChange={(event) => setAccount((current) => ({ ...current, code: event.target.value }))} /></label>
                  <label>Account name<input required value={account.name} onChange={(event) => setAccount((current) => ({ ...current, name: event.target.value }))} /></label>
                  <label>Account type<select value={account.type} onChange={(event) => setAccount((current) => ({ ...current, type: event.target.value }))}>{ACCOUNT_TYPES.map((type) => <option key={type}>{type}</option>)}</select></label>
                  <button className="primary-button" type="submit" disabled={!account.code || !account.name || createAccount.isPending}>Create ledger account</button>
                </form>
              </section>

              <section className="settings-card">
                <div className="section-heading"><div><h2>Bank account</h2><p>Connect a bank record to a bank-type ledger account.</p></div></div>
                <form className="compact-form" onSubmit={(event) => { event.preventDefault(); createBankAccount.mutate(bank); }}>
                  <label>Bank ledger account<select required value={bank.accountId} onChange={(event) => setBank((current) => ({ ...current, accountId: event.target.value }))}><option value="">Select account</option>{accounts.data.filter((item) => item.isBankAccount).map((item) => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}</select></label>
                  <label>Bank name<input required value={bank.bankName} onChange={(event) => setBank((current) => ({ ...current, bankName: event.target.value }))} /></label>
                  <label>Masked account number<input required value={bank.accountNoMasked} onChange={(event) => setBank((current) => ({ ...current, accountNoMasked: event.target.value }))} placeholder="****1234" /></label>
                  <label>Opening balance<input inputMode="decimal" required value={bank.openingBalance} onChange={(event) => setBank((current) => ({ ...current, openingBalance: event.target.value }))} /></label>
                  <button className="primary-button" type="submit" disabled={!bank.accountId || !bank.bankName || !bank.accountNoMasked || createBankAccount.isPending}>Create bank account</button>
                </form>
                {bankAccounts.data.length > 0 && <ul className="settings-list">{bankAccounts.data.map((item) => <li key={item.id}><span><strong>{item.bankName}</strong><small>{item.accountNoMasked}</small></span><Money value={item.openingBalance} /></li>)}</ul>}
              </section>

              <section className="settings-card settings-wide">
                <div className="section-heading"><div><h2>Fiscal controls</h2><p>Lock periods after reporting is finalized.</p></div></div>
                <div className="fiscal-year-row">{fiscalYears.data.map((year) => <span className="fiscal-pill" key={year.id}>{year.label}{year.isClosed ? ' · Closed' : ''}</span>)}</div>
                {periods.isPending ? <AsyncState title="Loading periods" message="Fetching the fiscal calendar." /> : <div className="period-list">{periods.data?.map((period) => <div key={period.id}><span><strong>{period.label}</strong><small>{period.startDate} — {period.endDate}</small></span><span className={`status-pill ${period.isOpen ? 'status-posted' : 'status-reversed'}`}>{period.isOpen ? 'Open' : 'Locked'}</span><button className="secondary-button compact" type="button" aria-label={`${period.isOpen ? 'Lock' : 'Reopen'} ${period.label}`} disabled={updatePeriod.isPending} onClick={() => updatePeriod.mutate({ id: period.id, isOpen: !period.isOpen })}>{period.isOpen ? 'Lock period' : 'Reopen period'}</button></div>)}</div>}
              </section>
            </div>
          )}
    </div>
  );
}
