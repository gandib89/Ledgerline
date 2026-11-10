import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { AsyncState } from '../components/AsyncState.jsx';
import { Money } from '../components/Money.jsx';
import { useToast } from '../components/toast-context.js';
import { apiRequest } from '../lib/api-client.js';
import { BillPayments } from '../components/BillPayments.jsx';
import { JournalPanel } from './InvoiceDetailPage.jsx';

export function BillDetailPage() {
  const { id } = useParams();
  const { activeOrganizationId, activeOrganization } = useOutletContext();
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const [confirming, setConfirming] = useState(false);
  const [reversing, setReversing] = useState(false);
  const [reverseForm, setReverseForm] = useState({ reason: '', reversalDate: '' });
  const canEdit = Boolean(activeOrganization?.permissions?.includes('bill.create'));
  const canPost = Boolean(activeOrganization?.permissions?.includes('bill.post'));
  // Reversal goes through the shared journal-entry reversal path, which needs journal.post.
  const canReverse = Boolean(activeOrganization?.permissions?.includes('journal.post'));

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
  const journal = useQuery({
    queryKey: ['journal-entry', activeOrganizationId, bill.data?.journalEntryId],
    queryFn: () => apiRequest(`/journal-entries/${bill.data.journalEntryId}`),
    enabled: Boolean(activeOrganizationId && bill.data?.journalEntryId),
  });

  const postBill = useMutation({
    mutationFn: () => apiRequest(`/bills/${id}/post`, { method: 'POST' }),
    onSuccess: async ({ bill: posted, journalEntry }) => {
      queryClient.setQueryData(['bill', activeOrganizationId, id], posted);
      queryClient.setQueryData(['journal-entry', activeOrganizationId, journalEntry.id], journalEntry);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['bills'] }),
        queryClient.invalidateQueries({ queryKey: ['trial-balance'] }),
      ]);
      setConfirming(false);
      notify({ title: 'Bill posted', message: `${posted.docNo} is now in the ledger.`, tone: 'success' });
    },
    onError: (error) => notify({
      title: error.status === 403 ? 'Posting permission required' : 'Could not post bill',
      message: error.message,
      tone: 'error',
    }),
  });

  const reverseBill = useMutation({
    mutationFn: (body) => apiRequest(`/journal-entries/${bill.data.journalEntryId}/reverse`, { method: 'POST', body }),
    onSuccess: async ({ reversal }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['bill', activeOrganizationId, id] }),
        queryClient.invalidateQueries({ queryKey: ['journal-entry'] }),
        queryClient.invalidateQueries({ queryKey: ['bills'] }),
        queryClient.invalidateQueries({ queryKey: ['trial-balance'] }),
      ]);
      setReversing(false);
      setReverseForm({ reason: '', reversalDate: '' });
      notify({ title: 'Bill reversed', message: `Offsetting entry ${reversal.entryNumber} was posted.`, tone: 'success' });
    },
    onError: (error) => notify({ title: 'Could not reverse bill', message: error.message, tone: 'error' }),
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
          {document.status === 'draft' && canPost && <button className="primary-button" type="button" onClick={() => setConfirming(true)}>Post bill</button>}
          {document.status === 'posted' && canReverse && <button className="secondary-button" type="button" onClick={() => setReversing(true)}>Reverse bill</button>}
        </div>
      </div>

      <div className="document-status-row">
        <span className={`status-pill status-${document.status}`}>{document.status.replace('_', ' ')}</span>
        <span>Bill date {document.docDate}</span>
        <span>Posting date {document.postingDate}</span>
        {document.dueDate && <span>Due {document.dueDate}</span>}
      </div>

      <div className="invoice-ledger-split">
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
            <div><dt>Outstanding</dt><dd><Money value={document.outstandingAmount} /></dd></div>
          </dl>
        </article>

        {document.journalEntryId && journal.isPending ? (
          <AsyncState title="Loading journal" message="Opening the permanent ledger entry." />
        ) : journal.isError ? (
          <AsyncState tone="error" title="Journal unavailable" message={journal.error.message} />
        ) : <JournalPanel journal={journal.data} accountNames={accountNames} />}
      </div>

      {document.status !== 'draft' && <BillPayments organizationId={activeOrganizationId} billId={document.id} />}

      {confirming && (
        <div className="dialog-backdrop">
          <div className="confirmation-dialog" role="dialog" aria-modal="true" aria-label="Post bill" onKeyDown={(event) => {
            if (event.key === 'Escape' && !postBill.isPending) setConfirming(false);
          }}>
            <p className="eyebrow">Final accounting action</p>
            <h2>Post this bill?</h2>
            <p>Posting changes the draft to posted and creates a permanent journal entry dated {document.postingDate}. Review the supplier and total first.</p>
            <div className="confirmation-summary"><span>{supplier?.name}</span><Money value={document.grandTotal} /></div>
            <div className="dialog-actions">
              <button autoFocus className="secondary-button" type="button" disabled={postBill.isPending} onClick={() => setConfirming(false)}>Cancel</button>
              <button className="primary-button" type="button" disabled={postBill.isPending} onClick={() => postBill.mutate()}>{postBill.isPending ? 'Posting…' : 'Confirm posting'}</button>
            </div>
          </div>
        </div>
      )}

      {reversing && (
        <div className="dialog-backdrop">
          <form className="confirmation-dialog" role="dialog" aria-modal="true" aria-label="Reverse bill" onKeyDown={(event) => {
            if (event.key === 'Escape' && !reverseBill.isPending) setReversing(false);
          }} onSubmit={(event) => {
            event.preventDefault();
            reverseBill.mutate({ reason: reverseForm.reason, ...(reverseForm.reversalDate ? { reversalDate: reverseForm.reversalDate } : {}) });
          }}>
            <p className="eyebrow">Correction</p>
            <h2>Reverse this bill?</h2>
            <p>This posts an offsetting journal entry and marks the bill reversed. A bill with payments applied cannot be reversed until its Supplier Payment is reversed first.</p>
            <label>Reason<input required autoFocus value={reverseForm.reason} onChange={(event) => setReverseForm((f) => ({ ...f, reason: event.target.value }))} /></label>
            <label>Reversal date (optional)<input type="date" value={reverseForm.reversalDate} onChange={(event) => setReverseForm((f) => ({ ...f, reversalDate: event.target.value }))} /></label>
            <div className="dialog-actions">
              <button className="secondary-button" type="button" disabled={reverseBill.isPending} onClick={() => setReversing(false)}>Cancel</button>
              <button className="primary-button" type="submit" disabled={reverseBill.isPending}>{reverseBill.isPending ? 'Reversing…' : 'Confirm reversal'}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
