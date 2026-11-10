import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AsyncState } from './AsyncState.jsx';
import { Money } from './Money.jsx';
import { apiRequest } from '../lib/api-client.js';

// The Supplier Payments applied to a Bill - mirror of PaymentHistory for invoices.
export function BillPayments({ organizationId, billId }) {
  const history = useQuery({
    queryKey: ['bill-payments', organizationId, billId],
    queryFn: () => apiRequest(`/bills/${billId}/payments`),
    enabled: Boolean(organizationId && billId),
  });

  return (
    <section className="report-surface payment-history" aria-label="Payments applied">
      <div className="section-heading"><div><h2>Payments applied</h2><p>Supplier Payments allocated to this Bill.</p></div></div>
      {history.isPending ? <AsyncState title="Loading payments" message="Checking Supplier Payment allocations." />
        : history.isError ? <AsyncState tone="error" title="Payments unavailable" message={history.error.message} />
          : history.data.payments.length === 0 ? <AsyncState tone="empty" title="No payments applied" message="The full Bill amount is still outstanding." />
            : <div className="table-scroll"><table className="data-table"><thead><tr><th>Payment</th><th>Date</th><th>Reference</th><th className="numeric">Applied</th></tr></thead><tbody>{history.data.payments.map((payment) => <tr key={payment.supplierPaymentId}><td><Link className="table-link" to={`/supplier-payments/${payment.supplierPaymentId}`}>{payment.supplierPaymentNo}</Link></td><td>{payment.docDate}</td><td>{payment.referenceNo ?? 'No reference'}</td><td className="numeric"><Money value={payment.amount} /></td></tr>)}</tbody><tfoot><tr><th colSpan="3">Current outstanding</th><td className="numeric"><Money value={history.data.outstandingAmount} /></td></tr></tfoot></table></div>}
    </section>
  );
}
