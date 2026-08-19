# Day 3 Frontend Invoices, Ledger Posting, and Trial Balance — Explained from Zero

## 1. What we built

Day 3 made LedgerLine’s accounting engine visible in the browser. Users could list and filter invoices, create or edit a draft with dynamic line items, receive totals calculated by the server, post an invoice when permitted, inspect the balanced journal entry beside the source document, and open a Trial Balance report.

This is the pivotal workflow:

```text
Customer invoice
  → server calculates subtotal and VAT
    → user posts the draft
      → accounting engine creates journal entry
        → debits equal credits
          → Trial Balance includes the posting
```

## 2. Why this work was necessary

An invoicing screen alone does not prove accounting correctness. LedgerLine needs to demonstrate that a commercial document becomes an immutable, balanced ledger event.

The browser intentionally displays server-calculated totals. It does not become a second accounting engine. That keeps VAT, rounding, and journal values under one authoritative backend implementation.

## 3. Architecture and important files

| File | Day 3 status | Role |
|---|---|---|
| `frontend/src/pages/invoice-form.js` | Created | Supplies the frontend draft shape, conversion, and lightweight form checks. |
| `frontend/src/pages/InvoicesPage.jsx` | Created | Lists invoices with party, status, date, and outstanding filters. |
| `frontend/src/pages/InvoiceEditorPage.jsx` | Created | Manages dynamic lines and requests authoritative totals from `POST /invoices/preview`. |
| `frontend/src/pages/InvoiceDetailPage.jsx` | Created | Shows the document and balanced journal side by side and gates posting by permission. |
| `frontend/src/pages/TrialBalancePage.jsx` | Created | Displays ledger-derived debit/credit balances and their equality check. |
| `frontend/src/App.jsx` | Modified supporting file | Registers invoice and Trial Balance routes. |
| `frontend/src/components/AppShell.jsx` | Modified supporting file | Adds navigation destinations. |
| `frontend/src/mocks/handlers.js` | Modified supporting file | Simulates Day 3 contracts in isolated frontend tests. |

**Frontend commit:** `47c2e33584a83123d0d0ad2a4bf45157e252b93c` — “Frontend Day 3 ledger invoice chnges” on 2026-08-14.

## 4. The code explained from zero

### File: `frontend/src/pages/invoice-form.js`

**Status:** Created

**Purpose:** Keeps plain invoice-form logic outside the large React editor.

**Why does this file exist?** Converting API documents into editable form state and checking required fields do not need React. Pure functions are easier to test and reuse.

**How does it connect to other files?** `InvoiceEditorPage` imports its initial values, document mapper, validation, and payload builder.

```jsx
import { z } from 'zod';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const requiredUuid = (message) => z.string().uuid(message);

const invoiceLineSchema = z.object({
  clientId: z.string(),
  accountId: requiredUuid('Revenue account is required'),
  description: z.string().trim().min(1, 'Description is required'),
  quantity: z.coerce.number().positive('Quantity must be greater than zero'),
  unitPrice: z.coerce.number().min(0, 'Unit price cannot be negative'),
  discountPct: z.coerce.number().min(0, 'Discount cannot be negative').max(100, 'Discount cannot exceed 100%'),
  taxCodeId: z.union([z.string().uuid(), z.literal('')]).optional(),
});

export const invoiceLinesSchema = z.array(invoiceLineSchema).min(1, 'Add at least one invoice line');

export const invoiceFormSchema = z.object({
  partyId: requiredUuid('Customer is required'),
  docDate: z.string().regex(ISO_DATE, 'Document date is required'),
  dueDate: z.union([z.string().regex(ISO_DATE), z.literal('')]).optional(),
  referenceNo: z.string().optional(),
  notes: z.string().optional(),
  version: z.number().int().min(0).optional(),
  lines: invoiceLinesSchema,
}).superRefine((form, context) => {
  if (form.dueDate && form.dueDate < form.docDate) {
    context.addIssue({
      code: 'custom',
      path: ['dueDate'],
      message: 'Due date cannot be before document date',
    });
  }
});

export function emptyInvoiceLine() {
  return {
    clientId: globalThis.crypto.randomUUID(),
    accountId: '',
    description: '',
    quantity: '1',
    unitPrice: '0',
    discountPct: '0',
    taxCodeId: '',
  };
}

export function invoiceInput(form) {
  return {
    partyId: form.partyId,
    docDate: form.docDate,
    ...(form.dueDate ? { dueDate: form.dueDate } : {}),
    ...(form.referenceNo?.trim() ? { referenceNo: form.referenceNo.trim() } : {}),
    ...(form.notes?.trim() ? { notes: form.notes.trim() } : {}),
    ...(form.version === undefined ? {} : { version: form.version }),
    lines: invoiceLineInputs(form.lines),
  };
}

export function invoiceLineInputs(lines) {
  return lines.map((line) => ({
      accountId: line.accountId,
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      discountPct: line.discountPct,
      ...(line.taxCodeId ? { taxCodeId: line.taxCodeId } : {}),
    }));
}

export function invoiceValidationErrors(result) {
  if (result.success) return {};
  return Object.fromEntries(result.error.issues.map((issue) => [issue.path.join('.'), issue.message]));
}
```

