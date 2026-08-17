import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useOutletContext } from 'react-router-dom';
import { AsyncState } from '../components/AsyncState.jsx';
import { Money } from '../components/Money.jsx';
import { apiRequest } from '../lib/api-client.js';

export function GeneralLedgerPage() {
  const { activeOrganizationId } = useOutletContext();
  const [accountId, setAccountId] = useState('');
  const [from, setFrom] = useState('2025-07-16');
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const accounts = useQuery({ queryKey: ['accounts', activeOrganizationId], queryFn: () => apiRequest('/accounts'), enabled: Boolean(activeOrganizationId) });
  const ledger = useQuery({
    queryKey: ['general-ledger', activeOrganizationId, accountId, from, to],
    queryFn: () => apiRequest(`/reports/general-ledger?accountId=${accountId}&from=${from}&to=${to}`),
    enabled: Boolean(activeOrganizationId && accountId && from && to),
  });

  return (
    <div className="accounting-page">
      <div className="page-heading"><div><p className="eyebrow">Account activity</p><h1>General Ledger</h1><p>Trace every account movement back to its journal and source document.</p></div></div>
      <div className="filter-bar ledger-filters"><label>Account<select value={accountId} onChange={(event) => setAccountId(event.target.value)}><option value="">Select account</option>{accounts.data?.filter((account) => account.isActive).map((account) => <option key={account.id} value={account.id}>{account.code} - {account.name}</option>)}</select></label><label>From<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label><label>To<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label></div>
      {accounts.isPending ? <AsyncState title="Loading accounts" message="Preparing the account selector." />
        : accounts.isError ? <AsyncState title="Accounts unavailable" message={accounts.error.message} />
          : !accountId ? <AsyncState title="Select an account" message="Ledger movements will appear here." />
            : ledger.isPending ? <AsyncState title="Building ledger" message="Calculating the opening and running balances." />
              : ledger.isError ? <AsyncState title="General Ledger unavailable" message={ledger.error.message} />
                : <section className="report-surface"><div className="ledger-balance-strip"><div><span>Opening balance</span><Money value={ledger.data.openingBalance} /></div><div><span>Closing balance</span><Money value={ledger.data.closingBalance} /></div></div>{ledger.data.lines.length === 0 ? <AsyncState title="No movements" message="No posted entries fall inside this date range." /> : <div className="table-scroll"><table className="data-table report-table"><thead><tr><th>Date</th><th>Entry</th><th>Description</th><th>Source</th><th className="numeric">Debit</th><th className="numeric">Credit</th><th className="numeric">Running balance</th></tr></thead><tbody>{ledger.data.lines.map((line) => <tr key={`${line.journalEntryId}-${line.entryNumber}`}><td>{line.entryDate}</td><td>{line.entryNumber}</td><td>{line.description}</td><td>{line.sourceDocumentId && line.sourceDocType === 'invoice' ? <Link className="document-link" to={`/invoices/${line.sourceDocumentId}`}>{line.sourceDocNo}</Link> : line.sourceDocNo ?? 'Journal'}</td><td className="numeric"><Money value={line.debit} /></td><td className="numeric"><Money value={line.credit} /></td><td className="numeric"><Money value={line.runningBalance} /></td></tr>)}</tbody></table></div>}</section>}
    </div>
  );
}
