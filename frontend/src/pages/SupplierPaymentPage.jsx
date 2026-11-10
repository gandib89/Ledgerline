import { useRef, useState } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useOutletContext } from 'react-router-dom';
import { AsyncState } from '../components/AsyncState.jsx';
import { Money } from '../components/Money.jsx';
import { useToast } from '../components/toast-context.js';
import { apiRequest } from '../lib/api-client.js';
import { fetchAllPages } from '../lib/fetch-all-pages.js';
import { fromCents, isAllocationValid, remainingAmount, sumAmounts, toCents } from '../lib/amount.js';

const emptyForm = { partyId: '', docDate: '', paidFromAccountId: '', amount: '', referenceNo: '', notes: '' };
const CASH_IN_HAND_CODE = '1010';

function journalIsBalanced(journal) {
  const debit = journal.lines.reduce((sum, line) => sum + toCents(line.debit), 0n);
  const credit = journal.lines.reduce((sum, line) => sum + toCents(line.credit), 0n);
  return debit === credit;
}

function displayAmount(value) {
  try { return fromCents(toCents(value)); } catch { return '0.00'; }
}

export function SupplierPaymentPage() {
  const { activeOrganizationId, activeOrganization } = useOutletContext();
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const [form, setForm] = useState(emptyForm);
  const [allocations, setAllocations] = useState({});
  const [errors, setErrors] = useState({});
  const [result, setResult] = useState(null);
  // One Idempotency-Key per distinct request: a retry of the same body (after a
  // network failure) reuses it and can never pay twice; a changed body gets a new one.
  const attempt = useRef({ fingerprint: null, key: null });

  const canCreate = Boolean(activeOrganization?.permissions?.includes('supplier_payment.create'));

  const parties = useQuery({
    queryKey: ['parties', activeOrganizationId, 'supplier-payment'],
    queryFn: () => fetchAllPages('/parties?type=supplier'),
    enabled: Boolean(activeOrganizationId && canCreate),
  });
  const accounts = useQuery({
    queryKey: ['accounts', activeOrganizationId],
    queryFn: () => apiRequest('/accounts'),
    enabled: Boolean(activeOrganizationId && canCreate),
  });
  // Open = posted or partially paid. The list is paged, so ask for each status
  // (all its pages) rather than filter one page client-side.
  const billQueries = useQueries({
    queries: ['posted', 'partially_paid'].map((status) => ({
      queryKey: ['bills', activeOrganizationId, 'open', status, form.partyId],
      queryFn: () => fetchAllPages(`/bills?partyId=${form.partyId}&status=${status}`),
      enabled: Boolean(activeOrganizationId && canCreate && form.partyId),
    })),
  });
  const billsPending = billQueries.some((q) => q.isPending);
  const billsError = billQueries.find((q) => q.isError)?.error;

  const openBills = billQueries.flatMap((q) => q.data ?? [])
    .filter((bill) => toCents(bill.outstandingAmount) > 0n)
    .sort((x, y) => (x.dueDate ?? '').localeCompare(y.dueDate ?? ''));
  const allocationValues = openBills.map(({ id }) => allocations[id] || '0.00');
  const allocated = isAllocationValid(form.amount || '0.00', allocationValues) ? sumAmounts(allocationValues) : '0.00';
  let remainder;
  try { remainder = form.amount ? remainingAmount(form.amount, allocationValues) : '0.00'; } catch { remainder = '0.00'; }

  const postPayment = useMutation({
    mutationFn: ({ body, key }) => apiRequest('/supplier-payments', { method: 'POST', body, headers: { 'Idempotency-Key': key } }),
    onSuccess: async (data) => {
      setResult(data);
      attempt.current = { fingerprint: null, key: null };
      await Promise.all(['bill', 'bills', 'bill-payments', 'trial-balance', 'general-ledger', 'dashboard', 'profit-loss', 'balance-sheet', 'bank-reconciliation']
        .map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
      notify({ title: 'Supplier payment posted', message: `${data.supplierPayment.docNo} is now in the ledger.`, tone: 'success' });
    },
    onError: (error) => notify({ title: 'Could not post supplier payment', message: error.message, tone: 'error' }),
  });

  function update(name, value) {
    setForm((current) => ({ ...current, [name]: value }));
    setErrors((current) => ({ ...current, [name]: undefined, form: undefined }));
    if (name === 'partyId') setAllocations({});
  }

  function submit(event) {
    event.preventDefault();
    const nextErrors = {};
    if (!form.partyId) nextErrors.partyId = 'Supplier is required';
    if (!form.docDate) nextErrors.docDate = 'Payment date is required';
    if (!form.paidFromAccountId) nextErrors.paidFromAccountId = 'Paid-from account is required';
    try { if (toCents(form.amount) <= 0n) nextErrors.amount = 'Amount must be greater than zero'; } catch { nextErrors.amount = 'Enter a valid amount'; }
    for (const bill of openBills) {
      const value = allocations[bill.id];
      if (!value) continue;
      try {
        if (toCents(value) > toCents(bill.outstandingAmount)) nextErrors.form = 'An allocation cannot exceed the Bill outstanding amount.';
        if (toCents(value) < 0n) nextErrors.form = 'Allocation amounts cannot be negative.';
      } catch { nextErrors.form = 'Enter valid allocation amounts.'; }
    }
    if (form.amount && !isAllocationValid(form.amount, allocationValues)) nextErrors.form ??= 'Allocated total cannot exceed the payment amount.';
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;

    const body = {
      ...form,
      allocations: openBills.filter(({ id }) => allocations[id] && toCents(allocations[id]) > 0n)
        .map(({ id }) => ({ billId: id, amount: allocations[id] })),
    };
    const fingerprint = JSON.stringify(body);
    if (attempt.current.fingerprint !== fingerprint) attempt.current = { fingerprint, key: globalThis.crypto.randomUUID() };
    postPayment.mutate({ body, key: attempt.current.key });
  }

  if (!activeOrganizationId) {
    return <AsyncState title="Loading supplier payment workspace" message="Fetching suppliers and paid-from accounts." />;
  }
  if (!canCreate) {
    return <AsyncState tone="empty" title="Permission required" message="Recording a Supplier Payment needs the supplier_payment.create permission." />;
  }
  if (parties.isPending || accounts.isPending) {
    return <AsyncState title="Loading supplier payment workspace" message="Fetching suppliers and paid-from accounts." />;
  }
  const loadError = parties.error ?? accounts.error;
  if (loadError) return <AsyncState tone="error" title="Supplier payment workspace unavailable" message={loadError.message} />;

  const paidFromAccounts = accounts.data.filter((account) => account.isActive && (account.isBankAccount || account.code === CASH_IN_HAND_CODE));

  return (
    <div className="accounting-page receipt-page">
      <div className="page-heading">
        <div><p className="eyebrow">Cash paid out</p><h1>Pay a supplier</h1><p>Post a payment to the ledger and apply it to the supplier&apos;s open bills.</p></div>
        <Link className="secondary-button button-link" to="/bills">View bills</Link>
      </div>

      {result ? (
        <section className="receipt-result" aria-live="polite">
          <div><span>Supplier payment posted</span><h2>{result.supplierPayment.docNo}</h2><p>{result.allocations.length} bill allocation{result.allocations.length === 1 ? '' : 's'} recorded.</p></div>
          <dl className="receipt-summary"><div><dt>Paid</dt><dd><Money value={result.supplierPayment.grandTotal} /></dd></div><div><dt>Applied</dt><dd><Money value={result.supplierPayment.allocatedAmount} /></dd></div><div><dt>Unapplied</dt><dd><Money value={result.supplierPayment.outstandingAmount} /></dd></div></dl>
          <span className={`balance-result ${journalIsBalanced(result.journalEntry) ? 'balance-ok' : 'balance-error'}`}>{journalIsBalanced(result.journalEntry) ? 'Debits equal credits' : 'Journal difference detected'}</span>
          <Link className="primary-button button-link" to={`/supplier-payments/${result.supplierPayment.id}`}>Open payment</Link>
          <button className="secondary-button" type="button" onClick={() => { setResult(null); setForm(emptyForm); setAllocations({}); }}>Record another payment</button>
        </section>
      ) : (
        <form className="receipt-layout" onSubmit={submit} noValidate>
          <section className="form-panel">
            <div className="section-heading"><div><h2>Payment details</h2><p>Choose who is being paid and where the money comes from.</p></div></div>
            <div className="field-grid">
              <label>Supplier<select aria-invalid={Boolean(errors.partyId)} value={form.partyId} onChange={(event) => update('partyId', event.target.value)}><option value="">Select supplier</option>{parties.data.filter((party) => ['supplier', 'both'].includes(party.type) && party.isActive).map((party) => <option key={party.id} value={party.id}>{party.code} - {party.name}</option>)}</select>{errors.partyId && <span className="field-error" role="alert">{errors.partyId}</span>}</label>
              <label>Payment date<input type="date" aria-invalid={Boolean(errors.docDate)} value={form.docDate} onChange={(event) => update('docDate', event.target.value)} />{errors.docDate && <span className="field-error" role="alert">{errors.docDate}</span>}</label>
              <label>Paid from<select aria-invalid={Boolean(errors.paidFromAccountId)} value={form.paidFromAccountId} onChange={(event) => update('paidFromAccountId', event.target.value)}><option value="">Select bank account or cash</option>{paidFromAccounts.map((account) => <option key={account.id} value={account.id}>{account.code} - {account.name}</option>)}</select>{errors.paidFromAccountId && <span className="field-error" role="alert">{errors.paidFromAccountId}</span>}</label>
              <label>Amount paid<input inputMode="decimal" aria-invalid={Boolean(errors.amount)} value={form.amount} onChange={(event) => update('amount', event.target.value)} />{errors.amount && <span className="field-error" role="alert">{errors.amount}</span>}</label>
              <label>Reference<input value={form.referenceNo} onChange={(event) => update('referenceNo', event.target.value)} /></label>
              <label>Notes<input value={form.notes} onChange={(event) => update('notes', event.target.value)} /></label>
            </div>
          </section>

          <section className="report-surface receipt-allocation">
            <div className="section-heading"><div><h2>Apply to bills</h2><p>Leave part unapplied when the payment is an advance to the supplier.</p></div></div>
            {!form.partyId ? <AsyncState tone="empty" title="Choose a supplier" message="Their open bills will appear here." />
              : billsPending ? <AsyncState title="Loading open bills" message="Checking outstanding balances." />
                : billsError ? <AsyncState tone="error" title="Bills unavailable" message={billsError.message} />
                  : openBills.length === 0 ? <AsyncState tone="empty" title="No open bills" message="This supplier has nothing awaiting payment." />
                    : <div className="table-scroll"><table className="data-table"><thead><tr><th>Bill</th><th>Supplier ref</th><th>Due</th><th className="numeric">Outstanding</th><th className="numeric">Allocate</th></tr></thead><tbody>{openBills.map((bill) => <tr key={bill.id}><td>{bill.docNo}</td><td>{bill.referenceNo}</td><td>{bill.dueDate ?? 'No due date'}</td><td className="numeric"><Money value={bill.outstandingAmount} /></td><td className="numeric"><input className="allocation-input" inputMode="decimal" aria-label={`Allocate to ${bill.docNo}`} value={allocations[bill.id] ?? ''} onChange={(event) => { setAllocations((current) => ({ ...current, [bill.id]: event.target.value })); setErrors((current) => ({ ...current, form: undefined })); }} /></td></tr>)}</tbody></table></div>}
            {errors.form && <div className="form-alert" role="alert">{errors.form}</div>}
          </section>

          <aside className="receipt-totals">
            <div><span>Paid</span><Money value={displayAmount(form.amount || '0.00')} /></div>
            <div><span>Applied</span><Money value={allocated} /></div>
            <div className={toCents(remainder) < 0n ? 'negative-total' : ''}><span>Unapplied amount</span><Money value={remainder} /></div>
            <button className="primary-button" type="submit" disabled={postPayment.isPending}>{postPayment.isPending ? 'Posting payment…' : 'Post supplier payment'}</button>
          </aside>
        </form>
      )}
    </div>
  );
}
