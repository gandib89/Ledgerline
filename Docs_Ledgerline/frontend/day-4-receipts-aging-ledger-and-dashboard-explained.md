# Day 4 Frontend Receipts, Aging, General Ledger, and Dashboard — Explained from Zero

## 1. What we built

Day 4 completed the customer-payment side of Accounts Receivable. A user could choose a customer, see unpaid invoices, enter one receipt, distribute that receipt across several invoices, watch the unallocated remainder, post the receipt, and then inspect updated payment history, outstanding balances, AR Aging, General Ledger activity, and dashboard totals.

```text
Posted invoice
  → customer owes money
    → receipt arrives
      → allocations connect receipt to invoices
        → outstanding amounts fall
          → AR Aging and dashboard refresh
            → General Ledger remains balanced
```

## 2. Why this work was necessary

Receiving money and allocating money are related but different facts:

- The receipt records cash received.
- An allocation states which invoice balance the cash settles.
- One receipt may settle several invoices.
- One invoice may receive several partial payments.
- Unallocated cash must be visible rather than silently lost.

The frontend guides the user, while the backend transaction and row locks enforce the real financial constraints.

## 3. Architecture and important files

| File | Day 4 status | Role |
|---|---|---|
| `frontend/src/lib/amount.js` | Created | Performs exact cents-based UI comparisons and allocation totals. |
| `frontend/src/pages/ReceiptPage.jsx` | Created | Coordinates customer selection, open invoices, allocations, remaining amount, and receipt posting. |
| `frontend/src/components/PaymentHistory.jsx` | Created | Displays receipt/credit allocations on invoice detail. |
| `frontend/src/pages/ArAgingPage.jsx` | Created | Groups outstanding receivables into age buckets and compares them with the AR control account. |
| `frontend/src/pages/GeneralLedgerPage.jsx` | Created | Shows account movements and running balances with source links. |
| `frontend/src/pages/DashboardPage.jsx` | Modified | Adds receivables, overdue, revenue, and cash KPIs from report endpoints. |
| `frontend/src/pages/InvoiceDetailPage.jsx` | Modified supporting file | Embeds payment history and refreshed outstanding amount. |

**Commit:** `8bd29ce88ebf461ad54bc36edeab76ee43fac815` — “Day 4 and 5 collective frontend update” on 2026-08-17. Day 4 and Day 5 frontend work were committed together; this report separates the Day 4 responsibilities according to the plan.

## 4. The code explained from zero

### File: `frontend/src/lib/amount.js`

**Status:** Created

```jsx
const DECIMAL_RE = /^-?\d+(?:\.\d{1,2})?$/;

export function toCents(value) {
  if (typeof value !== 'string' || !DECIMAL_RE.test(value)) {
    throw new TypeError('Amount must be a decimal string with at most two decimal places');
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return negative ? -cents : cents;
}

export function fromCents(value) {
  const negative = value < 0n;
  const unsigned = negative ? -value : value;
  return `${negative ? '-' : ''}${unsigned / 100n}.${(unsigned % 100n).toString().padStart(2, '0')}`;
}

export function sumAmounts(values) {
  return fromCents(values.reduce((total, value) => total + toCents(value), 0n));
}

export function remainingAmount(total, allocations) {
  return fromCents(toCents(total) - toCents(sumAmounts(allocations)));
}

export function isAllocationValid(total, allocations) {
  try {
    const totalCents = toCents(total);
    const amounts = allocations.map(toCents);
    return totalCents > 0n
      && amounts.every((amount) => amount >= 0n)
      && amounts.reduce((sum, amount) => sum + amount, 0n) <= totalCents;
  } catch {
    return false;
  }
}
```

**Purpose:** Converts decimal strings into integer cents for safe browser-side comparisons and indicators.

**Why does this file exist?** The allocation screen must answer whether allocations exceed a receipt and how much remains. Binary floating-point arithmetic can make simple decimal equality unreliable.

**How does it connect to other files?** `ReceiptPage` calls these helpers for UI validation. The backend still uses its own decimal library and database transaction as the authority.

Important concepts:

- `BigInt` stores integers of arbitrary size exactly.
- Converting `"100000.00"` to `10000000n` cents avoids fractional binary arithmetic.
- A regular expression splits whole and fractional digits.
- A leading minus sign is handled separately.
- Functions such as `addAmountStrings` return a decimal string for display or request construction.
- The helper is appropriate for two-decimal UI allocation amounts; ledger storage still supports the project’s configured precision.