Important concepts:

- A pure function returns the same output for the same input and does not change external state.
- Parameters are input names inside a function.
- A return value is the output given back to the caller.
- `.map` builds a new line array without changing the source array.
- Spread syntax copies an object before selected fields are replaced.
- `crypto.randomUUID()` supplies client-only row keys. Database IDs are still created by the server.
- The form stores quantities and rates as strings. This prevents accidental floating-point accounting.
- Validation here improves usability. It does not replace server validation.

Function flow for `toInvoicePayload(form)`:

- **Data in:** current editable form state.
- **Processing:** select only API fields and remove browser-only row keys.
- **Data out:** request body for create, update, or preview.
- **Who calls it:** `InvoiceEditorPage`.
- **What it calls:** array `.map`.

### File: `frontend/src/pages/InvoicesPage.jsx`

**Status:** Created

```jsx
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useOutletContext } from 'react-router-dom';
import { AsyncState } from '../components/AsyncState.jsx';
import { Money } from '../components/Money.jsx';
import { apiRequest } from '../lib/api-client.js';

const PAGE_SIZE = 20;
const STATUS_LABELS = {
  draft: 'Draft',
  posted: 'Posted',
  partially_paid: 'Partially paid',
  paid: 'Paid',
  reversed: 'Reversed',
};

function listPath({ partyId, status, from, to, page }) {
  const params = new URLSearchParams({ page: String(page) });
  if (partyId) params.set('partyId', partyId);
  if (status) params.set('status', status);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  return `/invoices?${params}`;
}

export function InvoicesPage() {
  const { activeOrganizationId } = useOutletContext();
  const [filters, setFilters] = useState({ partyId: '', status: '', from: '', to: '', page: 1 });
  const parties = useQuery({
    queryKey: ['parties', activeOrganizationId, 'invoice-selector'],
    queryFn: () => apiRequest('/parties?page=1'),
    enabled: Boolean(activeOrganizationId),
  });
  const invoices = useQuery({
    queryKey: ['invoices', activeOrganizationId, filters],
    queryFn: () => apiRequest(listPath(filters)),
    enabled: Boolean(activeOrganizationId),
  });
  const partyNames = useMemo(
    () => Object.fromEntries((parties.data ?? []).map((party) => [party.id, party.name])),
    [parties.data],
  );

  function updateFilter(field, value) {
    setFilters((current) => ({ ...current, [field]: value, page: 1 }));
  }

  const pending = !activeOrganizationId || invoices.isPending || parties.isPending;

  return (
    <div className="accounting-page invoices-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Sales ledger</p>
          <h1>Invoices</h1>
          <p>Prepare customer invoices, track what remains due, and open the accounting entry.</p>
        </div>
        <Link className="primary-button button-link" to="/invoices/new">New invoice</Link>
      </div>

      <section className="filter-bar" aria-label="Invoice filters">
        <label>Customer
          <select aria-label="Invoice customer" value={filters.partyId} onChange={(event) => updateFilter('partyId', event.target.value)}>
            <option value="">All customers</option>
            {(parties.data ?? []).map((party) => <option key={party.id} value={party.id}>{party.name}</option>)}
          </select>
        </label>
        <label>Status
          <select aria-label="Invoice status" value={filters.status} onChange={(event) => updateFilter('status', event.target.value)}>
            <option value="">All statuses</option>
            {Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label>From
          <input aria-label="Invoices from" type="date" value={filters.from} onChange={(event) => updateFilter('from', event.target.value)} />
        </label>
        <label>To
          <input aria-label="Invoices to" type="date" value={filters.to} min={filters.from || undefined} onChange={(event) => updateFilter('to', event.target.value)} />
        </label>
      </section>

      {pending ? (
        <AsyncState title="Loading invoices" message="Fetching customers and invoice records." />
      ) : invoices.isError || parties.isError ? (
        <AsyncState title="Invoices unavailable" message={(invoices.error ?? parties.error).message} />
      ) : invoices.data.length === 0 ? (
        <AsyncState title="No invoices found" message="Change the filters or prepare the first invoice." action={<Link className="secondary-button button-link" to="/invoices/new">Create invoice</Link>} />
      ) : (
        <>
          <div className="table-scroll">
            <table className="data-table invoice-table">
              <thead><tr><th scope="col">Invoice</th><th scope="col">Date</th><th scope="col">Customer</th><th scope="col">Status</th><th className="numeric" scope="col">Outstanding</th></tr></thead>
              <tbody>
                {invoices.data.map((invoice) => (
                  <tr key={invoice.id}>
                    <td><Link className="document-link" to={`/invoices/${invoice.id}`}>{invoice.docNo ?? 'Unnumbered draft'}</Link></td>
                    <td>{invoice.docDate}</td>
                    <td>{partyNames[invoice.partyId] ?? 'Unknown customer'}</td>
                    <td><span className={`status-pill status-${invoice.status}`}>{STATUS_LABELS[invoice.status] ?? invoice.status}</span></td>
                    <td className="numeric"><Money value={invoice.outstandingAmount} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pagination">
            <button type="button" disabled={filters.page === 1} onClick={() => setFilters((current) => ({ ...current, page: current.page - 1 }))}>Previous</button>
            <span>Page {filters.page}</span>
            <button type="button" disabled={invoices.data.length < PAGE_SIZE} onClick={() => setFilters((current) => ({ ...current, page: current.page + 1 }))}>Next</button>
          </div>
        </>
      )}
    </div>
  );
}
```

