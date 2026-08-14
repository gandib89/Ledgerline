import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { AsyncState } from '../components/AsyncState.jsx';
import { Money } from '../components/Money.jsx';
import { apiRequest } from '../lib/api-client.js';

function reportPath({ from, asOf }) {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (asOf) params.set('asOf', asOf);
  const query = params.toString();
  return `/reports/trial-balance${query ? `?${query}` : ''}`;
}

export function TrialBalancePage() {
  const { activeOrganizationId } = useOutletContext();
  const [dates, setDates] = useState({ from: '', asOf: '' });
  const report = useQuery({
    queryKey: ['trial-balance', activeOrganizationId, dates],
    queryFn: () => apiRequest(reportPath(dates)),
    enabled: Boolean(activeOrganizationId),
  });

  function updateDate(field, value) {
    setDates((current) => ({ ...current, [field]: value }));
  }

  return (
    <div className="accounting-page trial-balance-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Ledger report</p>
          <h1>Trial Balance</h1>
          <p>Every posted debit and credit grouped by account, with an integrity check.</p>
        </div>
        {report.data && (
          <div className={`report-integrity ${report.data.integrity.balanced ? 'balance-ok' : 'balance-error'}`} role="status">
            <span aria-hidden="true">{report.data.integrity.balanced ? '✓' : '!'}</span>
            <div><strong>{report.data.integrity.balanced ? 'Balanced — zero difference' : 'Difference detected'}</strong><small>Through {report.data.asOf}</small></div>
          </div>
        )}
      </div>

      <section className="filter-bar report-filter" aria-label="Trial Balance dates">
        <label>From
          <input type="date" aria-label="Trial Balance from" value={dates.from} onChange={(event) => updateDate('from', event.target.value)} />
        </label>
        <label>As of
          <input type="date" aria-label="Trial Balance as of" min={dates.from || undefined} value={dates.asOf} onChange={(event) => updateDate('asOf', event.target.value)} />
        </label>
        <span>Only posted journal entries are included.</span>
      </section>

      {!activeOrganizationId || report.isPending ? (
        <AsyncState title="Building Trial Balance" message="Summing posted debits and credits by account." />
      ) : report.isError ? (
        <AsyncState title="Trial Balance unavailable" message={report.error.message} />
      ) : report.data.rows.length === 0 ? (
        <AsyncState title="No posted balances" message="Post an invoice or choose a wider date range." />
      ) : (
        <div className="report-surface">
          <div className="table-scroll">
            <table className="data-table report-table">
              <thead><tr><th scope="col">Code</th><th scope="col">Account</th><th scope="col">Type</th><th className="numeric" scope="col">Total debit</th><th className="numeric" scope="col">Total credit</th><th className="numeric" scope="col">Debit balance</th><th className="numeric" scope="col">Credit balance</th></tr></thead>
              <tbody>{report.data.rows.map((row) => <tr key={row.code}><td>{row.code}</td><td>{row.name}</td><td><span className="account-type">{row.type}</span></td><td className="numeric"><Money value={row.totalDebit} /></td><td className="numeric"><Money value={row.totalCredit} /></td><td className="numeric"><Money value={row.debitBalance} /></td><td className="numeric"><Money value={row.creditBalance} /></td></tr>)}</tbody>
              <tfoot><tr><th colSpan="3" scope="row">Posted totals</th><td className="numeric"><Money value={report.data.totals.debit} /></td><td className="numeric"><Money value={report.data.totals.credit} /></td><td colSpan="2" className="numeric">Difference <Money value={report.data.integrity.difference} /></td></tr></tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
