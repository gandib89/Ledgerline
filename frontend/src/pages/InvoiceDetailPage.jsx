import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { AsyncState } from '../components/AsyncState.jsx';
import { Money } from '../components/Money.jsx';
import { PaymentHistory } from '../components/PaymentHistory.jsx';
import { useToast } from '../components/toast-context.js';
import { apiRequest } from '../lib/api-client.js';

function cents(value) {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
}

function JournalPanel({ journal, accountNames }) {
  if (!journal) {
    return (
      <aside className="journal-panel journal-empty">
        <p className="eyebrow">Double-entry ledger</p>
        <h2>No journal yet</h2>
        <p>Posting this draft creates the permanent debit and credit entry.</p>
      </aside>
    );
  }

  const debit = journal.lines.reduce((total, line) => total + cents(line.debit), 0n);
  const credit = journal.lines.reduce((total, line) => total + cents(line.credit), 0n);
  const balanced = debit === credit;
  const asMoney = (value) => `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;

  return (
    <aside className="journal-panel">
      <div className="section-heading">
        <div><p className="eyebrow">Double-entry ledger</p><h2>{journal.entryNumber}</h2></div>
        <span className={`balance-result ${balanced ? 'balance-ok' : 'balance-error'}`}>{balanced ? 'Debits equal credits' : 'Journal difference detected'}</span>
      </div>
      <div className="table-scroll">
        <table className="data-table journal-table">
          <thead><tr><th scope="col">Account</th><th scope="col">Description</th><th className="numeric" scope="col">Debit</th><th className="numeric" scope="col">Credit</th></tr></thead>
          <tbody>
            {journal.lines.map((line) => (
              <tr key={line.id}>
                <td>{accountNames[line.accountId] ?? line.accountId}</td>
                <td>{line.description ?? '—'}</td>
                <td className="numeric"><Money value={line.debit} /></td>
                <td className="numeric"><Money value={line.credit} /></td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr><th colSpan="2" scope="row">Journal totals</th><td className="numeric"><Money value={asMoney(debit)} /></td><td className="numeric"><Money value={asMoney(credit)} /></td></tr></tfoot>
        </table>
      </div>
    </aside>
  );
}

export function InvoiceDetailPage() {
  const { id } = useParams();
  const { activeOrganizationId, activeOrganization } = useOutletContext();
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const [confirming, setConfirming] = useState(false);

  const invoice = useQuery({
    queryKey: ['invoice', activeOrganizationId, id],
    queryFn: () => apiRequest(`/invoices/${id}`),
    enabled: Boolean(activeOrganizationId && id),
  });
  const parties = useQuery({
    queryKey: ['parties', activeOrganizationId, 'invoice-selector'],
    queryFn: () => apiRequest('/parties?page=1'),
    enabled: Boolean(activeOrganizationId),
  });
  const accounts = useQuery({
    queryKey: ['accounts', activeOrganizationId],
    queryFn: () => apiRequest('/accounts'),
    enabled: Boolean(activeOrganizationId),
  });
  const journal = useQuery({
    queryKey: ['journal-entry', activeOrganizationId, invoice.data?.journalEntryId],
    queryFn: () => apiRequest(`/journal-entries/${invoice.data.journalEntryId}`),
    enabled: Boolean(activeOrganizationId && invoice.data?.journalEntryId),
  });

  const postInvoice = useMutation({
    mutationFn: () => apiRequest(`/invoices/${id}/post`, { method: 'POST' }),
    onSuccess: async ({ invoice: posted, journalEntry }) => {
      queryClient.setQueryData(['invoice', activeOrganizationId, id], posted);
      queryClient.setQueryData(['journal-entry', activeOrganizationId, journalEntry.id], journalEntry);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['invoices'] }),
        queryClient.invalidateQueries({ queryKey: ['trial-balance'] }),
      ]);
      setConfirming(false);
      notify({ title: 'Invoice posted', message: `${posted.docNo} is now in the ledger.`, tone: 'success' });
    },
    onError: (error) => notify({
      title: error.status === 403 ? 'Posting permission required' : 'Could not post invoice',
      message: error.message,
      tone: 'error',
    }),
  });

  if (!activeOrganizationId || invoice.isPending || parties.isPending || accounts.isPending) {
    return <AsyncState title="Loading invoice" message="Fetching the document and accounting references." />;
  }
  const loadError = invoice.error ?? parties.error ?? accounts.error;
  if (loadError) return <AsyncState tone="error" title="Invoice unavailable" message={loadError.message} />;

  const document = invoice.data;
  const customer = parties.data.find((party) => party.id === document.partyId);
  const accountNames = Object.fromEntries(accounts.data.map((account) => [account.id, `${account.code} · ${account.name}`]));
  const canPost = activeOrganization?.permissions?.includes('invoice.post');
  const displayedJournal = journal.data;

  return (
    <div className="accounting-page invoice-detail-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Customer invoice</p>
          <h1>{document.docNo ?? 'Draft invoice'}</h1>
          <p>{customer?.name ?? 'Unknown customer'} · {document.docDate}</p>
        </div>
        <div className="heading-actions">
          <Link className="secondary-button button-link" to="/invoices">Back to invoices</Link>
          {document.status === 'draft' && <Link className="secondary-button button-link" to={`/invoices/${id}/edit`}>Edit draft</Link>}
          {document.status === 'draft' && canPost && <button className="primary-button" type="button" onClick={() => setConfirming(true)}>Post invoice</button>}
        </div>
      </div>

      <div className="document-status-row">
        <span className={`status-pill status-${document.status}`}>{document.status.replace('_', ' ')}</span>
        <span>Version {document.version}</span>
        {document.dueDate && <span>Due {document.dueDate}</span>}
      </div>

      <div className="invoice-ledger-split">
        <article className="invoice-document">
          <div className="document-meta">
            <div><span>Customer</span><strong>{customer?.name ?? 'Unknown customer'}</strong><small>{customer?.code}</small></div>
            <div><span>Reference</span><strong>{document.referenceNo ?? '—'}</strong><small>{document.notes ?? 'No notes'}</small></div>
          </div>
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr><th scope="col">Description</th><th scope="col">Revenue account</th><th className="numeric" scope="col">Qty</th><th className="numeric" scope="col">Rate</th><th className="numeric" scope="col">VAT</th><th className="numeric" scope="col">Total</th></tr></thead>
              <tbody>{document.lines.map((line) => <tr key={line.id}><td>{line.description}</td><td>{accountNames[line.accountId] ?? line.accountId}</td><td className="numeric">{line.quantity}</td><td className="numeric"><Money value={line.unitPrice} /></td><td className="numeric"><Money value={line.taxAmount} /></td><td className="numeric"><Money value={line.lineTotal} /></td></tr>)}</tbody>
            </table>
          </div>
          <dl className="document-totals">
            <div><dt>Subtotal</dt><dd><Money value={document.subtotal} /></dd></div>
            <div><dt>Discount</dt><dd><Money value={document.discountAmount} /></dd></div>
            <div><dt>VAT</dt><dd><Money value={document.taxAmount} /></dd></div>
            <div className="grand-total"><dt>Grand total</dt><dd><Money value={document.grandTotal} /></dd></div>
            <div><dt>Outstanding</dt><dd><Money value={document.outstandingAmount} /></dd></div>
          </dl>
        </article>

        {document.journalEntryId && journal.isPending ? (
          <AsyncState title="Loading journal" message="Opening the permanent ledger entry." />
        ) : journal.isError ? (
          <AsyncState tone="error" title="Journal unavailable" message={journal.error.message} />
        ) : <JournalPanel journal={displayedJournal} accountNames={accountNames} />}
      </div>

      {document.status !== 'draft' && <PaymentHistory organizationId={activeOrganizationId} invoiceId={document.id} />}

      {confirming && (
        <div className="dialog-backdrop">
          <div className="confirmation-dialog" role="dialog" aria-modal="true" aria-label="Post invoice" onKeyDown={(event) => {
            if (event.key === 'Escape' && !postInvoice.isPending) setConfirming(false);
          }}>
            <p className="eyebrow">Final accounting action</p>
            <h2>Post this invoice?</h2>
            <p>Posting changes the draft to posted and creates a permanent journal entry. Review the customer and total first.</p>
            <div className="confirmation-summary"><span>{customer?.name}</span><Money value={document.grandTotal} /></div>
            <div className="dialog-actions">
              <button autoFocus className="secondary-button" type="button" disabled={postInvoice.isPending} onClick={() => setConfirming(false)}>Cancel</button>
              <button className="primary-button" type="button" disabled={postInvoice.isPending} onClick={() => postInvoice.mutate()}>{postInvoice.isPending ? 'Posting…' : 'Confirm posting'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