**Purpose:** Presents invoice search and status information.

**Why does this file exist?** Users need to locate drafts, posted invoices, partially paid invoices, and outstanding balances before opening individual documents.

**How does it connect to other files?** It requests `/invoices`, loads parties for filter labels, uses `Money`, and links rows to detail/edit routes.

Important concepts:

- `URLSearchParams` safely creates a query string.
- Filter state is separate from server results.
- Query keys contain filters and organization ID, so each result has a precise cache identity.
- Status pills translate machine states into visible operational meaning.
- A link changes routes without reloading the entire React application.
- Money cells use the shared formatter rather than inline number conversion.

Function flow for the query:

- **Data in:** organization, selected customer, status, and date filters.
- **Processing:** build query parameters and send `GET /invoices`.
- **Data out:** an invoice array rendered into rows.
- **Who calls it:** TanStack Query after render or filter changes.
- **What it calls:** `apiRequest`.

Runtime:

1. The route renders the list page.
2. Active organization and filter values form the query key.
3. The browser requests the matching invoices.
4. Express validates authentication and tenant membership.
5. Prisma fetches only that organization’s documents.
6. Decimal strings return in JSON.
7. `Money` displays grand total and outstanding amount.

### File: `frontend/src/pages/InvoiceEditorPage.jsx`

**Status:** Created

**Purpose:** Creates and updates invoice drafts while showing totals previewed by the server.

**Why does this file exist?** An invoice has nested line items, account selection, tax codes, customer selection, dates, validation, save state, and server preview state. This page coordinates those concerns without moving accounting calculations into the browser.

**How does it connect to other files?** It uses the form helper, accounts/parties/tax-code endpoints, invoice detail endpoint for editing, preview endpoint for totals, create/update endpoints for saving, query invalidation, `Money`, and toast feedback.

