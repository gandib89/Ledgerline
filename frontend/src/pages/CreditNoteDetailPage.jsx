import { useQuery } from '@tanstack/react-query';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { AsyncState } from '../components/AsyncState.jsx';
import { Money } from '../components/Money.jsx';
import { apiRequest } from '../lib/api-client.js';

export function CreditNoteDetailPage() {
  const { id } = useParams();
  const { activeOrganizationId } = useOutletContext();
  const credit = useQuery({ queryKey: ['credit-note', activeOrganizationId, id], queryFn: () => apiRequest(`/credit-notes/${id}`), enabled: Boolean(activeOrganizationId && id) });
  const parties = useQuery({ queryKey: ['parties', activeOrganizationId, 'credit-detail'], queryFn: () => apiRequest('/parties?page=1'), enabled: Boolean(activeOrganizationId) });
  const accounts = useQuery({ queryKey: ['accounts', activeOrganizationId], queryFn: () => apiRequest('/accounts'), enabled: Boolean(activeOrganizationId) });
  const loadError = credit.error ?? parties.error ?? accounts.error;
  if (!activeOrganizationId || credit.isPending || parties.isPending || accounts.isPending) return <AsyncState title="Loading credit note" message="Fetching the correction and ledger references." />;
  if (loadError) return <AsyncState tone="error" title="Credit note unavailable" message={loadError.message} />;
  const document = credit.data;
  const customer = parties.data.find(({ id: partyId }) => partyId === document.partyId);
  const accountNames = Object.fromEntries(accounts.data.map((account) => [account.id, `${account.code} · ${account.name}`]));
  return <div className="accounting-page document-detail-page">
    <div className="page-heading"><div><p className="eyebrow">Posted credit note</p><h1>{document.docNo}</h1><p>{customer?.name ?? 'Unknown customer'} · {document.docDate}</p></div><div className="heading-actions"><Link className="secondary-button button-link" to={`/invoices/${document.parentDocumentId}`}>Open original invoice</Link>{document.journalEntryId && <Link className="secondary-button button-link" to={`/journals?entry=${document.journalEntryId}`}>Open journal entry</Link>}</div></div>
    <article className="invoice-document">
      <div className="document-meta"><div><span>Status</span><strong>{document.status}</strong><small>{document.referenceNo ?? 'No reference'}</small></div><div><span>Reason / notes</span><strong>{document.notes ?? 'No notes'}</strong><small>The original invoice remains in the audit trail.</small></div></div>
      <div className="table-scroll"><table className="data-table"><thead><tr><th>Description</th><th>Account</th><th className="numeric">Qty</th><th className="numeric">Rate</th><th className="numeric">VAT reversal</th><th className="numeric">Credit</th></tr></thead><tbody>{document.lines.map((line) => <tr key={line.id}><td>{line.description}</td><td>{accountNames[line.accountId] ?? line.accountId}</td><td className="numeric">{line.quantity}</td><td className="numeric"><Money value={line.unitPrice} /></td><td className="numeric"><Money value={line.taxAmount} /></td><td className="numeric"><Money value={line.lineTotal} /></td></tr>)}</tbody></table></div>
      <dl className="document-totals"><div><dt>Taxable credit</dt><dd><Money value={document.taxableAmount} /></dd></div><div><dt>VAT reversal</dt><dd><Money value={document.taxAmount} /></dd></div><div className="grand-total"><dt>Total credit</dt><dd><Money value={document.grandTotal} /></dd></div></dl>
    </article>
  </div>;
}
