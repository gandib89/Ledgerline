import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { AsyncState } from '../components/AsyncState.jsx';
import { Money } from '../components/Money.jsx';
import { useToast } from '../components/toast-context.js';
import { apiRequest } from '../lib/api-client.js';
import { toCents } from '../lib/amount.js';

function headerCells(line) {
  const cells = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && quoted && line[index + 1] === '"') { value += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { cells.push(value.trim()); value = ''; }
    else value += char;
  }
  cells.push(value.trim());
  return cells.filter(Boolean);
}

function guess(headers, names) {
  return headers.find((header) => names.includes(header.toLowerCase())) ?? '';
}

function statusLabel(status) {
  return { matched: 'Matched', reconciled: 'Reconciled', suggested: 'Suggested match', ignored: 'Ignored', unmatched: 'Needs resolution' }[status] ?? status;
}

export function BankingPage() {
  const { activeOrganizationId, activeOrganization } = useOutletContext();
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const [selectedBankId, setSelectedBankId] = useState('');
  const [file, setFile] = useState(null);
  const [headers, setHeaders] = useState([]);
  const [mapping, setMapping] = useState({ dateFormat: 'YYYY-MM-DD', columns: { date: '', description: '', reference: '', debit: '', credit: '', amount: '', balance: '' } });
  const [fileError, setFileError] = useState('');
  const [statementId, setStatementId] = useState('');
  const [importSummary, setImportSummary] = useState(null);
  const [reconciliation, setReconciliation] = useState(null);
  const [candidateByLine, setCandidateByLine] = useState({});
  const [accountByLine, setAccountByLine] = useState({});
  const [reasonByLine, setReasonByLine] = useState({});

  const bankAccounts = useQuery({ queryKey: ['bank-accounts', activeOrganizationId], queryFn: () => apiRequest('/bank-accounts'), enabled: Boolean(activeOrganizationId) });
  const bankAccountId = selectedBankId || bankAccounts.data?.[0]?.id || '';
  const bankAccount = bankAccounts.data?.find(({ id }) => id === bankAccountId);
  const accounts = useQuery({ queryKey: ['accounts', activeOrganizationId], queryFn: () => apiRequest('/accounts'), enabled: Boolean(activeOrganizationId) });
  const statement = useQuery({ queryKey: ['bank-statement', activeOrganizationId, statementId], queryFn: () => apiRequest(`/statements/${statementId}/lines`), enabled: Boolean(activeOrganizationId && statementId) });
  const ledgerMovements = useQuery({
    queryKey: ['bank-ledger-movements', activeOrganizationId, bankAccount?.accountId],
    queryFn: async () => {
      const entries = await apiRequest('/journal-entries?page=1');
      const detailed = await Promise.all(entries.map((entry) => apiRequest(`/journal-entries/${entry.id}`)));
      return detailed.flatMap((entry) => entry.lines.filter((line) => line.accountId === bankAccount.accountId).map((line) => ({ ...line, entryId: entry.id, entryNumber: entry.entryNumber, entryDate: entry.entryDate, entryDescription: entry.description })));
    },
    enabled: Boolean(activeOrganizationId && bankAccount?.accountId && statementId),
  });
  const summary = useQuery({ queryKey: ['bank-reconciliation', activeOrganizationId, bankAccountId, statementId], queryFn: () => apiRequest(`/reports/bank-reconciliation?bankAccountId=${bankAccountId}&statementId=${statementId}`), enabled: Boolean(activeOrganizationId && bankAccountId && statementId) });

  const importStatement = useMutation({
    mutationFn: async () => {
      const body = new FormData();
      body.append('file', file);
      body.append('columnMapping', JSON.stringify(mapping));
      return apiRequest(`/bank-accounts/${bankAccountId}/statements`, { method: 'POST', body });
    },
    onSuccess: (data) => { setImportSummary(data); setStatementId(data.statement.id); notify({ title: 'Statement imported', message: `${data.imported} lines are ready for reconciliation.`, tone: 'success' }); },
    onError: (error) => setFileError(error.message),
  });

  const updateLine = useMutation({
    mutationFn: ({ path, body }) => apiRequest(path, { method: 'POST', body }),
    onSuccess: async (data) => {
      const updated = data.statementLine ?? data;
      queryClient.setQueryData(['bank-statement', activeOrganizationId, statementId], (current) => current ? { ...current, lines: current.lines.map((line) => line.id === updated.id ? updated : line) } : current);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['bank-reconciliation'] }),
        queryClient.invalidateQueries({ queryKey: ['bank-ledger-movements'] }),
        queryClient.invalidateQueries({ queryKey: ['journal-entries'] }),
        queryClient.invalidateQueries({ queryKey: ['general-ledger'] }),
        queryClient.invalidateQueries({ queryKey: ['trial-balance'] }),
        queryClient.invalidateQueries({ queryKey: ['profit-loss'] }),
        queryClient.invalidateQueries({ queryKey: ['balance-sheet'] }),
      ]);
    },
    onError: (error) => notify({ title: 'Could not update statement line', message: error.message, tone: 'error' }),
  });

  const prepare = useMutation({
    mutationFn: () => apiRequest('/reconciliations', { method: 'POST', body: { bankAccountId, statementId, asOfDate: statement.data.periodEnd } }),
    onSuccess: setReconciliation,
    onError: (error) => notify({ title: 'Could not prepare reconciliation', message: error.message, tone: 'error' }),
  });
  const complete = useMutation({
    mutationFn: () => apiRequest(`/reconciliations/${reconciliation.id}/complete`, { method: 'POST' }),
    onSuccess: (data) => { setReconciliation(data); notify({ title: 'Reconciliation completed', message: 'The statement closes at zero difference.', tone: 'success' }); },
    onError: (error) => notify({ title: 'Cannot complete reconciliation', message: error.message, tone: 'error' }),
  });

  const unresolved = statement.data?.lines.filter((line) => ['unmatched', 'suggested'].includes(line.status)).length ?? 0;
  const currentDifference = reconciliation?.difference ?? summary.data?.difference ?? '0.00';
  const canComplete = reconciliation?.status === 'in_progress' && unresolved === 0 && toCents(currentDifference) === 0n;
  const canReconcile = activeOrganization?.permissions?.includes('bank.reconcile');
  const otherAccounts = useMemo(() => accounts.data?.filter((account) => account.id !== bankAccount?.accountId && account.isActive) ?? [], [accounts.data, bankAccount?.accountId]);

  async function chooseFile(event) {
    const next = event.target.files?.[0];
    setFileError('');
    if (!next) return;
    if (next.size > 2 * 1024 * 1024) { setFileError('CSV file must be 2 MB or smaller.'); return; }
    if (!['text/csv', 'application/vnd.ms-excel'].includes(next.type)) { setFileError('Choose a CSV file.'); return; }
    const firstLine = (await next.text()).split(/\r?\n/, 1)[0];
    const nextHeaders = headerCells(firstLine);
    setFile(next);
    setHeaders(nextHeaders);
    setMapping({ dateFormat: 'YYYY-MM-DD', columns: { date: guess(nextHeaders, ['date', 'txn date', 'transaction date']), description: guess(nextHeaders, ['description', 'details', 'narration']), reference: guess(nextHeaders, ['reference', 'ref']), debit: guess(nextHeaders, ['debit', 'withdrawal']), credit: guess(nextHeaders, ['credit', 'deposit']), amount: guess(nextHeaders, ['amount']), balance: guess(nextHeaders, ['balance', 'running balance']) } });
  }

  function setColumn(key, value) { setMapping((current) => ({ ...current, columns: { ...current.columns, [key]: value } })); }
  function submitImport(event) {
    event.preventDefault();
    if (!file || !mapping.columns.date || !mapping.columns.description || !mapping.columns.balance || (!mapping.columns.amount && (!mapping.columns.debit || !mapping.columns.credit))) { setFileError('Map the date, description, balance, and amount columns.'); return; }
    importStatement.mutate();
  }

  if (bankAccounts.isPending || accounts.isPending) return <AsyncState title="Loading banking workspace" message="Fetching bank and ledger accounts." />;
  const loadError = bankAccounts.error ?? accounts.error;
  if (loadError) return <AsyncState title="Banking unavailable" message={loadError.message} />;

  return <div className="accounting-page banking-page">
    <div className="page-heading"><div><p className="eyebrow">Banking</p><h1>Statement reconciliation</h1><p>Import bank activity, resolve every line, and close at zero difference.</p></div><label className="bank-selector">Bank account<select aria-label="Bank account" value={bankAccountId} onChange={(event) => { setSelectedBankId(event.target.value); setStatementId(''); setImportSummary(null); setReconciliation(null); }}>{bankAccounts.data.map((item) => <option key={item.id} value={item.id}>{item.bankName} {item.accountNoMasked}</option>)}</select></label></div>
    {!bankAccountId ? <AsyncState title="No bank account configured" message="Create a bank account before importing a statement." /> : <>
      <form className="statement-upload report-surface" onSubmit={submitImport}>
        <div className="section-heading"><div><h2>Import statement</h2><p>CSV only, maximum 2 MB. The import is all-or-nothing.</p></div></div>
        <label className="file-drop">Bank statement CSV<input aria-label="Bank statement CSV" type="file" accept=".csv,text/csv,application/vnd.ms-excel" onChange={chooseFile} /><span>{file?.name ?? 'Choose a CSV file'}</span></label>
        {headers.length > 0 && <div className="mapping-grid"><label>Date format<select value={mapping.dateFormat} onChange={(event) => setMapping((current) => ({ ...current, dateFormat: event.target.value }))}><option>YYYY-MM-DD</option><option>DD/MM/YYYY</option></select></label>{[['date', 'Date'], ['description', 'Description'], ['reference', 'Reference'], ['debit', 'Debit'], ['credit', 'Credit'], ['amount', 'Signed amount'], ['balance', 'Balance']].map(([key, label]) => <label key={key}>{label} column<select aria-label={`${label} column`} value={mapping.columns[key]} onChange={(event) => setColumn(key, event.target.value)}><option value="">Not mapped</option>{headers.map((header) => <option key={header} value={header}>{header}</option>)}</select></label>)}</div>}
        {fileError && <div className="form-alert" role="alert">{fileError}</div>}
        <button className="primary-button" type="submit" disabled={!canReconcile || importStatement.isPending}>{importStatement.isPending ? 'Importing…' : 'Import statement'}</button>
      </form>
      {importSummary && <div className="import-summary" aria-live="polite"><strong>{importSummary.imported} lines imported</strong><span>{importSummary.autoMatched} auto-matched</span><span>{importSummary.suggested} suggested</span><span>{importSummary.unmatched} unmatched</span></div>}
      {statementId && (statement.isPending || ledgerMovements.isPending || summary.isPending) ? <AsyncState title="Preparing reconciliation" message="Loading statement lines and ledger movements." /> : statement.isError || ledgerMovements.isError || summary.isError ? <AsyncState title="Reconciliation unavailable" message={(statement.error ?? ledgerMovements.error ?? summary.error)?.message} /> : statement.data && <>
        <div className="reconciliation-workspace">
          <section><h2>Statement lines</h2><div className="statement-line-list">{statement.data.lines.map((line) => <StatementLine key={line.id} line={line} movements={ledgerMovements.data} otherAccounts={otherAccounts} candidate={candidateByLine[line.id] ?? ''} account={accountByLine[line.id] ?? ''} reason={reasonByLine[line.id] ?? ''} pending={updateLine.isPending} onCandidate={(value) => setCandidateByLine((current) => ({ ...current, [line.id]: value }))} onAccount={(value) => setAccountByLine((current) => ({ ...current, [line.id]: value }))} onReason={(value) => setReasonByLine((current) => ({ ...current, [line.id]: value }))} mutate={(path, body) => updateLine.mutate({ path, body })} />)}</div></section>
          <section className="ledger-movement-column"><h2>Available ledger movements</h2>{ledgerMovements.data.length === 0 ? <AsyncState title="No available movements" message="Create an entry from an unmatched statement line when required." /> : ledgerMovements.data.map((line) => <article className="ledger-movement" key={line.id}><div><strong>{line.entryNumber}</strong><span>{line.entryDate}</span></div><p>{line.description ?? line.entryDescription}</p><Money value={toCents(line.debit) > 0n ? line.debit : line.credit} /></article>)}</section>
        </div>
        <div className={`reconciliation-footer ${toCents(currentDifference) === 0n ? 'reconciliation-zero' : ''}`}><div><span>Book</span><Money value={summary.data.bookBalance} /></div><div><span>Bank</span><Money value={summary.data.bankBalance} /></div><div><span>Difference</span><Money value={currentDifference} /></div><div><span>Unresolved</span><strong>{unresolved}</strong></div>{!reconciliation ? <button className="secondary-button" type="button" disabled={prepare.isPending || unresolved > 0} onClick={() => prepare.mutate()}>{prepare.isPending ? 'Preparing…' : 'Prepare reconciliation'}</button> : <button className="primary-button" type="button" disabled={!canComplete || complete.isPending} onClick={() => complete.mutate()}>{complete.isPending ? 'Completing…' : reconciliation.status === 'completed' ? 'Completed' : 'Complete reconciliation'}</button>}</div>
      </>}
    </>}
  </div>;
}