```jsx
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { AsyncState } from '../components/AsyncState.jsx';
import { Money } from '../components/Money.jsx';
import { useToast } from '../components/toast-context.js';
import { apiRequest } from '../lib/api-client.js';
import {
  emptyInvoiceLine,
  invoiceFormSchema,
  invoiceInput,
  invoiceLineInputs,
  invoiceLinesSchema,
  invoiceValidationErrors,
} from './invoice-form.js';

function newInvoiceForm() {
  return {
    partyId: '',
    docDate: '',
    dueDate: '',
    referenceNo: '',
    notes: '',
    lines: [emptyInvoiceLine()],
  };
}

function formFromInvoice(invoice) {
  return {
    partyId: invoice.partyId,
    docDate: invoice.docDate,
    dueDate: invoice.dueDate ?? '',
    referenceNo: invoice.referenceNo ?? '',
    notes: invoice.notes ?? '',
    version: invoice.version,
    lines: invoice.lines.map((line) => ({
      clientId: line.id,
      accountId: line.accountId,
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      discountPct: line.discountPct,
      taxCodeId: line.taxCodeId ?? '',
    })),
  };
}

function InvoiceTotals({ preview, error, pending }) {
  return (
    <aside className="invoice-totals" aria-live="polite">
      <p className="eyebrow">Server calculation</p>
      <h2>Invoice totals</h2>
      {pending ? <p className="muted-copy">Checking VAT and totals…</p> : error ? (
        <p className="field-error" role="alert">{error.message}</p>
      ) : !preview ? <p className="muted-copy">Complete the required fields to preview exact totals.</p> : (
        <dl className="totals-list">
          <div><dt>Subtotal</dt><dd><Money value={preview.subtotal} /></dd></div>
          <div><dt>Discount</dt><dd><Money value={preview.discountAmount} /></dd></div>
          <div><dt>Taxable amount</dt><dd><Money value={preview.taxableAmount} /></dd></div>
          <div><dt>VAT</dt><dd><Money value={preview.taxAmount} /></dd></div>
          <div className="grand-total"><dt>Grand total</dt><dd><Money value={preview.grandTotal} /></dd></div>
        </dl>
      )}
      <small>Totals are calculated by the accounting API, not this browser.</small>
    </aside>
  );
}

export function InvoiceEditorPage() {
  const { id } = useParams();
  const editing = Boolean(id);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useOutletContext();
  const { notify } = useToast();
  const initializedInvoice = useRef(null);
  const [form, setForm] = useState(newInvoiceForm);
  const [errors, setErrors] = useState({});
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [previewPending, setPreviewPending] = useState(false);
  const [conflict, setConflict] = useState(false);

  const parties = useQuery({
    queryKey: ['parties', activeOrganizationId, 'invoice-selector'],
    queryFn: () => apiRequest('/parties?page=1'),
    enabled: Boolean(activeOrganizationId),
  });
  const accounts = useQuery({
    queryKey: ['accounts', activeOrganizationId, 'REVENUE'],
    queryFn: () => apiRequest('/accounts?type=REVENUE'),
    enabled: Boolean(activeOrganizationId),
  });
  const taxCodes = useQuery({
    queryKey: ['tax-codes', activeOrganizationId],
    queryFn: () => apiRequest('/tax-codes'),
    enabled: Boolean(activeOrganizationId),
  });
  const invoice = useQuery({
    queryKey: ['invoice', activeOrganizationId, id],
    queryFn: () => apiRequest(`/invoices/${id}`),
    enabled: Boolean(activeOrganizationId && id),
  });

  useEffect(() => {
    if (!invoice.data || initializedInvoice.current === invoice.data) return;
    initializedInvoice.current = invoice.data;
    setForm(formFromInvoice(invoice.data));
    setConflict(false);
  }, [invoice.data]);

  useEffect(() => {
    const parsed = invoiceLinesSchema.safeParse(form.lines);
    if (!parsed.success) {
      return undefined;
    }

    let cancelled = false;
    const timer = globalThis.setTimeout(async () => {
      setPreviewPending(true);
      setPreviewError(null);
      try {
        const result = await apiRequest('/invoices/preview', { method: 'POST', body: { lines: invoiceLineInputs(parsed.data) } });
        if (!cancelled) setPreview(result.totals);
      } catch (error) {
        if (!cancelled) setPreviewError(error);
      } finally {
        if (!cancelled) setPreviewPending(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      globalThis.clearTimeout(timer);
    };
  }, [form]);

  const saveInvoice = useMutation({
    mutationFn: (input) => apiRequest(editing ? `/invoices/${id}` : '/invoices', {
      method: editing ? 'PATCH' : 'POST',
      body: input,
    }),
    onSuccess: async (saved) => {
      queryClient.setQueryData(['invoice', activeOrganizationId, saved.id], saved);
      await queryClient.invalidateQueries({ queryKey: ['invoices'] });
      notify({ title: editing ? 'Draft updated' : 'Draft created', message: 'The invoice is ready for review.', tone: 'success' });
      navigate(`/invoices/${saved.id}`);
    },
    onError: (error) => {
      if (error.status === 409) {
        setConflict(true);
        return;
      }
      notify({ title: 'Could not save invoice', message: error.message, tone: 'error' });
    },
  });

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  }

  function updateLine(index, field, value) {
    setForm((current) => ({
      ...current,
      lines: current.lines.map((line, lineIndex) => lineIndex === index ? { ...line, [field]: value } : line),
    }));
    setErrors((current) => ({ ...current, [`lines.${index}.${field}`]: undefined }));
  }

  function addLine() {
    setForm((current) => ({ ...current, lines: [...current.lines, emptyInvoiceLine()] }));
  }

  function removeLine(index) {
    if (form.lines.length === 1) return;
    setForm((current) => ({ ...current, lines: current.lines.filter((_, lineIndex) => lineIndex !== index) }));
  }

  function submit(event) {
    event.preventDefault();
    const parsed = invoiceFormSchema.safeParse(form);
    const found = invoiceValidationErrors(parsed);
    setErrors(found);
    if (!parsed.success) return;
    setConflict(false);
    saveInvoice.mutate(invoiceInput(parsed.data));
  }

  const selectorsPending = parties.isPending || accounts.isPending || taxCodes.isPending || (editing && invoice.isPending);
  const selectorError = parties.error ?? accounts.error ?? taxCodes.error ?? invoice.error;
  const previewEligible = invoiceLinesSchema.safeParse(form.lines).success;

  if (selectorsPending) return <AsyncState title="Preparing invoice editor" message="Loading customers, revenue accounts, and VAT codes." />;
  if (selectorError) return <AsyncState title="Invoice editor unavailable" message={selectorError.message} />;

  return (
    <div className="accounting-page invoice-editor-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{editing ? 'Edit draft' : 'New sales document'}</p>
          <h1>{editing ? 'Edit invoice' : 'Prepare invoice'}</h1>
          <p>Enter the business details; LedgerLine will calculate VAT and accounting totals.</p>
        </div>
        <Link className="secondary-button button-link" to={editing ? `/invoices/${id}` : '/invoices'}>Cancel</Link>
      </div>

      {conflict && (
        <div className="conflict-banner" role="alert">
          <div><strong>This invoice changed in another session.</strong><p>Reload the latest version before making more changes.</p></div>
          <button className="secondary-button" type="button" onClick={() => invoice.refetch()}>Reload invoice</button>
        </div>
      )}

      <form className="invoice-editor-layout" onSubmit={submit} noValidate>
        <div className="invoice-form-main">
          <section className="form-panel" aria-labelledby="invoice-details-title">
            <div className="section-heading"><div><p className="step-label">01</p><h2 id="invoice-details-title">Invoice details</h2></div><span>Amounts in NPR</span></div>
            <div className="field-grid">
              <label>Customer
                <select aria-invalid={Boolean(errors.partyId)} value={form.partyId} onChange={(event) => updateField('partyId', event.target.value)}>
                  <option value="">Select customer</option>
                  {parties.data.filter((party) => party.isActive).map((party) => <option key={party.id} value={party.id}>{party.code} · {party.name}</option>)}
                </select>
                {errors.partyId && <span className="field-error" role="alert">{errors.partyId}</span>}
              </label>
              <label>Document date
                <input type="date" value={form.docDate} aria-invalid={Boolean(errors.docDate)} onChange={(event) => updateField('docDate', event.target.value)} />
                {errors.docDate && <span className="field-error" role="alert">{errors.docDate}</span>}
              </label>
              <label>Due date
                <input type="date" min={form.docDate || undefined} value={form.dueDate} aria-invalid={Boolean(errors.dueDate)} onChange={(event) => updateField('dueDate', event.target.value)} />
                {errors.dueDate && <span className="field-error" role="alert">{errors.dueDate}</span>}
              </label>
              <label>Reference
                <input value={form.referenceNo} onChange={(event) => updateField('referenceNo', event.target.value)} placeholder="Purchase order or reference" />
              </label>
            </div>
            <label className="wide-field">Notes
              <textarea value={form.notes} onChange={(event) => updateField('notes', event.target.value)} rows="3" placeholder="Optional customer-facing or internal note" />
            </label>
          </section>

          <section className="form-panel" aria-labelledby="invoice-lines-title">
            <div className="section-heading"><div><p className="step-label">02</p><h2 id="invoice-lines-title">Revenue lines</h2></div><button className="secondary-button compact" type="button" onClick={addLine}>Add line</button></div>
            <div className="invoice-lines">
              {form.lines.map((line, index) => (
                <fieldset className="invoice-line" key={line.clientId}>
                  <legend>Line {index + 1}</legend>
                  <label className="line-description">Description
                    <input aria-label={`Line ${index + 1} description`} value={line.description} aria-invalid={Boolean(errors[`lines.${index}.description`])} onChange={(event) => updateLine(index, 'description', event.target.value)} />
                    {errors[`lines.${index}.description`] && <span className="field-error" role="alert">{errors[`lines.${index}.description`]}</span>}
                  </label>
                  <label className="line-account">Revenue account
                    <select aria-label={`Line ${index + 1} revenue account`} value={line.accountId} aria-invalid={Boolean(errors[`lines.${index}.accountId`])} onChange={(event) => updateLine(index, 'accountId', event.target.value)}>
                      <option value="">Select account</option>
                      {accounts.data.filter((account) => account.isActive && account.type === 'REVENUE').map((account) => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}
                    </select>
                    {errors[`lines.${index}.accountId`] && <span className="field-error" role="alert">{errors[`lines.${index}.accountId`]}</span>}
                  </label>
                  <label>Quantity
                    <input aria-label={`Line ${index + 1} quantity`} type="number" min="0.0001" step="0.0001" value={line.quantity} aria-invalid={Boolean(errors[`lines.${index}.quantity`])} onChange={(event) => updateLine(index, 'quantity', event.target.value)} />
                    {errors[`lines.${index}.quantity`] && <span className="field-error" role="alert">{errors[`lines.${index}.quantity`]}</span>}
                  </label>
                  <label>Unit price
                    <input aria-label={`Line ${index + 1} unit price`} type="number" min="0" step="0.01" value={line.unitPrice} aria-invalid={Boolean(errors[`lines.${index}.unitPrice`])} onChange={(event) => updateLine(index, 'unitPrice', event.target.value)} />
                    {errors[`lines.${index}.unitPrice`] && <span className="field-error" role="alert">{errors[`lines.${index}.unitPrice`]}</span>}
                  </label>
                  <label>Discount %
                    <input aria-label={`Line ${index + 1} discount`} type="number" min="0" max="100" step="0.01" value={line.discountPct} aria-invalid={Boolean(errors[`lines.${index}.discountPct`])} onChange={(event) => updateLine(index, 'discountPct', event.target.value)} />
                    {errors[`lines.${index}.discountPct`] && <span className="field-error" role="alert">{errors[`lines.${index}.discountPct`]}</span>}
                  </label>
                  <label>VAT
                    <select aria-label={`Line ${index + 1} VAT`} value={line.taxCodeId} onChange={(event) => updateLine(index, 'taxCodeId', event.target.value)}>
                      <option value="">No VAT</option>
                      {taxCodes.data.map((tax) => <option key={tax.id} value={tax.id}>{tax.name}</option>)}
                    </select>
                  </label>
                  <button className="line-remove" type="button" disabled={form.lines.length === 1} aria-label={`Remove line ${index + 1}`} onClick={() => removeLine(index)}>Remove</button>
                </fieldset>
              ))}
            </div>
          </section>
        </div>

        <div className="invoice-form-aside">
          <InvoiceTotals preview={previewEligible ? preview : null} error={previewEligible ? previewError : null} pending={previewEligible && previewPending} />
          <button className="primary-button save-invoice" type="submit" disabled={saveInvoice.isPending}>{saveInvoice.isPending ? 'Saving…' : 'Save draft'}</button>
        </div>
      </form>
    </div>
  );
}
```

