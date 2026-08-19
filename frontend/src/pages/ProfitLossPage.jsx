import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { AsyncState } from '../components/AsyncState.jsx';
import { Money } from '../components/Money.jsx';
import { ReportActions } from '../components/ReportActions.jsx';
import { apiRequest } from '../lib/api-client.js';
import { downloadCsv } from '../lib/csv-export.js';

export function ProfitLossPage() {
  const { activeOrganizationId } = useOutletContext();
  const [from, setFrom] = useState('2025-07-16');
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const report = useQuery({ queryKey: ['profit-loss', activeOrganizationId, from, to], queryFn: () => apiRequest(`/reports/profit-loss?from=${from}&to=${to}`), enabled: Boolean(activeOrganizationId && from && to) });
  const rows = report.data ? [...report.data.revenue.map((row) => ({ section: 'Revenue', ...row })), ...report.data.expense.map((row) => ({ section: 'Expense', ...row })), { section: 'Result', code: '', name: 'Net profit', amount: report.data.netProfit }] : [];
  return <div className="accounting-page"><div className="page-heading"><div><p className="eyebrow">Financial performance</p><h1>Profit &amp; Loss</h1><p>Revenue earned and expenses incurred during the selected period.</p></div><ReportActions disabled={!report.data} onExport={() => downloadCsv(`profit-loss-${from}-${to}.csv`, [{ key: 'section', label: 'Section' }, { key: 'code', label: 'Code' }, { key: 'name', label: 'Account' }, { key: 'amount', label: 'Amount (NPR)' }], rows)}><label>From<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label><label>To<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label></ReportActions></div>{report.isPending ? <AsyncState title="Building Profit & Loss" message="Summarizing posted revenue and expenses." /> : report.isError ? <AsyncState tone="error" title="Profit & Loss unavailable" message={report.error.message} /> : <div className="statement-grid"><StatementSection title="Revenue" rows={report.data.revenue} totalLabel="Total revenue" total={report.data.revenueTotal} /><StatementSection title="Expenses" rows={report.data.expense} totalLabel="Total expenses" total={report.data.expenseTotal} /><section className="report-result"><span>Net profit</span><Money value={report.data.netProfit} /></section></div>}</div>;
}

function StatementSection({ title, rows, totalLabel, total }) {
  return <section className="report-surface statement-section"><h2>{title}</h2>{rows.length ? <div className="table-scroll"><table className="data-table"><tbody>{rows.map((row) => <tr key={`${row.code}-${row.name}`}><td>{row.code}</td><th>{row.name}</th><td className="numeric"><Money value={row.amount} /></td></tr>)}</tbody><tfoot><tr><th colSpan="2">{totalLabel}</th><td className="numeric"><Money value={total} /></td></tr></tfoot></table></div> : <AsyncState tone="empty" title={`No ${title.toLowerCase()}`} message="No posted accounts have a balance for this period." />}</section>;
}
