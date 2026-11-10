import { useQueries, useQuery } from '@tanstack/react-query';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { AsyncState } from '../components/AsyncState.jsx';
import { Money } from '../components/Money.jsx';
import { apiRequest } from '../lib/api-client.js';
import { JournalPanel } from './InvoiceDetailPage.jsx';

export function SupplierPaymentDetailPage() {
  const { id } = useParams();
  const { activeOrganizationId } = useOutletContext();
  const payment = useQuery({ queryKey: ['supplier-payment', activeOrganizationId, id], queryFn: () => apiRequest(`/supplier-payments/${id}`), enabled: Boolean(activeOrganizationId && id) });
  const parties = useQuery({ queryKey: ['parties', activeOrganizationId, 'supplier-payment-detail'], queryFn: () => apiRequest('/parties?type=supplier&page=1'), enabled: Boolean(activeOrganizationId) });
  const accounts = useQuery({ queryKey: ['accounts', activeOrganizationId], queryFn: () => apiRequest('/accounts'), enabled: Boolean(activeOrganizationId) });
  const journalEntryId = payment.data?.journalEntryId;
  const journal = useQuery({ queryKey: ['journal-entry', activeOrganizationId, journalEntryId], queryFn: () => apiRequest(`/journal-entries/${journalEntryId}`), enabled: Boolean(activeOrganizationId && journalEntryId) });
  const billQueries = useQueries({ queries: (payment.data?.allocations ?? []).map((allocation) => ({ queryKey: ['bill', activeOrganizationId, allocation.billId], queryFn: () => apiRequest(`/bills/${allocation.billId}`), enabled: Boolean(activeOrganizationId) })) });

  const loadError = payment.error ?? parties.error ?? accounts.error;
  if (!activeOrganizationId || payment.isPending || parties.isPending || accounts.isPending) return <AsyncState title="Loading supplier payment" message="Fetching payment and allocation details." />;
  if (loadError) return <AsyncState tone="error" title="Supplier payment unavailable" message={loadError.message} />;

  const document = payment.data;
  const supplier = parties.data.find(({ id: partyId }) => partyId === document.partyId);
  const accountNames = Object.fromEntries(accounts.data.map((account) => [account.id, `${account.code} · ${account.name}`]));
  // The paid-from account is the credit line of the payment's journal entry.
  const paidFromLine = journal.data?.lines.find((line) => Number(line.credit) > 0);
  const paidFrom = paidFromLine ? accountNames[paidFromLine.accountId] ?? paidFromLine.accountId : null;

  return <div className="accounting-page document-detail-page">
    <div className="page-heading"><div><p className="eyebrow">Supplier payment</p><h1>{document.docNo}</h1><p>{supplier?.name ?? 'Unknown supplier'} · {document.docDate}</p></div><div className="heading-actions"><Link className="secondary-button button-link" to="/supplier-payments/new">Record another payment</Link></div></div>
    <div className="document-status-row"><span className={`status-pill status-${document.status}`}>{document.status}</span><span>Reference {document.referenceNo ?? '—'}</span>{paidFrom && <span>Paid from <strong>{paidFrom}</strong></span>}</div>
    <div className="receipt-detail-grid">
      <section className="report-surface"><div className="section-heading"><div><h2>Bill allocations</h2><p>Where this payment was applied.</p></div></div>{document.allocations.length === 0 ? <AsyncState tone="empty" title="Unapplied payment" message="This payment remains as an advance to the supplier." /> : <div className="table-scroll"><table className="data-table"><thead><tr><th>Bill</th><th>Allocated at</th><th className="numeric">Amount</th></tr></thead><tbody>{document.allocations.map((allocation, index) => <tr key={allocation.billId}><td><Link className="table-link" to={`/bills/${allocation.billId}`}>{billQueries[index]?.data?.docNo ?? allocation.billId}</Link></td><td>{allocation.allocatedAt ? new Date(allocation.allocatedAt).toLocaleString() : '—'}</td><td className="numeric"><Money value={allocation.amount} /></td></tr>)}</tbody></table></div>}</section>
      <aside className="receipt-totals receipt-detail-totals"><div><span>Paid</span><Money value={document.grandTotal} /></div><div><span>Applied</span><Money value={document.allocatedAmount} /></div><div><span>Unapplied</span><Money value={document.outstandingAmount} /></div><p>{document.notes ?? 'No payment notes.'}</p></aside>
    </div>
    {document.journalEntryId && (journal.isPending ? <AsyncState title="Loading journal" message="Opening the permanent ledger entry." />
      : journal.isError ? <AsyncState tone="error" title="Journal unavailable" message={journal.error.message} />
        : <JournalPanel journal={journal.data} accountNames={accountNames} />)}
  </div>;
}
