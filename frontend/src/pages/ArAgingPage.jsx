import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useOutletContext } from 'react-router-dom';
import { AsyncState } from '../components/AsyncState.jsx';
import { Money } from '../components/Money.jsx';
import { apiRequest } from '../lib/api-client.js';
import { fromCents, toCents } from '../lib/amount.js';
import { todayInNepal } from '../lib/date.js';

export function ArAgingPage() {
  const { activeOrganizationId } = useOutletContext();
  const [asOf, setAsOf] = useState(todayInNepal());
  const [expanded, setExpanded] = useState(new Set());
  const report = useQuery({
    queryKey: ['ar-aging', activeOrganizationId, asOf],
    queryFn: () => apiRequest(`/reports/ar-aging?asOf=${asOf}`),
    enabled: Boolean(activeOrganizationId && asOf),
  });

  function toggle(id) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return (
    <div className="accounting-page">
      <div className="page-heading"><div><p className="eyebrow">Accounts receivable</p><h1>AR Aging</h1><p>See who owes money and how long each balance has been outstanding.</p></div><label className="report-filter">As of<input type="date" value={asOf} onChange={(event) => setAsOf(event.target.value)} /></label></div>
      {report.isPending ? <AsyncState title="Building AR Aging" message="Grouping open invoices by due date." />
        : report.isError ? <AsyncState tone="error" title="AR Aging unavailable" message={report.error.message} />
          : report.data.rows.length === 0 ? <AsyncState tone="empty" title="No outstanding receivables" message="Posted invoices with balances will appear here." />
            : <section className="report-surface"><div className="table-scroll"><table className="data-table report-table aging-table"><thead><tr><th>Customer</th>{report.data.buckets.map((bucket) => <th className="numeric" key={bucket.key}>{bucket.label}</th>)}<th className="numeric">Total</th></tr></thead><tbody>{report.data.rows.flatMap((row) => [
              <tr key={row.partyId}><td><button className="disclosure-button" type="button" aria-expanded={expanded.has(row.partyId)} aria-label={`${expanded.has(row.partyId) ? 'Hide' : 'Show'} invoices for ${row.partyName}`} onClick={() => toggle(row.partyId)}>{row.partyName}</button></td>{report.data.buckets.map((bucket) => <td className="numeric" key={bucket.key}><Money value={row.buckets[bucket.key]} /></td>)}<td className="numeric"><Money value={row.total} /></td></tr>,
              expanded.has(row.partyId) && <tr className="detail-row" key={`${row.partyId}-invoices`}><td colSpan={report.data.buckets.length + 2}><div className="aging-invoices">{row.invoices.map((invoice) => <div key={invoice.id}><Link to={`/invoices/${invoice.id}`}>{invoice.docNo}</Link><span>Due {invoice.dueDate}</span><Money value={invoice.outstandingAmount} /></div>)}</div></td></tr>,
            ])}</tbody><tfoot><tr><th>Outstanding total</th><td colSpan={report.data.buckets.length} /><td className="numeric"><Money value={report.data.totals.grandTotal} /></td></tr></tfoot></table></div>
              <div className={`report-integrity ${report.data.integrity.balanced ? '' : 'integrity-error'}`}><span>{report.data.integrity.balanced ? '✓' : '!'}</span><div><strong>{report.data.integrity.balanced ? 'AR control account agrees' : 'AR control difference detected'}</strong><small>Subledger <Money value={report.data.totals.grandTotal} /> · Control <Money value={report.data.integrity.arControlBalance} />{!report.data.integrity.balanced && <> · Difference <Money value={fromCents(toCents(report.data.totals.grandTotal) - toCents(report.data.integrity.arControlBalance))} /></>}</small></div></div>
            </section>}
    </div>
  );
}