Function flow for `toCents(value)`:

- **Data in:** a decimal string.
- **Processing:** validate, extract digits, pad two fractional places, combine them into one integer, apply sign.
- **Data out:** exact `BigInt` cents.
- **Who calls it:** allocation and reconciliation UI.
- **What it calls:** string and BigInt operations.

### File: `frontend/src/pages/ReceiptPage.jsx`

**Status:** Created

**Purpose:** Guides a user through receiving money and assigning it to open invoices.

**Why does this file exist?** Payment allocation has several interacting rules. The user needs immediate visibility into outstanding invoice values, chosen allocations, and the remaining receipt amount.

**How does it connect to other files?** It loads customers, accounts, and open invoices; posts to the receipt endpoint; uses exact amount helpers and `Money`; reads permissions; invalidates invoice, payment-history, aging, ledger, Trial Balance, and dashboard queries.

```jsx
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
  if (loadError) return <AsyncState title="Receipt workspace unavailable" message={loadError.message} />;

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
            {!form.partyId ? <AsyncState title="Choose a customer" message="Their open invoices will appear here." />
              : invoices.isPending ? <AsyncState title="Loading open invoices" message="Checking outstanding balances." />
                : invoices.isError ? <AsyncState title="Invoices unavailable" message={invoices.error.message} />
                  : openInvoices.length === 0 ? <AsyncState title="No open invoices" message="This customer has nothing awaiting payment." />
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
```

Important concepts:

- Derived state is calculated from existing state rather than stored separately. The allocated total and remainder are derived from allocation inputs.
- `useMemo` avoids recalculating filtered lists unless their inputs change.
- An object keyed by invoice ID makes each allocation field independently addressable.
- Validation disables posting when the receipt is empty, allocations are invalid, or the user lacks permission.
- The mutation request contains the receipt header and an array of non-zero allocations.
- The live remainder is guidance. The server repeats total/outstanding checks under database locks.

Function flow for allocation editing:

- **Data in:** invoice ID and typed decimal amount.
- **Processing:** replace that invoice’s allocation in state, sum all allocation strings exactly, compare against receipt and invoice outstanding values.
- **Data out:** updated inputs, allocated total, remainder, and validation messages.
- **Who calls it:** each allocation input’s change handler.
- **What it calls:** amount helpers.

Function flow for posting:

- **Data in:** customer, date, deposit account, receipt amount, reference, notes, and allocation map.
- **Processing:** convert allocation map to request rows, POST the receipt, then invalidate every dependent query.
- **Data out:** posted receipt response, cleared form, and updated downstream screens.
- **Who calls it:** the receipt form.
- **What it calls:** API client, query client, and toast provider.

Runtime:

1. User selects a customer.
2. Query loads that customer’s open invoices.
3. User enters receipt amount and allocation amounts.
4. Frontend displays exact allocated and remaining totals.
5. User submits.
6. Backend authenticates, authorizes, and starts a transaction.
7. Invoice rows are locked in deterministic order.
8. Server checks allocations do not exceed receipt or outstanding balances.
9. Receipt journal and allocation records commit together.
10. Frontend invalidates all affected reads.
11. Invoice status, AR Aging, Trial Balance, General Ledger, and dashboard refresh.

### File: `frontend/src/components/PaymentHistory.jsx`

**Status:** Created

```jsx
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
```

**Purpose:** Shows how an invoice’s outstanding amount changed.

**Why does this file exist?** A user should not see only a smaller balance; they should be able to explain which receipts or credit notes caused it.

**How does it connect to other files?** `InvoiceDetailPage` passes the invoice ID. The component queries the invoice’s payment-history endpoint and renders allocation amounts with `Money`.

Important concepts:

- A focused component owns one small responsibility.
- It receives an `invoiceId` prop, which is input from its parent.
- Its query key includes that ID.
- Empty state means no allocations, not a loading failure.

### File: `frontend/src/pages/ArAgingPage.jsx`

**Status:** Created

