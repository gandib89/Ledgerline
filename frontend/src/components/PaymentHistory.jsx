import { useQuery } from '@tanstack/react-query';
import { AsyncState } from './AsyncState.jsx';
import { Money } from './Money.jsx';
import { apiRequest } from '../lib/api-client.js';

export function PaymentHistory({ organizationId, invoiceId }) {
  const history = useQuery({
    queryKey: ['invoice-payments', organizationId, invoiceId],
    queryFn: () => apiRequest(`/invoices/${invoiceId}/payments`),
    enabled: Boolean(organizationId && invoiceId),
  });

  return (
    <section className="report-surface payment-history">
      <div className="section-heading"><div><h2>Payment activity</h2><p>Receipts allocated to this invoice.</p></div></div>
      {history.isPending ? <AsyncState title="Loading payments" message="Checking receipt allocations." />
        : history.isError ? <AsyncState title="Payment history unavailable" message={history.error.message} />
          : history.data.payments.length === 0 ? <AsyncState title="No payments allocated" message="The full invoice amount is still outstanding." />
            : <div className="table-scroll"><table className="data-table"><thead><tr><th>Receipt</th><th>Date</th><th>Reference</th><th className="numeric">Allocated</th></tr></thead><tbody>{history.data.payments.map((payment) => <tr key={payment.receiptId}><td>{payment.receiptNo}</td><td>{payment.docDate}</td><td>{payment.referenceNo ?? 'No reference'}</td><td className="numeric"><Money value={payment.amount} /></td></tr>)}</tbody><tfoot><tr><th colSpan="3">Current outstanding</th><td className="numeric"><Money value={history.data.outstandingAmount} /></td></tr></tfoot></table></div>}
    </section>
  );
}
