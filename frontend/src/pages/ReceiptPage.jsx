import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useOutletContext } from 'react-router-dom';
import { AsyncState } from '../components/AsyncState.jsx';
import { Money } from '../components/Money.jsx';
import { useToast } from '../components/toast-context.js';
import { apiRequest } from '../lib/api-client.js';
import { fromCents, isAllocationValid, remainingAmount, sumAmounts, toCents } from '../lib/amount.js';

const emptyForm = { partyId: '', docDate: '', depositAccountId: '', amount: '', referenceNo: '', notes: '' };

function journalIsBalanced(journal) {
  const debit = journal.lines.reduce((sum, line) => sum + toCents(line.debit), 0n);
  const credit = journal.lines.reduce((sum, line) => sum + toCents(line.credit), 0n);
  return debit === credit;
}

function displayAmount(value) {
  try { return fromCents(toCents(value)); } catch { return '0.00'; }
}

export function ReceiptPage() {
  const { activeOrganizationId, activeOrganization } = useOutletContext();
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const [form, setForm] = useState(emptyForm);
  const [allocations, setAllocations] = useState({});
  const [errors, setErrors] = useState({});
  const [result, setResult] = useState(null);

  const parties = useQuery({
    queryKey: ['parties', activeOrganizationId, 'receipt'],
    queryFn: () => apiRequest('/parties?page=1'),
    enabled: Boolean(activeOrganizationId),
  });
  const accounts = useQuery({
    queryKey: ['accounts', activeOrganizationId],
    queryFn: () => apiRequest('/accounts'),
    enabled: Boolean(activeOrganizationId),
  });
  const invoices = useQuery({
    queryKey: ['invoices', activeOrganizationId, 'open', form.partyId],
    queryFn: () => apiRequest(`/invoices?partyId=${form.partyId}&page=1`),
    enabled: Boolean(activeOrganizationId && form.partyId),
  });

  const openInvoices = useMemo(() => (invoices.data ?? []).filter((invoice) =>
    ['posted', 'partially_paid'].includes(invoice.status) && toCents(invoice.outstandingAmount) > 0n), [invoices.data]);
  const allocationValues = openInvoices.map(({ id }) => allocations[id] || '0.00');
  const allocated = isAllocationValid(form.amount || '0.00', allocationValues) ? sumAmounts(allocationValues) : '0.00';
  let remainder;
  try { remainder = form.amount ? remainingAmount(form.amount, allocationValues) : '0.00'; } catch { remainder = '0.00'; }

  const postReceipt = useMutation({
    mutationFn: (body) => apiRequest('/receipts', { method: 'POST', body }),
    onSuccess: async (data) => {
      setResult(data);
      await Promise.all(['invoice', 'invoices', 'invoice-payments', 'trial-balance', 'ar-aging', 'general-ledger', 'dashboard', 'profit-loss', 'balance-sheet', 'bank-reconciliation']
        .map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
      notify({ title: 'Receipt posted', message: `${data.receipt.docNo} is now in the ledger.`, tone: 'success' });
    },
    onError: (error) => notify({ title: 'Could not post receipt', message: error.message, tone: 'error' }),
  });

  function update(name, value) {
    setForm((current) => ({ ...current, [name]: value }));
    setErrors((current) => ({ ...current, [name]: undefined, form: undefined }));
    if (name === 'partyId') setAllocations({});
  }

  function submit(event) {
    event.preventDefault();
    const nextErrors = {};
    if (!form.partyId) nextErrors.partyId = 'Customer is required';
    if (!form.docDate) nextErrors.docDate = 'Receipt date is required';
    if (!form.depositAccountId) nextErrors.depositAccountId = 'Deposit account is required';
    try { if (toCents(form.amount) <= 0n) nextErrors.amount = 'Amount must be greater than zero'; } catch { nextErrors.amount = 'Enter a valid amount'; }
    for (const invoice of openInvoices) {
      const value = allocations[invoice.id];
      if (!value) continue;
      try {
        if (toCents(value) > toCents(invoice.outstandingAmount)) nextErrors.form = 'An allocation cannot exceed the invoice outstanding amount.';
        if (toCents(value) < 0n) nextErrors.form = 'Allocation amounts cannot be negative.';
      } catch { nextErrors.form = 'Enter valid allocation amounts.'; }
    }
    if (form.amount && !isAllocationValid(form.amount, allocationValues)) nextErrors.form ??= 'Allocated total cannot exceed the receipt amount.';
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    postReceipt.mutate({
      ...form,
      allocations: openInvoices.filter(({ id }) => allocations[id] && toCents(allocations[id]) > 0n)
        .map(({ id }) => ({ invoiceId: id, amount: allocations[id] })),
    });
  }

  if (!activeOrganizationId || parties.isPending || accounts.isPending) {
    return <AsyncState title="Loading receipt workspace" message="Fetching customers and deposit accounts." />;
  }
  const loadError = parties.error ?? accounts.error;
  if (loadError) return <AsyncState tone="error" title="Receipt workspace unavailable" message={loadError.message} />;

  const bankAccounts = accounts.data.filter((account) => account.isBankAccount && account.isActive);
  const canCreate = activeOrganization?.permissions?.includes('payment.create');

  return (
    <div className="accounting-page receipt-page">
      <div className="page-heading">
        <div><p className="eyebrow">Cash received</p><h1>Record customer payment</h1><p>Post cash to the ledger and allocate it across open invoices.</p></div>
        <Link className="secondary-button button-link" to="/invoices">View invoices</Link>
      </div>

      {result ? (
        <section className="receipt-result" aria-live="polite">
          <div><span>Receipt posted</span><h2>{result.receipt.docNo}</h2><p>{result.allocations.length} invoice allocation{result.allocations.length === 1 ? '' : 's'} recorded.</p></div>
          <dl className="receipt-summary"><div><dt>Received</dt><dd><Money value={result.receipt.grandTotal} /></dd></div><div><dt>Allocated</dt><dd><Money value={result.receipt.allocatedAmount} /></dd></div><div><dt>Unallocated</dt><dd><Money value={result.receipt.outstandingAmount} /></dd></div></dl>
          <span className={`balance-result ${journalIsBalanced(result.journalEntry) ? 'balance-ok' : 'balance-error'}`}>{journalIsBalanced(result.journalEntry) ? 'Debits equal credits' : 'Journal difference detected'}</span>
          <Link className="primary-button button-link" to={`/receipts/${result.receipt.id}`}>Open receipt</Link>
          <button className="secondary-button" type="button" onClick={() => { setResult(null); setForm(emptyForm); setAllocations({}); }}>Record another receipt</button>
        </section>
      ) : (
        <form className="receipt-layout" onSubmit={submit} noValidate>
          <section className="form-panel">
            <div className="section-heading"><div><h2>Payment details</h2><p>Choose who paid and where the money was deposited.</p></div></div>
            <div className="field-grid">
              <label>Customer<select aria-invalid={Boolean(errors.partyId)} value={form.partyId} onChange={(event) => update('partyId', event.target.value)}><option value="">Select customer</option>{parties.data.filter((party) => party.type === 'customer' && party.isActive).map((party) => <option key={party.id} value={party.id}>{party.code} - {party.name}</option>)}</select>{errors.partyId && <span className="field-error" role="alert">{errors.partyId}</span>}</label>
              <label>Receipt date<input type="date" aria-invalid={Boolean(errors.docDate)} value={form.docDate} onChange={(event) => update('docDate', event.target.value)} />{errors.docDate && <span className="field-error" role="alert">{errors.docDate}</span>}</label>
              <label>Deposit account<select aria-invalid={Boolean(errors.depositAccountId)} value={form.depositAccountId} onChange={(event) => update('depositAccountId', event.target.value)}><option value="">Select bank account</option>{bankAccounts.map((account) => <option key={account.id} value={account.id}>{account.code} - {account.name}</option>)}</select>{errors.depositAccountId && <span className="field-error" role="alert">{errors.depositAccountId}</span>}</label>
              <label>Amount received<input inputMode="decimal" aria-invalid={Boolean(errors.amount)} value={form.amount} onChange={(event) => update('amount', event.target.value)} />{errors.amount && <span className="field-error" role="alert">{errors.amount}</span>}</label>
              <label>Reference<input value={form.referenceNo} onChange={(event) => update('referenceNo', event.target.value)} /></label>
              <label>Notes<input value={form.notes} onChange={(event) => update('notes', event.target.value)} /></label>
            </div>
          </section>

          <section className="report-surface receipt-allocation">
            <div className="section-heading"><div><h2>Allocate to invoices</h2><p>Leave part unallocated when the payment is an advance.</p></div></div>
            {!form.partyId ? <AsyncState tone="empty" title="Choose a customer" message="Their open invoices will appear here." />
              : invoices.isPending ? <AsyncState title="Loading open invoices" message="Checking outstanding balances." />
                : invoices.isError ? <AsyncState tone="error" title="Invoices unavailable" message={invoices.error.message} />
                  : openInvoices.length === 0 ? <AsyncState tone="empty" title="No open invoices" message="This customer has nothing awaiting payment." />
                    : <div className="table-scroll"><table className="data-table"><thead><tr><th>Invoice</th><th>Due</th><th className="numeric">Outstanding</th><th className="numeric">Allocate</th></tr></thead><tbody>{openInvoices.map((invoice) => <tr key={invoice.id}><td>{invoice.docNo}</td><td>{invoice.dueDate ?? 'No due date'}</td><td className="numeric"><Money value={invoice.outstandingAmount} /></td><td className="numeric"><input className="allocation-input" inputMode="decimal" aria-label={`Allocate to ${invoice.docNo}`} value={allocations[invoice.id] ?? ''} onChange={(event) => { setAllocations((current) => ({ ...current, [invoice.id]: event.target.value })); setErrors((current) => ({ ...current, form: undefined })); }} /></td></tr>)}</tbody></table></div>}
            {errors.form && <div className="form-alert" role="alert">{errors.form}</div>}
          </section>

          <aside className="receipt-totals">
            <div><span>Received</span><Money value={displayAmount(form.amount || '0.00')} /></div>
            <div><span>Allocated</span><Money value={allocated} /></div>
            <div className={toCents(remainder) < 0n ? 'negative-total' : ''}><span>Unallocated remainder</span><Money value={remainder} /></div>
            <button className="primary-button" type="submit" disabled={!canCreate || postReceipt.isPending}>{postReceipt.isPending ? 'Posting receipt…' : 'Post receipt'}</button>
            {!canCreate && <p className="muted-copy">Payment creation permission is required.</p>}
          </aside>
        </form>
      )}
    </div>
  );
}
