import { useQueries, useQuery } from '@tanstack/react-query';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { AsyncState } from '../components/AsyncState.jsx';
import { Money } from '../components/Money.jsx';
import { apiRequest } from '../lib/api-client.js';

export function ReceiptDetailPage() {
  const { id } = useParams();
  const { activeOrganizationId } = useOutletContext();
  const receipt = useQuery({ queryKey: ['receipt', activeOrganizationId, id], queryFn: () => apiRequest(`/receipts/${id}`), enabled: Boolean(activeOrganizationId && id) });
  const parties = useQuery({ queryKey: ['parties', activeOrganizationId, 'receipt-detail'], queryFn: () => apiRequest('/parties?page=1'), enabled: Boolean(activeOrganizationId) });
  const invoiceQueries = useQueries({ queries: (receipt.data?.allocations ?? []).map((allocation) => ({ queryKey: ['invoice', activeOrganizationId, allocation.invoiceId], queryFn: () => apiRequest(`/invoices/${allocation.invoiceId}`), enabled: Boolean(activeOrganizationId) })) });
  const loadError = receipt.error ?? parties.error ?? invoiceQueries.find(({ error }) => error)?.error;
  if (!activeOrganizationId || receipt.isPending || parties.isPending) return <AsyncState title="Loading receipt" message="Fetching payment and allocation details." />;
  if (loadError) return <AsyncState tone="error" title="Receipt unavailable" message={loadError.message} />;
  const document = receipt.data;
  const customer = parties.data.find(({ id: partyId }) => partyId === document.partyId);
  return <div className="accounting-page document-detail-page">
    <div className="page-heading"><div><p className="eyebrow">Customer receipt</p><h1>{document.docNo}</h1><p>{customer?.name ?? 'Unknown customer'} · {document.docDate}</p></div><div className="heading-actions"><Link className="secondary-button button-link" to="/receipts">Record another receipt</Link>{document.journalEntryId && <Link className="secondary-button button-link" to={`/journals?entry=${document.journalEntryId}`}>Open journal entry</Link>}</div></div>
    <div className="document-status-row"><span className={`status-pill status-${document.status}`}>{document.status}</span><span>Reference {document.referenceNo ?? '—'}</span></div>
    <div className="receipt-detail-grid">
      <section className="report-surface"><div className="section-heading"><div><h2>Invoice allocations</h2><p>Where this customer payment was applied.</p></div></div>{document.allocations.length === 0 ? <AsyncState tone="empty" title="Unallocated receipt" message="This payment remains as a customer advance." /> : <div className="table-scroll"><table className="data-table"><thead><tr><th>Invoice</th><th>Allocated at</th><th className="numeric">Amount</th></tr></thead><tbody>{document.allocations.map((allocation, index) => <tr key={allocation.invoiceId}><td><Link className="table-link" to={`/invoices/${allocation.invoiceId}`}>{invoiceQueries[index]?.data?.docNo ?? allocation.invoiceId}</Link></td><td>{allocation.allocatedAt ? new Date(allocation.allocatedAt).toLocaleString() : '—'}</td><td className="numeric"><Money value={allocation.amount} /></td></tr>)}</tbody></table></div>}</section>
      <aside className="receipt-totals receipt-detail-totals"><div><span>Received</span><Money value={document.grandTotal} /></div><div><span>Allocated</span><Money value={document.allocatedAmount} /></div><div><span>Unallocated</span><Money value={document.outstandingAmount} /></div><p>{document.notes ?? 'No receipt notes.'}</p></aside>
    </div>
  </div>;
}