Important concepts:

- A dynamic array of line objects supports adding and removing invoice rows.
- `setForm(current => ...)` uses the latest state value and returns a replacement object.
- A closure lets a line-update callback remember which row and field it is editing.
- `useEffect` schedules preview work when form inputs change.
- Debouncing waits briefly before sending a preview request, reducing requests while a user is still typing.
- Cleanup cancels an older timer so only the newest form state is previewed.
- `useMutation` models a save action.
- The server response, not locally multiplied values, supplies displayed totals.
- Disabled states prevent saving while required reference data is unavailable or a mutation is pending.

Function flow for preview:

- **Data in:** customer/date/line form state.
- **Processing:** validate enough structure for preview, wait for the debounce interval, send normalized payload to `POST /invoices/preview`.
- **Data out:** server-computed lines, subtotal, taxable amount, VAT, and grand total.
- **Who calls it:** the effect reacts to form changes.
- **What it calls:** form helper and API client.

Runtime:

1. The user selects a customer and edits a line.
2. React updates local form state.
3. The existing preview timer is cleared.
4. After the quiet period, the browser sends raw input fields to the preview endpoint.
5. The backend parses decimal strings, applies tax and rounding rules, and returns totals.
6. React stores the preview response.
7. The totals panel renders the authoritative values through `Money`.
8. Saving sends the same input shape to create/update.
9. The backend recomputes again rather than trusting the earlier preview.

