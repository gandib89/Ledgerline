import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { AsyncState } from '../components/AsyncState.jsx';
import { Money } from '../components/Money.jsx';
import { ReportActions } from '../components/ReportActions.jsx';
import { apiRequest } from '../lib/api-client.js';
import { downloadCsv } from '../lib/csv-export.js';

function BalanceSection({ title, rows, total }) {
  return <section className="report-surface statement-section"><h2>{title}</h2><div className="table-scroll"><table className="data-table"><tbody>{rows.map((row) => <tr key={`${row.code}-${row.name}`}><td>{row.code ?? ''}</td><th>{row.name}</th><td className="numeric"><Money value={row.amount} /></td></tr>)}</tbody><tfoot><tr><th colSpan="2">Total {title.toLowerCase()}</th><td className="numeric"><Money value={total} /></td></tr></tfoot></table></div></section>;
}

export function BalanceSheetPage() {
  const { activeOrganizationId } = useOutletContext();
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const report = useQuery({ queryKey: ['balance-sheet', activeOrganizationId, asOf], queryFn: () => apiRequest(`/reports/balance-sheet?asOf=${asOf}`), enabled: Boolean(activeOrganizationId && asOf) });
  const rows = report.data ? [...report.data.assets.map((row) => ({ section: 'Assets', ...row })), ...report.data.liabilities.map((row) => ({ section: 'Liabilities', ...row })), ...report.data.equity.map((row) => ({ section: 'Equity', ...row }))] : [];
  return <div className="accounting-page"><div className="page-heading"><div><p className="eyebrow">Financial position</p><h1>Balance Sheet</h1><p>What the organization owns, owes, and retains at the report date.</p></div><ReportActions disabled={!report.data} onExport={() => downloadCsv(`balance-sheet-${asOf}.csv`, [{ key: 'section', label: 'Section' }, { key: 'code', label: 'Code' }, { key: 'name', label: 'Account' }, { key: 'amount', label: 'Amount (NPR)' }], rows)}><label>As of<input type="date" value={asOf} onChange={(event) => setAsOf(event.target.value)} /></label></ReportActions></div>{report.isPending ? <AsyncState title="Building Balance Sheet" message="Calculating balances and current-year earnings." /> : report.isError ? <AsyncState tone="error" title="Balance Sheet unavailable" message={report.error.message} /> : <><div className="balance-sheet-grid"><BalanceSection title="Assets" rows={report.data.assets} total={report.data.totals.assets} /><div><BalanceSection title="Liabilities" rows={report.data.liabilities} total={report.data.totals.liabilities} /><BalanceSection title="Equity" rows={report.data.equity} total={report.data.totals.equity} /></div></div><div className={`report-integrity ${report.data.integrity.balanced ? '' : 'integrity-error'}`}><span>{report.data.integrity.balanced ? '✓' : '!'}</span><div><strong>{report.data.integrity.balanced ? 'Assets equal liabilities plus equity' : 'Balance Sheet difference detected'}</strong><small>Difference <Money value={report.data.integrity.difference} /></small></div></div></>}</div>;
}