```jsx
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useOutletContext } from 'react-router-dom';
import { AsyncState } from '../components/AsyncState.jsx';
import { Money } from '../components/Money.jsx';
import { apiRequest } from '../lib/api-client.js';
import { fromCents, toCents } from '../lib/amount.js';

export function ArAgingPage() {
  const { activeOrganizationId } = useOutletContext();
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const [expanded, setExpanded] = useState(new Set());
  const report = useQuery({
    queryKey: ['ar-aging', activeOrganizationId, asOf],
    queryFn: () => apiRequest(`/reports/ar-aging?asOf=${asOf}`),
    enabled: Boolean(activeOrganizationId && asOf),
  });

  function toggle(id) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return (
    <div className="accounting-page">
      <div className="page-heading"><div><p className="eyebrow">Accounts receivable</p><h1>AR Aging</h1><p>See who owes money and how long each balance has been outstanding.</p></div><label className="report-filter">As of<input type="date" value={asOf} onChange={(event) => setAsOf(event.target.value)} /></label></div>
      {report.isPending ? <AsyncState title="Building AR Aging" message="Grouping open invoices by due date." />
        : report.isError ? <AsyncState title="AR Aging unavailable" message={report.error.message} />
          : report.data.rows.length === 0 ? <AsyncState title="No outstanding receivables" message="Posted invoices with balances will appear here." />
            : <section className="report-surface"><div className="table-scroll"><table className="data-table report-table aging-table"><thead><tr><th>Customer</th>{report.data.buckets.map((bucket) => <th className="numeric" key={bucket.key}>{bucket.label}</th>)}<th className="numeric">Total</th></tr></thead><tbody>{report.data.rows.flatMap((row) => [
              <tr key={row.partyId}><td><button className="disclosure-button" type="button" aria-expanded={expanded.has(row.partyId)} aria-label={`${expanded.has(row.partyId) ? 'Hide' : 'Show'} invoices for ${row.partyName}`} onClick={() => toggle(row.partyId)}>{row.partyName}</button></td>{report.data.buckets.map((bucket) => <td className="numeric" key={bucket.key}><Money value={row.buckets[bucket.key]} /></td>)}<td className="numeric"><Money value={row.total} /></td></tr>,
              expanded.has(row.partyId) && <tr className="detail-row" key={`${row.partyId}-invoices`}><td colSpan={report.data.buckets.length + 2}><div className="aging-invoices">{row.invoices.map((invoice) => <div key={invoice.id}><Link to={`/invoices/${invoice.id}`}>{invoice.docNo}</Link><span>Due {invoice.dueDate}</span><Money value={invoice.outstandingAmount} /></div>)}</div></td></tr>,
            ])}</tbody><tfoot><tr><th>Outstanding total</th><td colSpan={report.data.buckets.length} /><td className="numeric"><Money value={report.data.totals.grandTotal} /></td></tr></tfoot></table></div>
              <div className={`report-integrity ${report.data.integrity.balanced ? '' : 'integrity-error'}`}><span>{report.data.integrity.balanced ? '✓' : '!'}</span><div><strong>{report.data.integrity.balanced ? 'AR control account agrees' : 'AR control difference detected'}</strong><small>Subledger <Money value={report.data.totals.grandTotal} /> · Control <Money value={report.data.integrity.arControlBalance} />{!report.data.integrity.balanced && <> · Difference <Money value={fromCents(toCents(report.data.totals.grandTotal) - toCents(report.data.integrity.arControlBalance))} /></>}</small></div></div>
            </section>}
    </div>
  );
}
```

**Purpose:** Shows unpaid invoices grouped by how overdue they are.

**Why does this file exist?** A total receivable does not communicate urgency. Aging buckets distinguish current debt from 1–30, 31–60, 61–90, and older balances.

**How does it connect to other files?** It calls the AR Aging report endpoint, uses `Money`, offers CSV export through shared report controls, and renders the AR-subledger versus control-account reconciliation line.

Important concepts:

- A subledger is detailed customer-level evidence.
- The AR control account is the General Ledger summary.
- The reconciliation line compares both totals. Equality shows that detailed invoices agree with the ledger.
- A report date makes the result reproducible for a specific point in time.

Runtime:

1. Page requests aging for the selected date.
2. Backend finds posted invoice outstanding balances.
3. It calculates days overdue and assigns buckets.
4. It separately calculates the AR control account balance.
5. Response includes rows, totals, and reconciliation difference.
6. Frontend renders the buckets and clearly labels whether the two sources agree.

### File: `frontend/src/pages/GeneralLedgerPage.jsx`

**Status:** Created

