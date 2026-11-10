import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { AsyncState } from '../components/AsyncState.jsx';
import { useToast } from '../components/toast-context.js';
import { apiRequest } from '../lib/api-client.js';
import {
  billFormSchema,
  billInput,
  billLineInputs,
  billLinesSchema,
  billValidationErrors,
  emptyBillLine,
} from './bill-form.js';
import { InvoiceTotals } from './InvoiceEditorPage.jsx';

function newBillForm() {
  return {
    partyId: '',
    referenceNo: '',
    docDate: '',
    postingDate: '',
    dueDate: '',
    notes: '',
    lines: [emptyBillLine()],
  };
}

function formFromBill(bill) {
  return {
    partyId: bill.partyId,
    referenceNo: bill.referenceNo ?? '',
    docDate: bill.docDate,
    // Blank means "same as the bill date", so changing the bill date carries it along.
    postingDate: bill.postingDate === bill.docDate ? '' : bill.postingDate,
    dueDate: bill.dueDate ?? '',
    notes: bill.notes ?? '',
    version: bill.version,
    lines: bill.lines.map((line) => ({
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

// A Bill line may only use expense or asset accounts that are neither control nor bank accounts.
const isBillAccount = (account) => account.isActive && !account.isControlAccount && !account.isBankAccount;

export function BillEditorPage() {
  const { id } = useParams();
  const editing = Boolean(id);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { activeOrganizationId, activeOrganization } = useOutletContext();
  const { notify } = useToast();
  const canCreate = Boolean(activeOrganization?.permissions?.includes('bill.create'));
  const initializedBill = useRef(null);
  const [form, setForm] = useState(newBillForm);
  const [errors, setErrors] = useState({});
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [previewPending, setPreviewPending] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [duplicate, setDuplicate] = useState(null);

  const suppliers = useQuery({
    queryKey: ['parties', activeOrganizationId, 'bill-supplier-selector'],
    queryFn: () => apiRequest('/parties?type=supplier&page=1'),
    enabled: Boolean(activeOrganizationId),
  });
  const expenseAccounts = useQuery({
    queryKey: ['accounts', activeOrganizationId, 'EXPENSE'],
    queryFn: () => apiRequest('/accounts?type=EXPENSE'),
    enabled: Boolean(activeOrganizationId),
  });
  const assetAccounts = useQuery({
    queryKey: ['accounts', activeOrganizationId, 'ASSET'],
    queryFn: () => apiRequest('/accounts?type=ASSET'),
    enabled: Boolean(activeOrganizationId),
  });
  const taxCodes = useQuery({
    queryKey: ['tax-codes', activeOrganizationId],
    queryFn: () => apiRequest('/tax-codes'),
    enabled: Boolean(activeOrganizationId),
  });
  const bill = useQuery({
    queryKey: ['bill', activeOrganizationId, id],
    queryFn: () => apiRequest(`/bills/${id}`),
    enabled: Boolean(activeOrganizationId && id),
  });

  useEffect(() => {
    if (!bill.data || initializedBill.current === bill.data) return;
    initializedBill.current = bill.data;
    setForm(formFromBill(bill.data));
    setConflict(false);
  }, [bill.data]);

  useEffect(() => {
    const parsed = billLinesSchema.safeParse(form.lines);
    if (!parsed.success) return undefined;

    let cancelled = false;
    const timer = globalThis.setTimeout(async () => {
      setPreviewPending(true);
      setPreviewError(null);
      try {
        const result = await apiRequest('/bills/preview', { method: 'POST', body: { lines: billLineInputs(parsed.data) } });
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

  const saveBill = useMutation({
    mutationFn: (input) => apiRequest(editing ? `/bills/${id}` : '/bills', {
      method: editing ? 'PATCH' : 'POST',
      body: input,
    }),
    onSuccess: async (saved) => {
      queryClient.setQueryData(['bill', activeOrganizationId, saved.id], saved);
      await queryClient.invalidateQueries({ queryKey: ['bills'] });
      notify({ title: editing ? 'Draft updated' : 'Draft created', message: 'The bill is ready for review.', tone: 'success' });
      navigate(`/bills/${saved.id}`);
    },
    onError: (error) => {
      if (error.status === 409 && error.code === 'version_conflict') {
        setConflict(true);
        return;
      }
      if (error.status === 409 && error.code === 'duplicate_supplier_reference' && error.details?.billId) {
        setDuplicate(error.details);
        return;
      }
      notify({ title: 'Could not save bill', message: error.message, tone: 'error' });
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
    setForm((current) => ({ ...current, lines: [...current.lines, emptyBillLine()] }));
  }

  function removeLine(index) {
    if (form.lines.length === 1) return;
    setForm((current) => ({ ...current, lines: current.lines.filter((_, lineIndex) => lineIndex !== index) }));
  }

  function submit(event) {
    event.preventDefault();
    const parsed = billFormSchema.safeParse(form);
    setErrors(billValidationErrors(parsed));
    if (!parsed.success) return;
    setConflict(false);
    setDuplicate(null);
    saveBill.mutate(billInput(parsed.data));
  }

  const selectorsPending = suppliers.isPending || expenseAccounts.isPending || assetAccounts.isPending || taxCodes.isPending || (editing && bill.isPending);
  const selectorError = suppliers.error ?? expenseAccounts.error ?? assetAccounts.error ?? taxCodes.error ?? bill.error;
  const previewEligible = billLinesSchema.safeParse(form.lines).success;

  if (selectorsPending) return <AsyncState title="Preparing bill editor" message="Loading suppliers, expense and asset accounts, and VAT codes." />;
  if (selectorError) return <AsyncState tone="error" title="Bill editor unavailable" message={selectorError.message} />;

  const billAccounts = [...expenseAccounts.data, ...assetAccounts.data].filter(isBillAccount);

  return (
    <div className="accounting-page invoice-editor-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{editing ? 'Edit draft' : 'New purchase document'}</p>
          <h1>{editing ? 'Edit bill' : 'Enter bill'}</h1>
          <p>Copy the Supplier&apos;s invoice; LedgerLine will calculate VAT and accounting totals.</p>
        </div>
        <Link className="secondary-button button-link" to={editing ? `/bills/${id}` : '/bills'}>Cancel</Link>
      </div>

      {conflict && (
        <div className="conflict-banner" role="alert">
          <div><strong>This bill changed in another session.</strong><p>Reload the latest version before making more changes.</p></div>
          <button className="secondary-button" type="button" onClick={() => bill.refetch()}>Reload bill</button>
        </div>
      )}

      {duplicate && (
        <div className="conflict-banner" role="alert" aria-label="Bill already saved">
          <div>
            <strong>This Supplier invoice is already saved.</strong>
            <p>Bill {duplicate.referenceNo} already exists for this Supplier. Open it to review or edit instead of entering it again.</p>
          </div>
          <Link className="secondary-button button-link" to={`/bills/${duplicate.billId}`}>Open existing bill</Link>
        </div>
      )}

      <form className="invoice-editor-layout" onSubmit={submit} noValidate>
        <div className="invoice-form-main">
          <section className="form-panel" aria-labelledby="bill-details-title">
            <div className="section-heading"><div><p className="step-label">01</p><h2 id="bill-details-title">Bill details</h2></div><span>Amounts in NPR</span></div>
            <div className="field-grid">
              <label>Supplier
                <select aria-invalid={Boolean(errors.partyId)} value={form.partyId} onChange={(event) => updateField('partyId', event.target.value)}>
                  <option value="">Select supplier</option>
                  {suppliers.data.filter((party) => party.isActive).map((party) => <option key={party.id} value={party.id}>{party.code} · {party.name}</option>)}
                </select>
                {errors.partyId && <span className="field-error" role="alert">{errors.partyId}</span>}
              </label>
              <label>Supplier reference
                <input value={form.referenceNo} aria-invalid={Boolean(errors.referenceNo)} onChange={(event) => updateField('referenceNo', event.target.value)} placeholder="Number printed on the Supplier's invoice" />
                {errors.referenceNo && <span className="field-error" role="alert">{errors.referenceNo}</span>}
              </label>
              <label>Bill date
                <input type="date" value={form.docDate} aria-invalid={Boolean(errors.docDate)} onChange={(event) => updateField('docDate', event.target.value)} />
                {errors.docDate && <span className="field-error" role="alert">{errors.docDate}</span>}
              </label>
              <label>Posting date
                <input aria-label="Posting date" type="date" min={form.docDate || undefined} value={form.postingDate} aria-invalid={Boolean(errors.postingDate)} onChange={(event) => updateField('postingDate', event.target.value)} />
                <small>Leave blank to post on the bill date. Choose a later date if the bill date&apos;s period is locked.</small>
                {errors.postingDate && <span className="field-error" role="alert">{errors.postingDate}</span>}
              </label>
              <label>Due date
                <input aria-label="Due date" type="date" min={form.docDate || undefined} value={form.dueDate} aria-invalid={Boolean(errors.dueDate)} onChange={(event) => updateField('dueDate', event.target.value)} />
                <small>Leave blank to use the Supplier&apos;s credit days.</small>
                {errors.dueDate && <span className="field-error" role="alert">{errors.dueDate}</span>}
              </label>
            </div>
            <label className="wide-field">Notes
              <textarea value={form.notes} onChange={(event) => updateField('notes', event.target.value)} rows="3" placeholder="Optional internal note" />
            </label>
          </section>

          <section className="form-panel" aria-labelledby="bill-lines-title">
            <div className="section-heading"><div><p className="step-label">02</p><h2 id="bill-lines-title">Bill lines</h2></div><button className="secondary-button compact" type="button" onClick={addLine}>Add line</button></div>
            <div className="invoice-lines">
              {form.lines.map((line, index) => (
                <fieldset className="invoice-line" key={line.clientId}>
                  <legend>Line {index + 1}</legend>
                  <label className="line-description">Description
                    <input aria-label={`Line ${index + 1} description`} value={line.description} aria-invalid={Boolean(errors[`lines.${index}.description`])} onChange={(event) => updateLine(index, 'description', event.target.value)} />
                    {errors[`lines.${index}.description`] && <span className="field-error" role="alert">{errors[`lines.${index}.description`]}</span>}
                  </label>
                  <label className="line-account">Account
                    <select aria-label={`Line ${index + 1} account`} value={line.accountId} aria-invalid={Boolean(errors[`lines.${index}.accountId`])} onChange={(event) => updateLine(index, 'accountId', event.target.value)}>
                      <option value="">Select account</option>
                      {billAccounts.map((account) => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}
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
          <InvoiceTotals title="Bill totals" preview={previewEligible ? preview : null} error={previewEligible ? previewError : null} pending={previewEligible && previewPending} />
          {canCreate && <button className="primary-button save-invoice" type="submit" disabled={saveBill.isPending}>{saveBill.isPending ? 'Saving…' : 'Save draft'}</button>}
          {!canCreate && <p className="muted-copy">Bill creation permission is required.</p>}
        </div>
      </form>
    </div>
  );
}
