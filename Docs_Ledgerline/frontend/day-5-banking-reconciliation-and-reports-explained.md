# Day 5 Frontend Banking, Reconciliation, and Financial Reports — Explained from Zero

## 1. What we built

Day 5 delivered LedgerLine’s most operational workflow. A user could choose a bank account, upload a CSV statement, map unfamiliar column names, inspect imported lines, confirm or reject suggestions, manually match a line, create a missing ledger entry, ignore a justified line, prepare a reconciliation, and complete it only when the difference was zero.

The day also added Profit & Loss, Balance Sheet, Bank Reconciliation Summary, and safe CSV export.

## 2. Why this work was necessary

A bank statement is an external record of cash movement. The ledger is the organization’s internal record. Reconciliation compares them and explains every difference.

```text
Bank statement truth
        ↕ match and resolve
Ledger cash-account truth
        ↓
Difference = Bank closing balance − Book balance
        ↓
Complete only when difference = 0 and no unresolved lines remain
```

The user interface makes differences visible; backend rules decide whether reconciliation is valid.

## 3. Architecture and important files

| File | Day 5 status | Role |
|---|---|---|
| `frontend/src/pages/BankingPage.jsx` | Created | Coordinates CSV import, mapping, statement/ledger comparison, resolution actions, and completion. |
| `frontend/src/pages/ProfitLossPage.jsx` | Created | Shows period income, expenses, and net profit from ledger accounts. |
| `frontend/src/pages/BalanceSheetPage.jsx` | Created | Shows assets, liabilities, equity, and computed current-year earnings. |
| `frontend/src/pages/BankReconciliationPage.jsx` | Created | Provides the reconciliation summary report. |
| `frontend/src/components/ReportActions.jsx` | Created | Gives reports a shared CSV export control. |
| `frontend/src/lib/csv-export.js` | Created | Escapes CSV fields and spreadsheet-formula injection safely. |
| `frontend/src/App.jsx` and `AppShell.jsx` | Modified supporting files | Register and expose Day 5 routes. |
| `frontend/src/mocks/handlers.js` | Modified supporting file | Provides deterministic banking/report behavior for frontend tests. |

**Commit:** `8bd29ce88ebf461ad54bc36edeab76ee43fac815` — “Day 4 and 5 collective frontend update” on 2026-08-17.

## 4. The code explained from zero

### File: `frontend/src/lib/csv-export.js`

**Status:** Created

```jsx
function safeCell(value) {
  const text = String(value ?? '');
  const escapedFormula = /^[\t\r ]*[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(escapedFormula)
    ? `"${escapedFormula.replaceAll('"', '""')}"`
    : escapedFormula;
}

export function toCsv(columns, rows) {
  const header = columns.map(({ label }) => safeCell(label)).join(',');
  const body = rows.map((row) => columns.map(({ key, value }) => safeCell(value ? value(row) : row[key])).join(','));
  return [header, ...body].join('\r\n');
}