```jsx
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useOutletContext } from 'react-router-dom';
import { AsyncState } from '../components/AsyncState.jsx';
import { Money } from '../components/Money.jsx';
import { apiRequest } from '../lib/api-client.js';

export function GeneralLedgerPage() {
  const { activeOrganizationId } = useOutletContext();
  const [accountId, setAccountId] = useState('');
  const [from, setFrom] = useState('2025-07-16');
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const accounts = useQuery({ queryKey: ['accounts', activeOrganizationId], queryFn: () => apiRequest('/accounts'), enabled: Boolean(activeOrganizationId) });
  const ledger = useQuery({
    queryKey: ['general-ledger', activeOrganizationId, accountId, from, to],
    queryFn: () => apiRequest(`/reports/general-ledger?accountId=${accountId}&from=${from}&to=${to}`),
    enabled: Boolean(activeOrganizationId && accountId && from && to),
  });

  return (
    <div className="accounting-page">
      <div className="page-heading"><div><p className="eyebrow">Account activity</p><h1>General Ledger</h1><p>Trace every account movement back to its journal and source document.</p></div></div>
      <div className="filter-bar ledger-filters"><label>Account<select value={accountId} onChange={(event) => setAccountId(event.target.value)}><option value="">Select account</option>{accounts.data?.filter((account) => account.isActive).map((account) => <option key={account.id} value={account.id}>{account.code} - {account.name}</option>)}</select></label><label>From<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label><label>To<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label></div>
      {accounts.isPending ? <AsyncState title="Loading accounts" message="Preparing the account selector." />
        : accounts.isError ? <AsyncState title="Accounts unavailable" message={accounts.error.message} />
          : !accountId ? <AsyncState title="Select an account" message="Ledger movements will appear here." />
            : ledger.isPending ? <AsyncState title="Building ledger" message="Calculating the opening and running balances." />
              : ledger.isError ? <AsyncState title="General Ledger unavailable" message={ledger.error.message} />
                : <section className="report-surface"><div className="ledger-balance-strip"><div><span>Opening balance</span><Money value={ledger.data.openingBalance} /></div><div><span>Closing balance</span><Money value={ledger.data.closingBalance} /></div></div>{ledger.data.lines.length === 0 ? <AsyncState title="No movements" message="No posted entries fall inside this date range." /> : <div className="table-scroll"><table className="data-table report-table"><thead><tr><th>Date</th><th>Entry</th><th>Description</th><th>Source</th><th className="numeric">Debit</th><th className="numeric">Credit</th><th className="numeric">Running balance</th></tr></thead><tbody>{ledger.data.lines.map((line) => <tr key={`${line.journalEntryId}-${line.entryNumber}`}><td>{line.entryDate}</td><td>{line.entryNumber}</td><td>{line.description}</td><td>{line.sourceDocumentId && line.sourceDocType === 'invoice' ? <Link className="document-link" to={`/invoices/${line.sourceDocumentId}`}>{line.sourceDocNo}</Link> : line.sourceDocNo ?? 'Journal'}</td><td className="numeric"><Money value={line.debit} /></td><td className="numeric"><Money value={line.credit} /></td><td className="numeric"><Money value={line.runningBalance} /></td></tr>)}</tbody></table></div>}</section>}
    </div>
  );
}
```

**Purpose:** Displays journal movements for one account with a running balance.

**Why does this file exist?** Reports summarize results, but accountants need to drill down and see which entries created a balance.

**How does it connect to other files?** It loads accounts for selection, calls the General Ledger report, renders debit/credit/running balance columns, and links source rows back to relevant documents.

Important concepts:

- A running balance applies each row in chronological order.
- Account selection becomes a query parameter and part of the query key.
- Source links connect summarized accounting evidence back to its originating document.
- The page reads journal truth rather than rebuilding it from receipts or invoices.

### File: `frontend/src/pages/DashboardPage.jsx`

**Status:** Modified

