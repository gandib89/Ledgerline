import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { AsyncState } from '../components/AsyncState.jsx';
import { Money } from '../components/Money.jsx';
import { useToast } from '../components/toast-context.js';
import { apiRequest } from '../lib/api-client.js';

function calculateLine(line, taxCodes) {
  const base = Number(line.quantity || 0) * Number(line.unitPrice || 0);
  const taxable = base * (1 - Number(line.discountPct || 0) / 100);
  const tax = taxable * Number(taxCodes.find(({ id }) => id === line.taxCodeId)?.rate ?? 0);
  return { taxable, tax, total: taxable + tax };
}

export function CreditNotePage() {
  const { invoiceId } = useParams();
  const navigate = useNavigate();
  const { activeOrganizationId, activeOrganization } = useOutletContext();
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const [form, setForm] = useState({ docDate: '', referenceNo: '', notes: '', lines: null });
  const [formError, setFormError] = useState('');
  const invoice = useQuery({ queryKey: ['invoice', activeOrganizationId, invoiceId], queryFn: () => apiRequest(`/invoices/${invoiceId}`), enabled: Boolean(activeOrganizationId && invoiceId) });
  const parties = useQuery({ queryKey: ['parties', activeOrganizationId, 'credit-note'], queryFn: () => apiRequest('/parties?page=1'), enabled: Boolean(activeOrganizationId) });
  const accounts = useQuery({ queryKey: ['accounts', activeOrganizationId], queryFn: () => apiRequest('/accounts'), enabled: Boolean(activeOrganizationId) });
  const taxCodes = useQuery({ queryKey: ['tax-codes', activeOrganizationId], queryFn: () => apiRequest('/tax-codes'), enabled: Boolean(activeOrganizationId) });

  const defaultLines = (invoice.data?.lines ?? []).map((line) => ({
    accountId: line.accountId, description: line.description, quantity: line.quantity,
    unitPrice: line.unitPrice, discountPct: line.discountPct ?? '0', taxCodeId: line.taxCodeId ?? '',
  }));
  const lines = form.lines ?? defaultLines;

  const totals = lines.reduce((total, line) => {
    const current = calculateLine(line, taxCodes.data ?? []);
    return { taxable: total.taxable + current.taxable, tax: total.tax + current.tax, grand: total.grand + current.total };
  }, { taxable: 0, tax: 0, grand: 0 });

  const createCredit = useMutation({
    mutationFn: (body) => apiRequest('/credit-notes', { method: 'POST', body }),
    onSuccess: async ({ creditNote }) => {
      queryClient.setQueryData(['credit-note', activeOrganizationId, creditNote.id], creditNote);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['invoice', activeOrganizationId, invoiceId] }),
        queryClient.invalidateQueries({ queryKey: ['invoices'] }),
        queryClient.invalidateQueries({ queryKey: ['journal-entries'] }),
      ]);
      notify({ title: 'Credit note posted', message: `${creditNote.docNo} reduced the invoice balance.`, tone: 'success' });
      navigate(`/credit-notes/${creditNote.id}`);
    },
    onError: (error) => notify({ title: 'Could not issue credit note', message: error.message, tone: 'error' }),
  });

  function updateLine(index, name, value) {
    setForm((current) => ({ ...current, lines: (current.lines ?? defaultLines).map((line, lineIndex) => lineIndex === index ? { ...line, [name]: value } : line) }));
    setFormError('');
  }

  function submit(event) {
    event.preventDefault();
    if (!form.docDate || lines.length === 0 || lines.some((line) => !line.accountId || !line.description || Number(line.quantity) <= 0)) {
      setFormError('A date and at least one valid credit line are required.');
      return;
    }
    createCredit.mutate({
      invoiceId, docDate: form.docDate, referenceNo: form.referenceNo, notes: form.notes,
      lines: lines.map((line) => ({
        accountId: line.accountId, description: line.description, quantity: line.quantity,
        unitPrice: line.unitPrice, discountPct: line.discountPct,
        ...(line.taxCodeId ? { taxCodeId: line.taxCodeId } : {}),
      })),
    });
  }

  const loadError = invoice.error ?? parties.error ?? accounts.error ?? taxCodes.error;
  if (!activeOrganizationId || invoice.isPending || parties.isPending || accounts.isPending || taxCodes.isPending) return <AsyncState title="Loading credit note" message="Fetching the posted invoice and tax setup." />;
  if (loadError) return <AsyncState tone="error" title="Credit note unavailable" message={loadError.message} />;
  const customer = parties.data.find(({ id }) => id === invoice.data.partyId);
  const canPost = activeOrganization?.permissions?.includes('invoice.post') ?? false;
  if (!['posted', 'partially_paid', 'paid'].includes(invoice.data.status)) return <AsyncState tone="empty" title="Credit note not available" message="Only posted invoices can be corrected with a credit note." />;

  return (
    <div className="accounting-page credit-note-page">
      <div className="page-heading"><div><p className="eyebrow">Sales correction</p><h1>Issue credit note</h1><p>Reduce {invoice.data.docNo} for {customer?.name ?? 'this customer'} without deleting its original ledger history.</p></div><Link className="secondary-button button-link" to={`/invoices/${invoiceId}`}>Cancel</Link></div>
      <form className="report-surface credit-note-form" onSubmit={submit} noValidate>
        <div className="inline-form credit-note-meta">
          <label>Credit note date<input type="date" value={form.docDate} onChange={(event) => setForm((current) => ({ ...current, docDate: event.target.value }))} /></label>
          <label>Reference<input value={form.referenceNo} onChange={(event) => setForm((current) => ({ ...current, referenceNo: event.target.value }))} /></label>
          <label>Notes<input value={form.notes} onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} /></label>
        </div>
        <div className="table-scroll"><table className="data-table credit-line-table"><thead><tr><th>Description</th><th>Revenue account</th><th>Tax</th><th className="numeric">Quantity</th><th className="numeric">Unit price</th><th className="numeric">Discount %</th><th className="numeric">Credit total</th></tr></thead><tbody>{lines.map((line, index) => { const calculated = calculateLine(line, taxCodes.data); return <tr key={index}>
          <td><input aria-label={`Line ${index + 1} description`} value={line.description} onChange={(event) => updateLine(index, 'description', event.target.value)} /></td>
          <td><select aria-label={`Line ${index + 1} account`} value={line.accountId} onChange={(event) => updateLine(index, 'accountId', event.target.value)}>{accounts.data.map((account) => <option value={account.id} key={account.id}>{account.code} · {account.name}</option>)}</select></td>
          <td><select aria-label={`Line ${index + 1} tax code`} value={line.taxCodeId} onChange={(event) => updateLine(index, 'taxCodeId', event.target.value)}><option value="">No tax</option>{taxCodes.data.map((tax) => <option value={tax.id} key={tax.id}>{tax.code}</option>)}</select></td>
          <td><input aria-label={`Line ${index + 1} quantity`} inputMode="decimal" value={line.quantity} onChange={(event) => updateLine(index, 'quantity', event.target.value)} /></td>
          <td><input aria-label={`Line ${index + 1} unit price`} inputMode="decimal" value={line.unitPrice} onChange={(event) => updateLine(index, 'unitPrice', event.target.value)} /></td>
          <td><input aria-label={`Line ${index + 1} discount`} inputMode="decimal" value={line.discountPct} onChange={(event) => updateLine(index, 'discountPct', event.target.value)} /></td>
          <td className="numeric"><Money value={calculated.total.toFixed(2)} /></td>
        </tr>; })}</tbody></table></div>
        <div className="credit-note-footer"><dl className="document-totals"><div><dt>Taxable credit</dt><dd><Money value={totals.taxable.toFixed(2)} /></dd></div><div><dt>VAT reversal</dt><dd><Money value={totals.tax.toFixed(2)} /></dd></div><div className="grand-total"><dt>Total credit</dt><dd><Money value={totals.grand.toFixed(2)} /></dd></div></dl><button className="primary-button" type="submit" disabled={!canPost || createCredit.isPending}>{createCredit.isPending ? 'Posting credit note…' : 'Post credit note'}</button></div>
        {formError && <div className="form-alert" role="alert">{formError}</div>}
        {!canPost && <p className="muted-copy">Invoice posting permission is required.</p>}
      </form>
    </div>
  );
}
