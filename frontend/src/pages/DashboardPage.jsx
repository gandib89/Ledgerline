import { useQueries, useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { AsyncState } from '../components/AsyncState.jsx';
import { Money } from '../components/Money.jsx';
import { apiRequest } from '../lib/api-client.js';
import { fromCents, toCents } from '../lib/amount.js';

const cards = [
  ['totalReceivables', 'Receivables', 'Awaiting customer payment'],
  ['overdue', 'Overdue', 'Past agreed due date'],
  ['revenue', 'Revenue', 'Current reporting period'],
  ['cashAtBank', 'Cash at bank', 'Book balance'],
];

export function DashboardPage() {
  const { activeOrganizationId } = useOutletContext();
  const asOf = new Date().toISOString().slice(0, 10);
  const aging = useQuery({
    queryKey: ['ar-aging', activeOrganizationId, asOf],
    queryFn: () => apiRequest(`/reports/ar-aging?asOf=${asOf}`),
    enabled: Boolean(activeOrganizationId),
  });
  const profitLoss = useQuery({
    queryKey: ['profit-loss', activeOrganizationId, '2025-07-16', asOf],
    queryFn: () => apiRequest(`/reports/profit-loss?from=2025-07-16&to=${asOf}`),
    enabled: Boolean(activeOrganizationId),
  });
  const bankAccounts = useQuery({
    queryKey: ['bank-accounts', activeOrganizationId],
    queryFn: () => apiRequest('/bank-accounts'),
    enabled: Boolean(activeOrganizationId),
  });
  const cashLedgers = useQueries({
    queries: (bankAccounts.data ?? []).map((bank) => ({
      queryKey: ['general-ledger', activeOrganizationId, bank.accountId, '1900-01-01', asOf],
      queryFn: () => apiRequest(`/reports/general-ledger?accountId=${bank.accountId}&from=1900-01-01&to=${asOf}`),
      enabled: Boolean(activeOrganizationId),
    })),
  });

  const pending = aging.isPending || profitLoss.isPending || bankAccounts.isPending || cashLedgers.some((query) => query.isPending);
  const error = aging.error ?? profitLoss.error ?? bankAccounts.error ?? cashLedgers.find((query) => query.error)?.error;
  const overdue = aging.data ? fromCents(aging.data.rows.reduce((total, row) => total + Object.entries(row.buckets)
    .filter(([key]) => key !== 'current')
    .reduce((rowTotal, [, value]) => rowTotal + toCents(value), 0n), 0n)) : '0.00';
  const cashAtBank = fromCents(cashLedgers.reduce((total, query) => total + toCents(query.data?.closingBalance ?? '0.00'), 0n));
  const summary = aging.data && profitLoss.data ? {
    totalReceivables: aging.data.totals.grandTotal,
    overdue,
    revenue: profitLoss.data.revenueTotal,
    cashAtBank,
    periodLabel: 'FY 2082/83 · Current period',
  } : null;

  return (
    <div className="dashboard-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Control center</p>
          <h1>Financial overview</h1>
          <p>A live view of receivables, revenue, and cash derived from posted ledger activity.</p>
        </div>
        <div className="integrity-badge"><span>✓</span> Ledger checks enabled</div>
      </div>

      {!activeOrganizationId || pending ? (
        <AsyncState title="Preparing your workspace" message="Loading organization context and balances." />
      ) : error ? (
        <AsyncState title="Dashboard unavailable" message={error.message} />
      ) : (
        <>
          <div className="period-row"><span>{summary.periodLabel}</span><span>Amounts in NPR</span></div>
          <section className="metric-grid" aria-label="Financial summary">
            {cards.map(([key, label, caption]) => (
              <article className="metric-card" key={key}>
                <span>{label}</span>
                <Money value={summary[key]} />
                <small>{caption}</small>
              </article>
            ))}
          </section>
        </>
      )}

      <section className="foundation-grid">
        <article className="foundation-panel">
          <div className="panel-heading"><div><p className="eyebrow">Operational controls</p><h2>The cash cycle is connected</h2></div><span className="completion-ring">5/5</span></div>
          <ul className="readiness-list">
            <li><span>01</span><div><strong>Receivables</strong><small>Invoices, receipts, allocations, and aging stay connected</small></div><b>Live</b></li>
            <li><span>02</span><div><strong>Bank control</strong><small>Statement differences remain visible until resolved</small></div><b>Live</b></li>
            <li><span>03</span><div><strong>Ledger reports</strong><small>Every displayed balance comes from posted journal lines</small></div><b>Live</b></li>
          </ul>
        </article>

        <aside className="ledger-card">
          <p className="eyebrow">The core promise</p>
          <h2>Every total will trace back to a line.</h2>
          <div className="journal-mini">
            <div><span>Accounts Receivable</span><b>Dr 113,000.00</b></div>
            <div><span>Sales Revenue</span><b>Cr 100,000.00</b></div>
            <div><span>VAT Payable</span><b>Cr 13,000.00</b></div>
          </div>
          <div className="journal-balance"><span>Balanced entry</span><strong>113,000 = 113,000</strong></div>
        </aside>
      </section>
    </div>
  );
}