```jsx
import { useQueries, useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { AsyncState } from '../components/AsyncState.jsx';
import { Money } from '../components/Money.jsx';
import { apiRequest } from '../lib/api-client.js';
import { fromCents, toCents } from '../lib/amount.js';

const cards = [
  ['totalReceivables', 'Receivables', 'Awaiting customer payment'],
  ['overdue', 'Overdue', 'Past agreed due date'],
  ['revenue', 'Revenue', 'Current reporting period'],
  ['cashAtBank', 'Cash at bank', 'Book balance'],
];

export function DashboardPage() {
  const { activeOrganizationId } = useOutletContext();
  const asOf = new Date().toISOString().slice(0, 10);
  const aging = useQuery({
    queryKey: ['ar-aging', activeOrganizationId, asOf],
    queryFn: () => apiRequest(`/reports/ar-aging?asOf=${asOf}`),
    enabled: Boolean(activeOrganizationId),
  });
  const profitLoss = useQuery({
    queryKey: ['profit-loss', activeOrganizationId, '2025-07-16', asOf],
    queryFn: () => apiRequest(`/reports/profit-loss?from=2025-07-16&to=${asOf}`),
    enabled: Boolean(activeOrganizationId),
  });
  const bankAccounts = useQuery({
    queryKey: ['bank-accounts', activeOrganizationId],
    queryFn: () => apiRequest('/bank-accounts'),
    enabled: Boolean(activeOrganizationId),
  });
  const cashLedgers = useQueries({
    queries: (bankAccounts.data ?? []).map((bank) => ({
      queryKey: ['general-ledger', activeOrganizationId, bank.accountId, '1900-01-01', asOf],
      queryFn: () => apiRequest(`/reports/general-ledger?accountId=${bank.accountId}&from=1900-01-01&to=${asOf}`),
      enabled: Boolean(activeOrganizationId),
    })),
  });

  const pending = aging.isPending || profitLoss.isPending || bankAccounts.isPending || cashLedgers.some((query) => query.isPending);
  const error = aging.error ?? profitLoss.error ?? bankAccounts.error ?? cashLedgers.find((query) => query.error)?.error;
  const overdue = aging.data ? fromCents(aging.data.rows.reduce((total, row) => total + Object.entries(row.buckets)
    .filter(([key]) => key !== 'current')
    .reduce((rowTotal, [, value]) => rowTotal + toCents(value), 0n), 0n)) : '0.00';
  const cashAtBank = fromCents(cashLedgers.reduce((total, query) => total + toCents(query.data?.closingBalance ?? '0.00'), 0n));
  const summary = aging.data && profitLoss.data ? {
    totalReceivables: aging.data.totals.grandTotal,
    overdue,
    revenue: profitLoss.data.revenueTotal,
    cashAtBank,
    periodLabel: 'FY 2082/83 · Current period',
  } : null;

  return (
    <div className="dashboard-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Control center</p>
          <h1>Financial overview</h1>
          <p>A live view of receivables, revenue, and cash derived from posted ledger activity.</p>
        </div>
        <div className="integrity-badge"><span>✓</span> Ledger checks enabled</div>
      </div>

      {!activeOrganizationId || pending ? (
        <AsyncState title="Preparing your workspace" message="Loading organization context and balances." />
      ) : error ? (
        <AsyncState title="Dashboard unavailable" message={error.message} />
      ) : (
        <>
          <div className="period-row"><span>{summary.periodLabel}</span><span>Amounts in NPR</span></div>
          <section className="metric-grid" aria-label="Financial summary">
            {cards.map(([key, label, caption]) => (
              <article className="metric-card" key={key}>
                <span>{label}</span>
                <Money value={summary[key]} />
                <small>{caption}</small>
              </article>
            ))}
          </section>
        </>
      )}

      <section className="foundation-grid">
        <article className="foundation-panel">
          <div className="panel-heading"><div><p className="eyebrow">Operational controls</p><h2>The cash cycle is connected</h2></div><span className="completion-ring">5/5</span></div>
          <ul className="readiness-list">
            <li><span>01</span><div><strong>Receivables</strong><small>Invoices, receipts, allocations, and aging stay connected</small></div><b>Live</b></li>
            <li><span>02</span><div><strong>Bank control</strong><small>Statement differences remain visible until resolved</small></div><b>Live</b></li>
            <li><span>03</span><div><strong>Ledger reports</strong><small>Every displayed balance comes from posted journal lines</small></div><b>Live</b></li>
          </ul>
        </article>

        <aside className="ledger-card">
          <p className="eyebrow">The core promise</p>
          <h2>Every total will trace back to a line.</h2>
          <div className="journal-mini">
            <div><span>Accounts Receivable</span><b>Dr 113,000.00</b></div>
            <div><span>Sales Revenue</span><b>Cr 100,000.00</b></div>
            <div><span>VAT Payable</span><b>Cr 13,000.00</b></div>
          </div>
          <div className="journal-balance"><span>Balanced entry</span><strong>113,000 = 113,000</strong></div>
        </aside>
      </section>
    </div>
  );
}
```

**Purpose:** Gives an immediate operating summary: receivables, overdue amount, period revenue, and bank cash.

**Why does this file exist?** Users need a starting point that answers “What needs attention?” before they open detailed reports.

**How does it connect to other files?** It combines existing report endpoints through TanStack Query and links KPI cards to deeper pages.

Important concepts:

- The dashboard is a read model. It does not own accounting balances.
- Parallel queries allow independent reports to load together.
- KPI cards are summaries; their destination pages provide evidence.
- Errors remain visible instead of replacing financial values with invented zeroes.

## 5. Complete request and runtime flows

### Receipt allocation

```text
ReceiptPage
  → customer selection
    → GET open invoices
      → allocation inputs
        → exact cents helpers
          → POST /receipts
            → auth + tenant + permission
            → database transaction
            → lock invoices
            → validate total and outstanding
            → post receipt journal
            → create allocation rows
              → response
                → invalidate dependent queries
```

### AR reconciliation

```text
Posted invoices − allocations − credit notes
  → AR subledger outstanding
                         ↘
                          compare → difference
                         ↗
Journal lines for AR control account
```

### General Ledger drill-down

```text
Dashboard or report
  → select ledger account
    → GET /reports/general-ledger
      → posted journal lines
        → ordered movements
          → running balance
            → clickable source document
```

## 6. New concepts introduced

- **Receipt:** Evidence that money was received.
- **Allocation:** The link assigning some receipt value to an invoice.
- **Partial payment:** A payment smaller than the invoice’s outstanding balance.
- **Unallocated remainder:** Receipt money not yet assigned to invoices.
- **Accounts Receivable:** Money customers owe the organization.
- **Subledger:** Detailed records supporting a control-account total.
- **AR Aging:** Outstanding receivables grouped by lateness.
- **Control-account reconciliation:** Comparing detailed outstanding invoices with the General Ledger AR balance.
- **General Ledger:** The complete account-by-account record of posted journal lines.
- **Running balance:** Balance after applying each movement in order.
- **Row lock:** A database mechanism preventing two transactions from changing the same financial target incompatibly.
- **Derived state:** A value calculated from other state instead of stored independently.
- **KPI:** A key performance indicator used as a high-level summary.

## 7. Errors and debugging

### Problem: allocation arithmetic could drift

**Risk:** Adding browser floating-point values can produce a remainder smaller than one paisa or falsely reject an exact allocation.

**Diagnosis:** Allocation UI needed arithmetic before the backend response, while project rules prohibited unsafe number conversion for money.

**Fix:** `amount.js` converts two-decimal inputs to exact BigInt cents.

**Lesson:** Comparisons involving money need an explicit numeric representation, even when they are “only UI validation.”

### Problem: successful payment could leave stale reports

**Risk:** A posted receipt affects more than the receipt page.

**Fix:** The success handler invalidates invoice detail, payment history, aging, ledger, Trial Balance, and dashboard query families.

**Lesson:** Trace the accounting event’s downstream readers before deciding which caches to refresh.

### Problem guarded against: concurrent over-allocation

The frontend disables obviously invalid submissions, but two users can submit at nearly the same time. The backend locks invoice rows and checks amounts inside one transaction. This is a real architectural constraint rather than a client-side fix.

No preserved Day 4 terminal error message identifies a separate runtime failure.

## 8. Final understanding check

### On what we built

1. Why are receipt and allocation separate concepts?
2. How can one receipt affect several invoices?
3. Why does an invoice need payment history after its outstanding amount changes?

### On security and integrity

1. Why can the frontend remainder indicator not enforce the final rule?
2. Why are invoice rows locked during allocation?
3. What would go wrong if receipt posting and allocation creation used separate transactions?

### On architecture

1. Why is exact amount logic isolated in `amount.js`?
2. Why does AR Aging include a control-account comparison?
3. Why does Dashboard query reports rather than store KPI totals?

### On request lifecycle

1. Trace a partial payment from form input to updated invoice status.
2. Which screens become stale after a receipt posts?
3. How does a General Ledger row lead back to source evidence?

### On debugging

1. What symptom suggests unsafe floating-point allocation arithmetic?
2. What symptom suggests a missing cache invalidation?
3. If AR Aging and the control account differ, which two data sources are being compared?

## 9. Verification and deferred work

The collective Day 4–5 commit added focused receipt, payment-history, aging, ledger, dashboard, amount-helper, and page tests. The backend already supplied the transaction and report contracts consumed here.

Deferred to Day 5:

- Bank-account statement upload and column mapping.
- Matching and unmatched-item resolution.
- Reconciliation completion.
- P&L, Balance Sheet, reconciliation summary, and safe CSV export.

Deferred to Day 6:

- Audit trail UI.
- Cross-application accessibility and financial presentation audit.
- Mobile reconciliation tabs.
- Exact reproducible demo seed.