### File: `frontend/src/pages/InvoiceDetailPage.jsx`

**Status:** Created

**Purpose:** Shows an invoice’s business meaning and its accounting effect together.

**Why does this file exist?** A reviewer should see that posting an invoice creates a balanced journal rather than merely changing an invoice status.

**How does it connect to other files?** It loads the invoice and linked journal entry, reads organization permissions, uses a confirmation dialog, posts through the API, and invalidates invoices, journal entries, and Trial Balance queries.

```jsx
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { AsyncState } from '../components/AsyncState.jsx';
import { Money } from '../components/Money.jsx';
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
  if (loadError) return <AsyncState title="Invoice unavailable" message={loadError.message} />;

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
          <AsyncState title="Journal unavailable" message={journal.error.message} />
        ) : <JournalPanel journal={displayedJournal} accountNames={accountNames} />}
      </div>

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
```

Important concepts:

- Authorization-aware UI checks whether the active organization contains `invoice.post`.
- This check hides/disables an unavailable action, but the backend repeats authorization.
- A confirmation dialog makes an irreversible financial transition deliberate.
- Posting is a mutation with cache invalidation because several views depend on its result.
- Debit and credit columns remain separate. Equal totals express double-entry balance.
- Conditional rendering uses logical `&&` and ternary expressions to show the correct state.

Function flow for posting:

