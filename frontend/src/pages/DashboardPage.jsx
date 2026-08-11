import { useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { AsyncState } from '../components/AsyncState.jsx';
import { Money } from '../components/Money.jsx';
import { apiRequest } from '../lib/api-client.js';

const cards = [
  ['totalReceivables', 'Receivables', 'Awaiting customer payment'],
  ['overdue', 'Overdue', 'Past agreed due date'],
  ['revenue', 'Revenue', 'Current reporting period'],
  ['cashAtBank', 'Cash at bank', 'Book balance'],
];

export function DashboardPage() {
  const { activeOrganizationId } = useOutletContext();
  const summary = useQuery({
    queryKey: ['dashboard-summary', activeOrganizationId],
    queryFn: () => apiRequest('/dashboard/summary'),
    enabled: Boolean(activeOrganizationId),
  });

  return (
    <div className="dashboard-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Control center</p>
          <h1>Financial overview</h1>
          <p>One calm view of the records that will become your source of truth.</p>
        </div>
        <div className="integrity-badge"><span>✓</span> Ledger checks enabled</div>
      </div>

      {!activeOrganizationId || summary.isPending ? (
        <AsyncState title="Preparing your workspace" message="Loading organization context and balances." />
      ) : summary.isError ? (
        <AsyncState title="Dashboard unavailable" message={summary.error.message} />
      ) : (
        <>
          <div className="period-row"><span>{summary.data.periodLabel}</span><span>Amounts in NPR</span></div>
          <section className="metric-grid" aria-label="Financial summary">
            {cards.map(([key, label, caption]) => (
              <article className="metric-card" key={key}>
                <span>{label}</span>
                <Money value={summary.data[key]} />
                <small>{caption}</small>
              </article>
            ))}
          </section>
        </>
      )}

      <section className="foundation-grid">
        <article className="foundation-panel">
          <div className="panel-heading"><div><p className="eyebrow">Day 1 foundation</p><h2>Ready for real accounting data</h2></div><span className="completion-ring">6/6</span></div>
          <ul className="readiness-list">
            <li><span>01</span><div><strong>Secure API boundary</strong><small>Auth, organization, idempotency, and normalized errors</small></div><b>Ready</b></li>
            <li><span>02</span><div><strong>Decimal-safe display</strong><small>Money enters the UI as strings and renders consistently</small></div><b>Ready</b></li>
            <li><span>03</span><div><strong>Mock contract</strong><small>Frontend work continues without waiting for backend routes</small></div><b>Ready</b></li>
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