function StatementLine({ line, movements, otherAccounts, candidate, account, reason, pending, onCandidate, onAccount, onReason, mutate }) {
  const amount = toCents(line.credit) > 0n ? line.credit : line.debit;
  return <article className={`statement-line status-${line.status}`}><div className="statement-line-head"><div><strong>{line.description}</strong><span>{line.txnDate} {line.reference ? `· ${line.reference}` : ''}</span></div><Money value={amount} /></div><div className="statement-line-status"><span>{statusLabel(line.status)}</span>{line.matchConfidence && <span>{Math.round(Number(line.matchConfidence) * 100)}% confidence</span>}</div>{line.status === 'suggested' && <div className="line-actions"><button className="primary-button compact" type="button" disabled={pending} onClick={() => mutate(`/lines/${line.id}/match`, { journalLineId: line.matchedJournalLineId })}>Confirm match</button><button className="secondary-button compact" type="button" disabled={pending} onClick={() => mutate(`/lines/${line.id}/reject`, {})}>Reject suggestion</button></div>}{line.status === 'unmatched' && <div className="resolution-panel"><label>Ledger movement<select aria-label={`Ledger movement for ${line.description}`} value={candidate} onChange={(event) => onCandidate(event.target.value)}><option value="">Select movement</option>{movements.map((movement) => <option key={movement.id} value={movement.id}>{movement.entryNumber} - {movement.entryDate}</option>)}</select></label><button className="secondary-button compact" type="button" disabled={!candidate || pending} onClick={() => mutate(`/lines/${line.id}/match`, { journalLineId: candidate })}>Match selected</button><label>Other account<select aria-label={`Other account for ${line.description}`} value={account} onChange={(event) => onAccount(event.target.value)}><option value="">Select account</option>{otherAccounts.map((item) => <option key={item.id} value={item.id}>{item.code} - {item.name}</option>)}</select></label><button className="secondary-button compact" type="button" disabled={!account || pending} onClick={() => mutate(`/lines/${line.id}/create-entry`, { accountId: account, narration: line.description })}>Create entry</button><label>Ignore reason<input aria-label={`Ignore reason for ${line.description}`} value={reason} onChange={(event) => onReason(event.target.value)} /></label><button className="secondary-button compact" type="button" disabled={!reason.trim() || pending} onClick={() => mutate(`/lines/${line.id}/ignore`, { reason })}>Ignore line</button></div>}{line.status === 'ignored' && <p className="muted-copy">{line.ignoreReason}</p>}</article>;
}