- **Data in:** invoice ID and a confirmed click.
- **Processing:** POST to the document-post endpoint, close confirmation state, refresh related queries.
- **Data out:** a posted invoice plus journal entry visible on screen.
- **Who calls it:** the confirmation action.
- **What it calls:** `apiRequest`, query invalidation, and toast notification.

Runtime:

1. User with `invoice.post` opens a draft.
2. User clicks Post and confirms.
3. Express authenticates, resolves tenant, and checks permission.
4. Backend locks and validates the draft.
5. Posting rules create journal lines inside one database transaction.
6. Balance is checked before commit.
7. Response returns.
8. Frontend refreshes document, journal, invoice list, and Trial Balance caches.
9. The journal panel shows equal debit and credit totals.

### File: `frontend/src/pages/TrialBalancePage.jsx`

**Status:** Created

```jsx
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { AsyncState } from '../components/AsyncState.jsx';
import { Money } from '../components/Money.jsx';
import { apiRequest } from '../lib/api-client.js';

function reportPath({ from, asOf }) {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (asOf) params.set('asOf', asOf);
  const query = params.toString();
  return `/reports/trial-balance${query ? `?${query}` : ''}`;
}

export function TrialBalancePage() {
  const { activeOrganizationId } = useOutletContext();
  const [dates, setDates] = useState({ from: '', asOf: '' });
  const report = useQuery({
    queryKey: ['trial-balance', activeOrganizationId, dates],
    queryFn: () => apiRequest(reportPath(dates)),
    enabled: Boolean(activeOrganizationId),
  });

  function updateDate(field, value) {
    setDates((current) => ({ ...current, [field]: value }));
  }

  return (
    <div className="accounting-page trial-balance-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Ledger report</p>
          <h1>Trial Balance</h1>
          <p>Every posted debit and credit grouped by account, with an integrity check.</p>
        </div>
        {report.data && (
          <div className={`report-integrity ${report.data.integrity.balanced ? 'balance-ok' : 'balance-error'}`} role="status">
            <span aria-hidden="true">{report.data.integrity.balanced ? '✓' : '!'}</span>
            <div><strong>{report.data.integrity.balanced ? 'Balanced — zero difference' : 'Difference detected'}</strong><small>Through {report.data.asOf}</small></div>
          </div>
        )}
      </div>

      <section className="filter-bar report-filter" aria-label="Trial Balance dates">
        <label>From
          <input type="date" aria-label="Trial Balance from" value={dates.from} onChange={(event) => updateDate('from', event.target.value)} />
        </label>
        <label>As of
          <input type="date" aria-label="Trial Balance as of" min={dates.from || undefined} value={dates.asOf} onChange={(event) => updateDate('asOf', event.target.value)} />
        </label>
        <span>Only posted journal entries are included.</span>
      </section>

      {!activeOrganizationId || report.isPending ? (
        <AsyncState title="Building Trial Balance" message="Summing posted debits and credits by account." />
      ) : report.isError ? (
        <AsyncState title="Trial Balance unavailable" message={report.error.message} />
      ) : report.data.rows.length === 0 ? (
        <AsyncState title="No posted balances" message="Post an invoice or choose a wider date range." />
      ) : (
        <div className="report-surface">
          <div className="table-scroll">
            <table className="data-table report-table">
              <thead><tr><th scope="col">Code</th><th scope="col">Account</th><th scope="col">Type</th><th className="numeric" scope="col">Total debit</th><th className="numeric" scope="col">Total credit</th><th className="numeric" scope="col">Debit balance</th><th className="numeric" scope="col">Credit balance</th></tr></thead>
              <tbody>{report.data.rows.map((row) => <tr key={row.code}><td>{row.code}</td><td>{row.name}</td><td><span className="account-type">{row.type}</span></td><td className="numeric"><Money value={row.totalDebit} /></td><td className="numeric"><Money value={row.totalCredit} /></td><td className="numeric"><Money value={row.debitBalance} /></td><td className="numeric"><Money value={row.creditBalance} /></td></tr>)}</tbody>
              <tfoot><tr><th colSpan="3" scope="row">Posted totals</th><td className="numeric"><Money value={report.data.totals.debit} /></td><td className="numeric"><Money value={report.data.totals.credit} /></td><td colSpan="2" className="numeric">Difference <Money value={report.data.integrity.difference} /></td></tr></tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
```

**Purpose:** Displays account balances derived from posted journal lines.

**Why does this file exist?** A Trial Balance is the fastest visible integrity check for double-entry accounting: total debit balances must equal total credit balances.

**How does it connect to other files?** It calls `GET /reports/trial-balance`, renders decimal strings through `Money`, and links the report state to the active organization.
 
Important concepts:

