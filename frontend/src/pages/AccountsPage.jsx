import { useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { AsyncState } from '../components/AsyncState.jsx';
import { apiRequest } from '../lib/api-client.js';

// Balance-sheet accounts first, then P&L — the order every accountant expects
// to read a chart of accounts in.
const TYPE_ORDER = [
  ['ASSET', 'Assets'],
  ['LIABILITY', 'Liabilities'],
  ['EQUITY', 'Equity'],
  ['REVENUE', 'Revenue'],
  ['EXPENSE', 'Expenses'],
];

export function AccountsPage() {
  const { activeOrganizationId } = useOutletContext();
  const accounts = useQuery({
    // The org id is part of the key so switching orgs refetches rather than
    // showing the previous tenant's chart from cache.
    queryKey: ['accounts', activeOrganizationId],
    queryFn: () => apiRequest('/accounts'),
    enabled: Boolean(activeOrganizationId),
  });

  return (
    <div className="accounts-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Masters</p>
          <h1>Chart of accounts</h1>
          <p>Every ledger posting lands in one of these accounts.</p>
        </div>
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
    </div>
  );
}
