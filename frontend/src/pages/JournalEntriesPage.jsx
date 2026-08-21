import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import { AsyncState } from '../components/AsyncState.jsx';
import { Money } from '../components/Money.jsx';
import { useToast } from '../components/toast-context.js';
import { apiRequest } from '../lib/api-client.js';
import { fromCents, toCents } from '../lib/amount.js';

const blankLine = () => ({ accountId: '', debit: '', credit: '', description: '' });

function lineTotal(lines, side) {
  try {
    return fromCents(lines.reduce((sum, line) => sum + toCents(line[side] || '0'), 0n));
  } catch {
    return '0.00';
  }
}

export function JournalEntriesPage() {
  const { activeOrganizationId, activeOrganization } = useOutletContext();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const [selectedId, setSelectedId] = useState(searchParams.get('entry') ?? '');
  const [form, setForm] = useState({ entryDate: '', narration: '', lines: [blankLine(), blankLine()] });
  const [reverseForm, setReverseForm] = useState({ reason: '', reversalDate: '' });
  const [formError, setFormError] = useState('');
  const [reversed, setReversed] = useState(false);
  const canPost = activeOrganization?.permissions?.includes('journal.post') ?? false;

  const entries = useQuery({
    queryKey: ['journal-entries', activeOrganizationId],
    queryFn: () => apiRequest('/journal-entries?page=1'),
    enabled: Boolean(activeOrganizationId),
  });
  const accounts = useQuery({
    queryKey: ['accounts', activeOrganizationId],
    queryFn: () => apiRequest('/accounts'),
    enabled: Boolean(activeOrganizationId),
  });
  const detail = useQuery({
    queryKey: ['journal-entry', activeOrganizationId, selectedId],
    queryFn: () => apiRequest(`/journal-entries/${selectedId}`),
    enabled: Boolean(activeOrganizationId && selectedId),
  });

  const debitTotal = useMemo(() => lineTotal(form.lines, 'debit'), [form.lines]);
  const creditTotal = useMemo(() => lineTotal(form.lines, 'credit'), [form.lines]);
  const balanced = debitTotal === creditTotal && debitTotal !== '0.00';

  const postJournal = useMutation({
    mutationFn: (body) => apiRequest('/journal-entries', { method: 'POST', body }),
    onSuccess: async (entry) => {
      queryClient.setQueryData(['journal-entry', activeOrganizationId, entry.id], entry);
      setSelectedId(entry.id);
      setForm({ entryDate: '', narration: '', lines: [blankLine(), blankLine()] });
      await queryClient.invalidateQueries({ queryKey: ['journal-entries'] });
      notify({ title: 'Journal posted', message: entry.entryNumber, tone: 'success' });
    },
    onError: (error) => notify({ title: 'Could not post journal', message: error.message, tone: 'error' }),
  });
  const reverseJournal = useMutation({
    mutationFn: ({ id, body }) => apiRequest(`/journal-entries/${id}/reverse`, { method: 'POST', body }),
    onSuccess: async ({ original, reversal }) => {
      queryClient.setQueryData(['journal-entry', activeOrganizationId, original.id], original);
      queryClient.setQueryData(['journal-entry', activeOrganizationId, reversal.id], reversal);
      setReversed(true);
      setReverseForm({ reason: '', reversalDate: '' });
      await queryClient.invalidateQueries({ queryKey: ['journal-entries'] });
      notify({ title: 'Reversal posted', message: `Offsetting entry ${reversal.entryNumber} was posted.`, tone: 'success' });
    },
    onError: (error) => notify({ title: 'Could not reverse entry', message: error.message, tone: 'error' }),
  });

  function updateLine(index, field, value) {
    setForm((current) => ({ ...current, lines: current.lines.map((line, lineIndex) => lineIndex === index ? { ...line, [field]: value } : line) }));
    setFormError('');
  }

  function submit(event) {
    event.preventDefault();
    if (!form.entryDate || !form.narration || form.lines.some((line) => !line.accountId)) {
      setFormError('Date, narration, and an account on every line are required.');
      return;
    }
    if (!balanced) {
      setFormError('Debits and credits must be equal and greater than zero.');
      return;
    }
    postJournal.mutate({
      entryDate: form.entryDate,
      narration: form.narration,
      lines: form.lines.map((line) => ({ ...line, debit: line.debit || '0', credit: line.credit || '0' })),
    });
  }

  const loadError = entries.error ?? accounts.error;
  if (!activeOrganizationId || entries.isPending || accounts.isPending) return <AsyncState title="Loading journal workspace" message="Fetching journal entries and ledger accounts." />;
  if (loadError) return <AsyncState tone="error" title="Journal workspace unavailable" message={loadError.message} />;

  return (
    <div className="accounting-page journal-workspace">
      <div className="page-heading"><div><p className="eyebrow">Double-entry ledger</p><h1>Journal entries</h1><p>Inspect posted transactions, create balanced vouchers, and reverse mistakes with a complete trail.</p></div></div>

      <div className="journal-workspace-grid">
        <section className="report-surface journal-register">
          <div className="section-heading"><div><h2>Entry register</h2><p>The newest 20 ledger entries.</p></div></div>
          {entries.data.length === 0 ? <AsyncState tone="empty" title="No journal entries" message="Posted transactions will appear here." /> : (
            <div className="journal-entry-list">{entries.data.map((entry) => (
              <button key={entry.id} type="button" className={selectedId === entry.id ? 'selected' : ''} onClick={() => { setSelectedId(entry.id); setReversed(false); }}>
                <span><strong>{entry.entryNumber}</strong><small>{entry.description}</small></span>
                <span><small>{entry.entryDate}</small><b className={`status-pill status-${entry.status}`}>{entry.status}</b></span>
              </button>
            ))}</div>
          )}
        </section>

        <section className="report-surface journal-detail">
          {!selectedId ? <AsyncState tone="empty" title="Select an entry" message="Its debit and credit lines will appear here." />
            : detail.isPending ? <AsyncState title="Loading entry" message="Fetching posting lines." />
              : detail.isError ? <AsyncState tone="error" title="Entry unavailable" message={detail.error.message} /> : <>
                <div className="section-heading"><div><p className="eyebrow">{detail.data.documentType}</p><h2>{detail.data.entryNumber}</h2><p>{detail.data.entryDate} · {detail.data.description}</p></div><span className={`status-pill status-${detail.data.status}`}>{detail.data.status}</span></div>
                <div className="table-scroll"><table className="data-table"><thead><tr><th>Account</th><th>Description</th><th className="numeric">Debit</th><th className="numeric">Credit</th></tr></thead><tbody>{detail.data.lines?.map((line) => { const account = accounts.data.find(({ id }) => id === line.accountId); return <tr key={line.id ?? line.lineNumber}><td>{account ? `${account.code} · ${account.name}` : line.accountId}</td><td>{line.description || '—'}</td><td className="numeric"><Money value={line.debit} /></td><td className="numeric"><Money value={line.credit} /></td></tr>; })}</tbody></table></div>
                {canPost && detail.data.status === 'posted' && <form className="reversal-form" onSubmit={(event) => { event.preventDefault(); reverseJournal.mutate({ id: detail.data.id, body: { reason: reverseForm.reason, ...(reverseForm.reversalDate ? { reversalDate: reverseForm.reversalDate } : {}) } }); }}>
                  <label>Reversal reason<input required value={reverseForm.reason} onChange={(event) => setReverseForm((current) => ({ ...current, reason: event.target.value }))} /></label>
                  <label>Reversal date<input type="date" value={reverseForm.reversalDate} onChange={(event) => setReverseForm((current) => ({ ...current, reversalDate: event.target.value }))} /></label>
                  <button className="danger-button" type="submit" disabled={!reverseForm.reason || reverseJournal.isPending}>Reverse entry</button>
                </form>}
                {reversed && <div className="form-alert success-alert" role="status"><strong>Entry reversed</strong><span>An offsetting journal was posted; the original history remains intact.</span></div>}
              </>}
        </section>
      </div>

      <form className="report-surface manual-journal" onSubmit={submit} noValidate>
        <div className="section-heading"><div><h2>Manual journal voucher</h2><p>Use this for adjustments that are not created by invoices, receipts, or bank matching.</p></div></div>
        <div className="inline-form journal-header-fields">
          <label>Entry date<input type="date" value={form.entryDate} onChange={(event) => setForm((current) => ({ ...current, entryDate: event.target.value }))} /></label>
          <label>Narration<input value={form.narration} onChange={(event) => setForm((current) => ({ ...current, narration: event.target.value }))} /></label>
        </div>
        <div className="journal-line-editor">{form.lines.map((line, index) => <div className="journal-edit-line" key={index}>
          <label>Line {index + 1} account<select aria-label={`Line ${index + 1} account`} value={line.accountId} onChange={(event) => updateLine(index, 'accountId', event.target.value)}><option value="">Select account</option>{accounts.data.filter(({ isActive }) => isActive).map((account) => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}</select></label>
          <label>Description<input aria-label={`Line ${index + 1} description`} value={line.description} onChange={(event) => updateLine(index, 'description', event.target.value)} /></label>
          <label>Debit<input aria-label={`Line ${index + 1} debit`} inputMode="decimal" value={line.debit} onChange={(event) => updateLine(index, 'debit', event.target.value)} /></label>
          <label>Credit<input aria-label={`Line ${index + 1} credit`} inputMode="decimal" value={line.credit} onChange={(event) => updateLine(index, 'credit', event.target.value)} /></label>
          {form.lines.length > 2 && <button className="icon-button" aria-label={`Remove line ${index + 1}`} type="button" onClick={() => setForm((current) => ({ ...current, lines: current.lines.filter((_, lineIndex) => lineIndex !== index) }))}>×</button>}
        </div>)}</div>
        <button className="secondary-button compact" type="button" onClick={() => setForm((current) => ({ ...current, lines: [...current.lines, blankLine()] }))}>Add line</button>
        <div className="journal-form-footer"><div className={`balance-result ${balanced ? 'balance-ok' : 'balance-error'}`}><span>Debit <Money value={debitTotal} /></span><span>Credit <Money value={creditTotal} /></span><strong>{balanced ? 'Balanced' : 'Not balanced'}</strong></div><button className="primary-button" type="submit" disabled={!canPost || postJournal.isPending}>{postJournal.isPending ? 'Posting…' : 'Post journal'}</button></div>
        {formError && <div className="form-alert" role="alert">{formError}</div>}
        {!canPost && <p className="muted-copy">Journal posting permission is required.</p>}
      </form>
    </div>
  );
}