- A report query reads derived data; it does not maintain a second set of totals.
- Semantic table headings help screen readers understand numeric columns.
- Right-aligned tabular figures make digit positions visually comparable.
- The balanced indicator is based on server report totals, not an animation-only claim.

Data flow:

- **Data in:** active organization and optional reporting date.
- **Processing:** request ledger aggregation and render each account.
- **Data out:** debit/credit balances plus equal totals.
- **Who calls it:** React Router.
- **What it calls:** TanStack Query, API client, `Money`, and `AsyncState`.

## 5. Complete request and runtime flows

### Draft preview

```text
InvoiceEditorPage line inputs
  → toInvoicePayload()
    → POST /invoices/preview
      → server validation
      → decimal arithmetic
      → 13% VAT rules
      → rounding boundary
        → preview JSON strings
          → Money components
```

### Save draft

```text
InvoiceEditorPage
  → validateInvoiceForm()
    → POST /invoices or PATCH /invoices/:id
      → authentication
      → tenant resolution
      → permission
      → backend recomputation
      → Prisma document + lines
        → response
          → navigate to invoice detail
```

### Post invoice

```text
InvoiceDetailPage confirmation
  → POST /invoices/:id/post
    → middleware chain
    → postDocument()
      → period check
      → status/version guards
      → locked document numbering
      → invoice posting rule
      → debit/credit balance assertion
      → one PostgreSQL transaction
        → posted invoice + journal
          → frontend cache invalidation
            → side-by-side journal panel
            → updated Trial Balance
```

## 6. New concepts introduced

- **Invoice draft:** Editable commercial document not yet committed to the ledger.
- **Posting:** Converting an approved document into an accounting entry.
- **Journal entry:** A dated, balanced collection of debit and credit lines.
- **Double-entry accounting:** Every financial event affects at least two accounts and total debits equal total credits.
- **Debit and credit:** The two sides of a journal entry; their effect depends on the account type.
- **Trial Balance:** A list of account balances proving total debits and credits agree.
- **Server preview:** A non-posting API calculation that returns authoritative totals before save.
- **VAT:** Value Added Tax. The demo uses the configured 13% tax code.
- **Debounce:** Delaying an action until rapid input changes stop.
- **Permission-gated action:** A control shown only when the active membership grants the required permission.
- **Database transaction:** A group of writes that either all commit or all roll back.
- **Cache invalidation:** Telling cached reads they may be outdated after posting.

## 7. Errors and debugging

### Problem: calculating invoice totals in two places

**What could go wrong:** A frontend multiplication/rounding implementation could disagree with the posting engine by one paisa.

**Root cause:** Two independent accounting calculations inevitably drift when tax or rounding rules change.

**Diagnosis:** The plan explicitly required `POST /invoices/preview`, and the editor was structured around the response.

**Fix:** The browser collects inputs and displays the server preview. The backend recomputes again during save/post.

**Lesson:** In financial software, a single calculation authority is safer than duplicated convenience logic.

### Problem: posting changes several screens

**What could go wrong:** The invoice detail could say “posted” while the list or Trial Balance still displayed cached pre-post data.

**Fix:** The posting success handler invalidates every affected query family.

**Lesson:** Identify all read models influenced by a mutation, not only the page where the button lives.

No preserved Day 3 terminal error message proves another specific failure, so this report distinguishes designed safeguards from observed errors.

## 8. Final understanding check

### On what we built

1. Why does the editor use dynamic line rows?
2. Why are totals returned by a preview endpoint?
3. What does the journal panel prove that an invoice status cannot prove?

### On security and integrity

1. Why does the backend check `invoice.post` even when the button is hidden?
2. Why must posting run inside one transaction?
3. What would happen if a draft could be edited after posting?

### On architecture

1. Why is `invoice-form.js` separate from the React page?
2. Which caches must change after posting, and why?
3. Why does the Trial Balance query the ledger rather than invoice totals?

### On request lifecycle

1. Trace a line edit from keystroke to displayed VAT.
2. Trace the Post button from confirmation to journal display.
3. Where is the final debit-equals-credit decision made?

### On debugging

1. What symptom would indicate stale query data after posting?
2. Why can client validation not prove a financial document is safe?
3. How does debouncing reduce work without changing the calculation result?

## 9. Verification and deferred work

Day 3 added focused page tests and pure form-helper tests. Backend contract and invoice tests were also updated so the browser paths matched real endpoints.

Deferred:

- Cash receipt allocation, payment history, AR Aging, General Ledger drill-down, and dashboard KPIs moved to Day 4.
- Statement upload, reconciliation, P&L, Balance Sheet, reconciliation summary, and CSV export moved to Day 5.
- Audit viewing, global accessibility polish, mobile reconciliation tabs, and reproducible demo seeding moved to Day 6.

