import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { AsyncState } from '../components/AsyncState.jsx';
import { Money } from '../components/Money.jsx';
import { ReportActions } from '../components/ReportActions.jsx';
import { apiRequest } from '../lib/api-client.js';
import { downloadCsv } from '../lib/csv-export.js';

export function BankReconciliationPage() {
  const { activeOrganizationId } = useOutletContext();
  const [selectedId, setSelectedId] = useState('');
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const accounts = useQuery({ queryKey: ['bank-accounts', activeOrganizationId], queryFn: () => apiRequest('/bank-accounts'), enabled: Boolean(activeOrganizationId) });
  const bankAccountId = selectedId || accounts.data?.[0]?.id || '';
  const report = useQuery({ queryKey: ['bank-reconciliation', activeOrganizationId, bankAccountId, asOf], queryFn: () => apiRequest(`/reports/bank-reconciliation?bankAccountId=${bankAccountId}&asOf=${asOf}`), enabled: Boolean(activeOrganizationId && bankAccountId && asOf) });
  const account = accounts.data?.find(({ id }) => id === bankAccountId);
  const exportRows = report.data ? [{ label: 'Book balance', amount: report.data.bookBalance }, { label: 'Bank balance', amount: report.data.bankBalance }, { label: 'Difference', amount: report.data.difference }] : [];
  return <div className="accounting-page"><div className="page-heading"><div><p className="eyebrow">Bank control</p><h1>Bank Reconciliation Summary</h1><p>Compare the ledger balance with the imported statement.</p></div><ReportActions disabled={!report.data} onExport={() => downloadCsv(`bank-reconciliation-${asOf}.csv`, [{ key: 'label', label: 'Measure' }, { key: 'amount', label: 'Amount (NPR)' }], exportRows)}><label>Bank account<select aria-label="Bank account" value={bankAccountId} onChange={(event) => setSelectedId(event.target.value)}>{accounts.data?.map((item) => <option key={item.id} value={item.id}>{item.bankName} {item.accountNoMasked}</option>)}</select></label><label>As of<input type="date" value={asOf} onChange={(event) => setAsOf(event.target.value)} /></label></ReportActions></div>{accounts.isPending || (bankAccountId && report.isPending) ? <AsyncState title="Loading bank summary" message="Comparing book and statement balances." /> : accounts.isError || report.isError ? <AsyncState tone="error" title="Bank summary unavailable" message={(accounts.error ?? report.error)?.message} /> : !bankAccountId ? <AsyncState tone="empty" title="No bank account" message="Create a bank account before reconciling." /> : <><section className="bank-summary"><div><span>{account?.bankName}</span><strong>{account?.accountNoMasked}</strong></div><div><span>Book balance</span><Money value={report.data.bookBalance} /></div><div><span>Bank balance</span><Money value={report.data.bankBalance} /></div><div className={report.data.integrity.balanced ? 'summary-balanced' : 'summary-difference'}><span>Difference</span><Money value={report.data.difference} /></div></section><div className="reconciliation-counts"><span>{report.data.counts.matched} matched</span><span>{report.data.counts.suggested} suggested</span><span>{report.data.counts.unmatched} unmatched</span><span>{report.data.counts.ignored} ignored</span></div><div className={`report-integrity ${report.data.integrity.balanced ? '' : 'integrity-error'}`}><span>{report.data.integrity.balanced ? '✓' : '!'}</span><div><strong>{report.data.integrity.balanced ? 'Zero difference' : 'Reconciliation difference remains'}</strong><small>{report.data.integrity.balanced ? 'Book and bank balances agree.' : 'Resolve the remaining statement lines before completion.'}</small></div></div></>}</div>;
}
