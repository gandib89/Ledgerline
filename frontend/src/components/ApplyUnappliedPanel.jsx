import { useRef, useState } from 'react';
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { AsyncState } from './AsyncState.jsx';
import { Money } from './Money.jsx';
import { useToast } from './toast-context.js';
import { apiRequest } from '../lib/api-client.js';
import { fetchAllPages } from '../lib/fetch-all-pages.js';
import { isAllocationValid, remainingAmount, sumAmounts, toCents } from '../lib/amount.js';

const KINDS = {
  receipt: {
    permission: 'payment.create', paymentPath: '/receipts', listPath: '/invoices', idField: 'invoiceId', label: 'Invoice',
    panel: 'Apply to invoices', paymentKey: 'receipt', documentKeys: ['invoice', 'invoices', 'invoice-payments', 'ar-aging'],
  },
  supplierPayment: {
    permission: 'supplier_payment.create', paymentPath: '/supplier-payments', listPath: '/bills', idField: 'billId', label: 'Bill',
    panel: 'Apply to bills', paymentKey: 'supplier-payment', documentKeys: ['bill', 'bills', 'bill-payments', 'ap-aging'],
  },
};

// Allocates a posted payment's Unapplied Amount to its party's open Invoices /
// Bills after the fact. Renders nothing unless the payment is posted, has an
// Unapplied Amount and the user holds the permission (missing list = no).
export function ApplyUnappliedPanel({ kind, organizationId, permissions, payment }) {
  const k = KINDS[kind];
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const [values, setValues] = useState({});
  const [error, setError] = useState(null);
  // One Idempotency-Key per distinct request: retrying the same body after a
  // failure reuses it, a changed body gets a new one.
  const attempt = useRef({ fingerprint: null, key: null });

  const visible = Boolean(permissions?.includes(k.permission)) && payment.status === 'posted' && toCents(payment.outstandingAmount) > 0n;

  // Open = posted or partially paid; the list is paged, so ask for each status (all pages).
  const queries = useQueries({
    queries: ['posted', 'partially_paid'].map((status) => ({
      queryKey: [k.listPath.slice(1), organizationId, 'open', status, payment.partyId],
      queryFn: () => fetchAllPages(`${k.listPath}?partyId=${payment.partyId}&status=${status}`),
      enabled: Boolean(visible && organizationId),
    })),
  });

  const apply = useMutation({
    mutationFn: ({ body, key }) => apiRequest(`${k.paymentPath}/${payment.id}/allocations`, { method: 'POST', body, headers: { 'Idempotency-Key': key } }),
    onSuccess: async (data) => {
      attempt.current = { fingerprint: null, key: null };
      setValues({});
      await Promise.all([k.paymentKey, ...k.documentKeys, 'dashboard'].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
      notify({ title: 'Unapplied Amount applied', message: `${data.allocations.length} ${k.label.toLowerCase()} allocation${data.allocations.length === 1 ? '' : 's'} recorded.`, tone: 'success' });
    },
    onError: (err) => notify({ title: 'Could not apply amount', message: err.message, tone: 'error' }),
  });

  if (!visible) return null;

  const pending = queries.some((q) => q.isPending);
  const loadError = queries.find((q) => q.isError)?.error;
  const open = queries.flatMap((q) => q.data ?? [])
    .filter((doc) => toCents(doc.outstandingAmount) > 0n)
    .sort((x, y) => (x.dueDate ?? '').localeCompare(y.dueDate ?? ''));

  const entered = open.filter(({ id }) => values[id]);
  const amounts = entered.map(({ id }) => values[id]);
  let after = payment.outstandingAmount;
  try { after = remainingAmount(payment.outstandingAmount, amounts); } catch { /* shown as an error on submit */ }

  function submit(event) {
    event.preventDefault();
    let problem = null;
    for (const doc of entered) {
      try {
        const cents = toCents(values[doc.id]);
        if (cents <= 0n) problem = 'Allocation amounts must be greater than zero.';
        else if (cents > toCents(doc.outstandingAmount)) problem = `An allocation cannot exceed the ${k.label} outstanding amount.`;
      } catch { problem = 'Enter valid allocation amounts (at most two decimal places).'; }
    }
    if (!problem && !isAllocationValid(payment.outstandingAmount, amounts)) problem = 'Allocated total cannot exceed the Unapplied Amount.';
    setError(problem);
    if (problem || entered.length === 0) return;

    const body = { allocations: entered.map(({ id }) => ({ [k.idField]: id, amount: values[id] })) };
    const fingerprint = JSON.stringify(body);
    if (attempt.current.fingerprint !== fingerprint) attempt.current = { fingerprint, key: globalThis.crypto.randomUUID() };
    apply.mutate({ body, key: attempt.current.key });
  }

  return (
    <section className="report-surface" aria-label={k.panel}>
      <div className="section-heading"><div><h2>{k.panel}</h2><p>Allocate the Unapplied Amount of <Money value={payment.outstandingAmount} /> to this party&apos;s open documents.</p></div></div>
      {pending ? <AsyncState title={`Loading open ${k.label.toLowerCase()}s`} message="Checking outstanding balances." />
        : loadError ? <AsyncState tone="error" title={`${k.label}s unavailable`} message={loadError.message} />
          : open.length === 0 ? <AsyncState tone="empty" title={`No open ${k.label.toLowerCase()}s`} message="This party has nothing awaiting settlement." />
            : <form onSubmit={submit} noValidate>
              <div className="table-scroll"><table className="data-table"><thead><tr><th>{k.label}</th><th>Reference</th><th>Due</th><th className="numeric">Outstanding</th><th className="numeric">Apply</th></tr></thead><tbody>{open.map((doc) => <tr key={doc.id}><td>{doc.docNo}</td><td>{doc.referenceNo ?? '—'}</td><td>{doc.dueDate ?? 'No due date'}</td><td className="numeric"><Money value={doc.outstandingAmount} /></td><td className="numeric"><input className="allocation-input" inputMode="decimal" aria-label={`Apply to ${doc.docNo}`} value={values[doc.id] ?? ''} onChange={(event) => { setValues((current) => ({ ...current, [doc.id]: event.target.value })); setError(null); }} /></td></tr>)}</tbody></table></div>
              {error && <div className="form-alert" role="alert">{error}</div>}
              <div className="receipt-totals"><div><span>Unapplied after</span><Money value={after} /></div><button className="primary-button" type="submit" disabled={apply.isPending || entered.length === 0}>{apply.isPending ? 'Applying…' : `Apply to ${k.label.toLowerCase()}s`}</button></div>
            </form>}
    </section>
  );
}
