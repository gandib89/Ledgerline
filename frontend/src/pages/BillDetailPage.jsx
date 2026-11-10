import { useQuery } from '@tanstack/react-query';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { AsyncState } from '../components/AsyncState.jsx';
import { Money } from '../components/Money.jsx';
import { apiRequest } from '../lib/api-client.js';

// Read-only for now: posting and reversal arrive with the posting ticket.
export function BillDetailPage() {
  const { id } = useParams();
  const { activeOrganizationId, activeOrganization } = useOutletContext();
  const canEdit = Boolean(activeOrganization?.permissions?.includes('bill.create'));

  const bill = useQuery({
    queryKey: ['bill', activeOrganizationId, id],
    queryFn: () => apiRequest(`/bills/${id}`),
    enabled: Boolean(activeOrganizationId && id),
  });
  const suppliers = useQuery({
    queryKey: ['parties', activeOrganizationId, 'bill-supplier-selector'],
    queryFn: () => apiRequest('/parties?type=supplier&page=1'),
    enabled: Boolean(activeOrganizationId),
  });
  const accounts = useQuery({
    queryKey: ['accounts', activeOrganizationId],
    queryFn: () => apiRequest('/accounts'),
    enabled: Boolean(activeOrganizationId),
  });

  if (!activeOrganizationId || bill.isPending || suppliers.isPending || accounts.isPending) {
    return <AsyncState title="Loading bill" message="Fetching the document and accounting references." />;
  }
  const loadError = bill.error ?? suppliers.error ?? accounts.error;
  if (loadError) return <AsyncState tone="error" title="Bill unavailable" message={loadError.message} />;

  const document = bill.data;
  const supplier = suppliers.data.find((party) => party.id === document.partyId);
  const accountNames = Object.fromEntries(accounts.data.map((account) => [account.id, `${account.code} · ${account.name}`]));

  return (
    <div className="accounting-page invoice-detail-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Supplier bill</p>
          <h1>{document.docNo ?? 'Draft bill'}</h1>
          <p>{supplier?.name ?? 'Unknown supplier'} · {document.referenceNo}</p>
        </div>
        <div className="heading-actions">
          <Link className="secondary-button button-link" to="/bills">Back to bills</Link>
          {document.status === 'draft' && canEdit && <Link className="secondary-button button-link" to={`/bills/${id}/edit`}>Edit draft</Link>}
        </div>
      </div>

      <div className="document-status-row">
        <span className={`status-pill status-${document.status}`}>{document.status.replace('_', ' ')}</span>
        <span>Bill date {document.docDate}</span>
        <span>Posting date {document.postingDate}</span>
        {document.dueDate && <span>Due {document.dueDate}</span>}
      </div>

      <article className="invoice-document">
        <div className="document-meta">
          <div><span>Supplier</span><strong>{supplier?.name ?? 'Unknown supplier'}</strong><small>{supplier?.code}</small></div>
          <div><span>Supplier reference</span><strong>{document.referenceNo}</strong><small>{document.notes ?? 'No notes'}</small></div>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead><tr><th scope="col">Description</th><th scope="col">Account</th><th className="numeric" scope="col">Qty</th><th className="numeric" scope="col">Rate</th><th className="numeric" scope="col">VAT</th><th className="numeric" scope="col">Total</th></tr></thead>
            <tbody>{document.lines.map((line) => <tr key={line.id}><td>{line.description}</td><td>{accountNames[line.accountId] ?? line.accountId}</td><td className="numeric">{line.quantity}</td><td className="numeric"><Money value={line.unitPrice} /></td><td className="numeric"><Money value={line.taxAmount} /></td><td className="numeric"><Money value={line.lineTotal} /></td></tr>)}</tbody>
          </table>
        </div>
        <dl className="document-totals">
          <div><dt>Subtotal</dt><dd><Money value={document.subtotal} /></dd></div>
          <div><dt>Discount</dt><dd><Money value={document.discountAmount} /></dd></div>
          <div><dt>VAT</dt><dd><Money value={document.taxAmount} /></dd></div>
          <div className="grand-total"><dt>Grand total</dt><dd><Money value={document.grandTotal} /></dd></div>
        </dl>
      </article>
    </div>
  );
}