export function downloadCsv(filename, columns, rows) {
  const url = URL.createObjectURL(new Blob([`\uFEFF${toCsv(columns, rows)}`], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
```

**Purpose:** Builds and downloads report CSV data safely.

**Why does this file exist?** CSV looks simple, but commas, quotes, line breaks, and spreadsheet formulas can change how a file is interpreted.

**How does it connect to other files?** Report pages pass a filename, headings, and rows to `downloadCsv`, usually through `ReportActions`.

Important concepts:

- CSV is text where commas separate columns and newlines separate rows.
- A field containing a quote must duplicate that quote and be surrounded by quotes.
- Values beginning with `=`, `+`, `-`, or `@` may execute as formulas when opened by spreadsheet software.
- Prefixing a risky cell with an apostrophe makes it text.
- A `Blob` is browser-managed binary/text data.
- `URL.createObjectURL` creates a temporary downloadable address.
- Cleanup revokes that URL after the click.

Function flow for `downloadCsv`:

- **Data in:** filename, header array, and row arrays.
- **Processing:** escape every cell, join rows, create a Blob, create a temporary link, trigger download, revoke URL.
- **Data out:** a downloaded CSV file.
- **Who calls it:** financial report pages.
- **What it calls:** browser Blob, URL, and DOM APIs.

### File: `frontend/src/components/ReportActions.jsx`

**Status:** Created

```jsx
export function ReportActions({ children, onExport, disabled = false }) {
  return <div className="report-actions">{children}<button className="secondary-button" type="button" disabled={disabled} onClick={onExport}>Export CSV</button></div>;
}
```

**Purpose:** Provides a consistent export button.

**Why does this file exist?** Every report needs the same user action and should not reimplement download wiring.

**How does it connect to other files?** Report pages provide an `onExport` callback. The component calls it when clicked.

This small component demonstrates a prop callback: the parent owns export data, while the child owns only the button presentation.

### File: `frontend/src/pages/BankingPage.jsx`

**Status:** Created

```jsx
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
```

**Purpose:** Implements the statement-import and reconciliation workspace.

**Why does this file exist?** Banking reconciliation combines file handling, column mapping, several read queries, several resolution mutations, totals, permissions, and completion rules. One route coordinates the user journey while backend services retain financial authority.

**How does it connect to other files?** It calls bank-account, account, statement-line, journal-entry, reconciliation-report, match, reject, create-entry, ignore, prepare, and complete endpoints. It uses `Money`, exact amount helpers, TanStack Query, and toast notifications.

Important concepts:

- `File` represents the browser-selected CSV.
- `FormData` can send the file plus mapping metadata in a multipart HTTP request.
- MIME type and size checks provide fast feedback. The backend repeats file validation.
- Column mapping allows different banks to use different headings.
- `Promise.all` waits for several independent asynchronous requests together.
- A mutation path and body can be parameterized so one mutation wrapper serves several line actions.
- Query cache updates can replace one line immediately, followed by invalidation of dependent reports.
- Permission state disables reconciliation operations for unauthorized roles.
- Suggested and unmatched lines have different allowed actions.
- Completion remains disabled until the frontend sees zero difference and no unresolved items; the backend recomputes both.

Function flow for file selection:

- **Data in:** browser file-input event.
- **Processing:** check size/type, read the first line, extract headers, guess common mappings, store file and mapping.
- **Data out:** visible mapping selectors ready for correction.
- **Who calls it:** the file input.
- **What it calls:** `File.text`, header parsing, and mapping helpers.

Function flow for import:

- **Data in:** selected bank account, CSV file, and mapping object.
- **Processing:** build `FormData`, POST multipart request, store statement ID and import counts.
- **Data out:** imported statement summary and activated workspace.
- **Who calls it:** import form.
- **What it calls:** API client and toast provider.

Function flow for a statement-line resolution:

- **Data in:** endpoint path and action-specific body.
- **Processing:** POST action, replace returned line in cache, invalidate reconciliation/journal/report queries.
- **Data out:** updated line status and refreshed balances.
- **Who calls it:** Confirm, Reject, Match selected, Create entry, or Ignore buttons.
- **What it calls:** API client and query client.

Runtime for “Create entry”:

1. User finds an unmatched bank debit such as the NPR 1,130 service charge.
2. User selects Bank Charges as the other account.
3. Frontend posts the statement line and account choice.
4. Backend loads the tenant-scoped line.
5. Backend creates a bank-adjustment draft.
6. The normal posting engine creates a balanced journal entry.
7. The new bank journal line is matched to the statement line.
8. Frontend refreshes the line, ledger movements, and difference.
9. Difference becomes zero when all cash movements agree.

Runtime for completion:

1. User prepares a reconciliation.
2. Frontend displays Book, Bank, Difference, and unresolved count.
3. Completion button remains disabled unless current values are acceptable.
4. User clicks Complete.
5. Backend locks and reloads the reconciliation.
6. Backend recomputes book balance and unresolved count.
7. Non-zero difference or unresolved lines cause rejection.
8. Valid reconciliation becomes completed, and matched statement lines become reconciled.
9. Frontend displays the completed state.

### File: `frontend/src/pages/ProfitLossPage.jsx`

**Status:** Created

```jsx
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { AsyncState } from '../components/AsyncState.jsx';
import { Money } from '../components/Money.jsx';
import { ReportActions } from '../components/ReportActions.jsx';
import { apiRequest } from '../lib/api-client.js';
import { downloadCsv } from '../lib/csv-export.js';

export function ProfitLossPage() {
  const { activeOrganizationId } = useOutletContext();
  const [from, setFrom] = useState('2025-07-16');
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const report = useQuery({ queryKey: ['profit-loss', activeOrganizationId, from, to], queryFn: () => apiRequest(`/reports/profit-loss?from=${from}&to=${to}`), enabled: Boolean(activeOrganizationId && from && to) });
  const rows = report.data ? [...report.data.revenue.map((row) => ({ section: 'Revenue', ...row })), ...report.data.expense.map((row) => ({ section: 'Expense', ...row })), { section: 'Result', code: '', name: 'Net profit', amount: report.data.netProfit }] : [];
  return <div className="accounting-page"><div className="page-heading"><div><p className="eyebrow">Financial performance</p><h1>Profit &amp; Loss</h1><p>Revenue earned and expenses incurred during the selected period.</p></div><ReportActions disabled={!report.data} onExport={() => downloadCsv(`profit-loss-${from}-${to}.csv`, [{ key: 'section', label: 'Section' }, { key: 'code', label: 'Code' }, { key: 'name', label: 'Account' }, { key: 'amount', label: 'Amount (NPR)' }], rows)}><label>From<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label><label>To<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label></ReportActions></div>{report.isPending ? <AsyncState title="Building Profit & Loss" message="Summarizing posted revenue and expenses." /> : report.isError ? <AsyncState title="Profit & Loss unavailable" message={report.error.message} /> : <div className="statement-grid"><StatementSection title="Revenue" rows={report.data.revenue} totalLabel="Total revenue" total={report.data.revenueTotal} /><StatementSection title="Expenses" rows={report.data.expense} totalLabel="Total expenses" total={report.data.expenseTotal} /><section className="report-result"><span>Net profit</span><Money value={report.data.netProfit} /></section></div>}</div>;
}

function StatementSection({ title, rows, totalLabel, total }) {
  return <section className="report-surface statement-section"><h2>{title}</h2>{rows.length ? <div className="table-scroll"><table className="data-table"><tbody>{rows.map((row) => <tr key={`${row.code}-${row.name}`}><td>{row.code}</td><th>{row.name}</th><td className="numeric"><Money value={row.amount} /></td></tr>)}</tbody><tfoot><tr><th colSpan="2">{totalLabel}</th><td className="numeric"><Money value={total} /></td></tr></tfoot></table></div> : <AsyncState title={`No ${title.toLowerCase()}`} message="No posted accounts have a balance for this period." />}</section>;
}
```

**Purpose:** Shows revenue minus expenses for a period.

**Why does this file exist?** Profit & Loss explains operating performance, not cash alone.

**How does it connect to other files?** It queries the P&L report endpoint, renders account sections with `Money`, and exports the same result with safe CSV logic.

Concepts:

- Revenue and expense sections come from ledger-account classifications.
- Net profit is derived from posted journal activity.
- Date filters define the reporting period.
- Report export reuses values already returned by the server.

### File: `frontend/src/pages/BalanceSheetPage.jsx`

**Status:** Created

```jsx
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { AsyncState } from '../components/AsyncState.jsx';
import { Money } from '../components/Money.jsx';
import { ReportActions } from '../components/ReportActions.jsx';
import { apiRequest } from '../lib/api-client.js';
import { downloadCsv } from '../lib/csv-export.js';

function BalanceSection({ title, rows, total }) {
  return <section className="report-surface statement-section"><h2>{title}</h2><div className="table-scroll"><table className="data-table"><tbody>{rows.map((row) => <tr key={`${row.code}-${row.name}`}><td>{row.code ?? ''}</td><th>{row.name}</th><td className="numeric"><Money value={row.amount} /></td></tr>)}</tbody><tfoot><tr><th colSpan="2">Total {title.toLowerCase()}</th><td className="numeric"><Money value={total} /></td></tr></tfoot></table></div></section>;
}

export function BalanceSheetPage() {
  const { activeOrganizationId } = useOutletContext();
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const report = useQuery({ queryKey: ['balance-sheet', activeOrganizationId, asOf], queryFn: () => apiRequest(`/reports/balance-sheet?asOf=${asOf}`), enabled: Boolean(activeOrganizationId && asOf) });
  const rows = report.data ? [...report.data.assets.map((row) => ({ section: 'Assets', ...row })), ...report.data.liabilities.map((row) => ({ section: 'Liabilities', ...row })), ...report.data.equity.map((row) => ({ section: 'Equity', ...row }))] : [];
  return <div className="accounting-page"><div className="page-heading"><div><p className="eyebrow">Financial position</p><h1>Balance Sheet</h1><p>What the organization owns, owes, and retains at the report date.</p></div><ReportActions disabled={!report.data} onExport={() => downloadCsv(`balance-sheet-${asOf}.csv`, [{ key: 'section', label: 'Section' }, { key: 'code', label: 'Code' }, { key: 'name', label: 'Account' }, { key: 'amount', label: 'Amount (NPR)' }], rows)}><label>As of<input type="date" value={asOf} onChange={(event) => setAsOf(event.target.value)} /></label></ReportActions></div>{report.isPending ? <AsyncState title="Building Balance Sheet" message="Calculating balances and current-year earnings." /> : report.isError ? <AsyncState title="Balance Sheet unavailable" message={report.error.message} /> : <><div className="balance-sheet-grid"><BalanceSection title="Assets" rows={report.data.assets} total={report.data.totals.assets} /><div><BalanceSection title="Liabilities" rows={report.data.liabilities} total={report.data.totals.liabilities} /><BalanceSection title="Equity" rows={report.data.equity} total={report.data.totals.equity} /></div></div><div className={`report-integrity ${report.data.integrity.balanced ? '' : 'integrity-error'}`}><span>{report.data.integrity.balanced ? '✓' : '!'}</span><div><strong>{report.data.integrity.balanced ? 'Assets equal liabilities plus equity' : 'Balance Sheet difference detected'}</strong><small>Difference <Money value={report.data.integrity.difference} /></small></div></div></>}</div>;
}
```

**Purpose:** Shows financial position at one date.

**Why does this file exist?** The Balance Sheet demonstrates the accounting equation:

```text
Assets = Liabilities + Equity
```

**How does it connect to other files?** It calls the Balance Sheet endpoint, renders categorized account balances, includes computed current-year earnings, checks equality, and supports CSV export.

Concepts:

- “As of” reports describe a point in time.
- Current-year earnings connect P&L activity into equity without requiring a premature year-close journal.
- Equality is computed from ledger-derived report totals.

### File: `frontend/src/pages/BankReconciliationPage.jsx`

**Status:** Created

```jsx
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { AsyncState } from '../components/AsyncState.jsx';
import { Money } from '../components/Money.jsx';
import { ReportActions } from '../components/ReportActions.jsx';
import { apiRequest } from '../lib/api-client.js';
import { downloadCsv } from '../lib/csv-export.js';

export function BankReconciliationPage() {
  const { activeOrganizationId } = useOutletContext();
  const [selectedId, setSelectedId] = useState('');
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const accounts = useQuery({ queryKey: ['bank-accounts', activeOrganizationId], queryFn: () => apiRequest('/bank-accounts'), enabled: Boolean(activeOrganizationId) });
  const bankAccountId = selectedId || accounts.data?.[0]?.id || '';
  const report = useQuery({ queryKey: ['bank-reconciliation', activeOrganizationId, bankAccountId, asOf], queryFn: () => apiRequest(`/reports/bank-reconciliation?bankAccountId=${bankAccountId}&asOf=${asOf}`), enabled: Boolean(activeOrganizationId && bankAccountId && asOf) });
  const account = accounts.data?.find(({ id }) => id === bankAccountId);
  const exportRows = report.data ? [{ label: 'Book balance', amount: report.data.bookBalance }, { label: 'Bank balance', amount: report.data.bankBalance }, { label: 'Difference', amount: report.data.difference }] : [];
  return <div className="accounting-page"><div className="page-heading"><div><p className="eyebrow">Bank control</p><h1>Bank Reconciliation Summary</h1><p>Compare the ledger balance with the imported statement.</p></div><ReportActions disabled={!report.data} onExport={() => downloadCsv(`bank-reconciliation-${asOf}.csv`, [{ key: 'label', label: 'Measure' }, { key: 'amount', label: 'Amount (NPR)' }], exportRows)}><label>Bank account<select aria-label="Bank account" value={bankAccountId} onChange={(event) => setSelectedId(event.target.value)}>{accounts.data?.map((item) => <option key={item.id} value={item.id}>{item.bankName} {item.accountNoMasked}</option>)}</select></label><label>As of<input type="date" value={asOf} onChange={(event) => setAsOf(event.target.value)} /></label></ReportActions></div>{accounts.isPending || (bankAccountId && report.isPending) ? <AsyncState title="Loading bank summary" message="Comparing book and statement balances." /> : accounts.isError || report.isError ? <AsyncState title="Bank summary unavailable" message={(accounts.error ?? report.error)?.message} /> : !bankAccountId ? <AsyncState title="No bank account" message="Create a bank account before reconciling." /> : <><section className="bank-summary"><div><span>{account?.bankName}</span><strong>{account?.accountNoMasked}</strong></div><div><span>Book balance</span><Money value={report.data.bookBalance} /></div><div><span>Bank balance</span><Money value={report.data.bankBalance} /></div><div className={report.data.integrity.balanced ? 'summary-balanced' : 'summary-difference'}><span>Difference</span><Money value={report.data.difference} /></div></section><div className="reconciliation-counts"><span>{report.data.counts.matched} matched</span><span>{report.data.counts.suggested} suggested</span><span>{report.data.counts.unmatched} unmatched</span><span>{report.data.counts.ignored} ignored</span></div><div className={`report-integrity ${report.data.integrity.balanced ? '' : 'integrity-error'}`}><span>{report.data.integrity.balanced ? '✓' : '!'}</span><div><strong>{report.data.integrity.balanced ? 'Zero difference' : 'Reconciliation difference remains'}</strong><small>{report.data.integrity.balanced ? 'Book and bank balances agree.' : 'Resolve the remaining statement lines before completion.'}</small></div></div></>}</div>;
}
```

**Purpose:** Provides a report view of bank-versus-book status.

**Why does this file exist?** The workspace is for resolving lines; the summary is for reviewing the reconciliation result and exporting evidence.

**How does it connect to other files?** It loads bank accounts, requests the selected reconciliation summary, displays Book/Bank/Difference, and uses safe export.

## 5. Complete request and runtime flows

### CSV import

```text
File input
  → browser size/type feedback
    → header extraction
      → user confirms column mapping
        → multipart POST
          → backend MIME/magic-byte checks
          → CSV normalization
          → all-row validation
          → file hash idempotency
          → statement + lines transaction
          → matching engine
            → import summary
              → reconciliation workspace
```

### Suggested match

```text
Statement line + candidate
  → score and suggestion from backend
    → user confirms or rejects
      → POST line action
        → database match state
          → updated workspace and totals
```

### Missing transaction resolution

```text
Unmatched NPR 1,130 bank debit
  → choose Bank Charges
    → create-entry endpoint
      → normal posting engine
        → Dr Bank Charges 1,130
        → Cr Bank 1,130
      → match new bank journal line
        → difference falls to zero
```

### Financial report

```text
Report page filters
  → report endpoint
    → SQL over posted journal lines
      → decimal-string response
        → Money display
        → safe CSV export
```

## 6. New concepts introduced

- **Bank statement:** Bank-provided record of cash movements.
- **Column mapping:** Connecting bank-specific CSV headings to LedgerLine fields.
- **Multipart request:** HTTP request capable of carrying file bytes and form values.
- **File hash:** SHA-256 fingerprint used to recognize the same uploaded file.
- **Statement line:** One bank transaction imported from CSV.
- **Ledger movement:** A journal line affecting the selected bank account.
- **Matching:** Connecting one statement line to its corresponding ledger movement.
- **Suggested match:** A likely connection that still requires human review.
- **Manual match:** A connection explicitly selected by the user.
- **Bank adjustment:** A journal entry created for a real bank transaction missing from the ledger.
- **Reconciliation:** Proof that bank and book cash balances agree after all items are resolved.
- **Profit & Loss:** Revenue and expenses across a period.
- **Balance Sheet:** Assets, liabilities, and equity at one date.
- **Formula injection:** Spreadsheet execution risk caused by untrusted CSV cells beginning with formula characters.
- **Feature freeze:** The point after which the team stops adding core features and concentrates on reliability.

## 7. Errors and debugging

### Problem: bank CSV files use different headings

**Root cause:** Banks do not publish one universal column format.

**Diagnosis:** A fixed parser would accept only the developer’s sample file.

**Fix:** The browser exposes a mapping step, while the backend normalizer uses the submitted mapping.

**Lesson:** Validate external data explicitly; do not guess ambiguous financial formats silently.

### Problem: CSV export can become executable

**Root cause:** Spreadsheet programs interpret certain leading characters as formulas.

**Fix:** `csv-export.js` prefixes dangerous cells before quoting CSV syntax.

**Lesson:** Escaping delimiter syntax and preventing formula execution are different protections; both are necessary.

### Problem: zero shown in the UI could be stale

**Root cause:** Matches and adjustments can change balances after a reconciliation was first prepared.

**Fix:** Completion recalculates balance and unresolved count on the backend inside the completion flow.

**Lesson:** The server must verify the final state at the moment of transition.

No preserved Day 5 terminal error message establishes another observed failure.

## 8. Final understanding check

### On what we built

1. Why must users map CSV columns?
2. What are the three resolution paths for an unmatched statement line?
3. Why are workspace and reconciliation summary separate screens?

### On security and integrity

1. Why is frontend MIME checking insufficient?
2. Why is amount equality a hard requirement for matching?
3. Why does completion recompute rather than trust displayed values?
4. What spreadsheet attack does CSV escaping prevent?

### On architecture

1. Why does “Create entry” use the normal posting engine?
2. Which queries become stale after a match?
3. Why do P&L and Balance Sheet read journal lines rather than invoices?

### On request lifecycle

1. Trace a CSV from file selection to imported statement lines.
2. Trace the NPR 1,130 charge from unmatched line to zero difference.
3. What does the backend do after the Complete button is clicked?

### On debugging

1. How would you diagnose an incorrectly mapped debit column?
2. What symptom indicates a stale reconciliation summary?
3. Why must duplicate file detection use file content rather than filename alone?

## 9. Verification and deferred work

Day 5 tests covered CSV helpers, formula-injection safety, banking interactions, reconciliation actions, P&L, Balance Sheet, and reconciliation summary. Backend banking tests covered the authoritative parser and reconciliation rules.

The plan froze new core features at the end of Day 5. Day 6 was reserved for audit visibility, tests, accessibility/formatting polish, mobile reconciliation behavior, and deterministic demo data. AI extraction remained optional and was not required for the completed product.

