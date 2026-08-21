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
  const { activeOrganizationId, activeOrganization } = useOutletContext();
  const { notify } = useToast();
  const canCreate = Boolean(activeOrganization?.permissions?.includes('invoice.create'));
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
  if (selectorError) return <AsyncState tone="error" title="Invoice editor unavailable" message={selectorError.message} />;

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
          <button className="primary-button save-invoice" type="submit" disabled={!canCreate || saveInvoice.isPending}>{saveInvoice.isPending ? 'Saving…' : 'Save draft'}</button>
          {!canCreate && <p className="muted-copy">Invoice creation permission is required.</p>}
        </div>
      </form>
    </div>
  );
}
