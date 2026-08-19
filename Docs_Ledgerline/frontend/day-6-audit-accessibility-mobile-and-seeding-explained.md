# Day 6 Frontend Audit, Accessibility, Mobile Reconciliation, and Demo Seed — Explained from Zero

## 1. What we built

Day 6 hardened the product after feature freeze. It added a real audit-trail route and screen, filterable activity, actor/IP/request metadata, expandable before/after JSON differences, improved loading/empty/error semantics, keyboard-visible focus, consistent accounting number presentation, and mobile tabs for the reconciliation workspace.

Developer B also owned the exact demo dataset. The seed creates the planned Annapurna Trading scenario through real posting, receipt, statement-import, matching, adjustment, reconciliation, and audit paths.

## 2. Why this work was necessary

Financial software must answer two different questions:

1. **What is the balance?** Reports answer this from the ledger.
2. **Who changed what, when, and through which request?** The audit trail answers this from append-only history.

Hardening also prevents a correct application from becoming difficult to operate. Keyboard focus, meaningful errors, stable number columns, accounting negatives, and a usable phone layout reduce mistakes.

## 3. Architecture and important files

```text
AuditTrailPage filters
  → GET /api/v1/audit-log
    → authenticate
    → resolveTenant
    → authorize("audit.view")
      → listAuditEntries()
        → Prisma AuditLog + User
          → safe JSON response
            → diffAuditValues()
              → expandable timeline
```

| File | Day 6 status | Role |
|---|---|---|
| `frontend/src/lib/audit-diff.js` | Created | Compares audit snapshots deterministically. |
| `frontend/src/pages/AuditTrailPage.jsx` | Created | Presents filters, timeline metadata, expansion, JSON, and paging. |
| `frontend/src/components/AsyncState.jsx` | Modified | Distinguishes normal status announcements from urgent error alerts. |
| `frontend/src/pages/BankingPage.jsx` | Modified | Adds keyboard-accessible mobile Statement/Ledger tabs. |
| `frontend/src/index.css` | Modified supporting file | Adds audit layout, error/empty styles, tab selection, mobile panel rules, and financial polish. |
| `backend/src/lib/audit/audit-query.js` | Created | Builds tenant-scoped audit filters and serializes actor information. |
| `backend/src/routes/audit.js` | Created | Exposes the permission-protected audit endpoint. |
| `backend/prisma/demo-data.js` | Created | Defines and persists the exact idempotent Section 14 scenario. |
| `backend/prisma/seed.js` | Modified supporting file | Invokes the exact scenario after master-data seeding. |
| root `package.json` | Created supporting file | Makes `npm run seed:demo` work from the repository root. |

**Commit:** `3d15bf081ad94e772da88cf62f44ed7753cae710` — “complete Day 6 audit and accessibility polish” on 2026-08-19.

## 4. The code explained from zero

### File: `frontend/src/lib/audit-diff.js`

**Status:** Created

```jsx
function isObject(value) {
  return value !== null && typeof value === 'object';
}

function sameValue(left, right) {
  if (Object.is(left, right)) return true;
  if (!isObject(left) || !isObject(right) || Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && sameValue(left[key], right[key]));
}

export function diffAuditValues(before, after) {
  const previous = isObject(before) && !Array.isArray(before) ? before : {};
  const next = isObject(after) && !Array.isArray(after) ? after : {};

  return [...new Set([...Object.keys(previous), ...Object.keys(next)])]
    .sort()
    .filter((field) => !sameValue(previous[field], next[field]))
    .map((field) => ({
      field,
      kind: !(field in previous) ? 'added' : !(field in next) ? 'removed' : 'changed',
      before: previous[field],
      after: next[field],
    }));
}

export function formatAuditValue(value) {
  if (value === undefined) return 'Not set';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}
```

**Purpose:** Finds top-level fields that were added, removed, or changed between two audit snapshots.

**Why does this file exist?** Raw JSON is accurate but difficult to scan. A deterministic comparison lets the UI point directly to meaningful changes.

**How does it connect to other files?** `AuditTrailPage` calls `diffAuditValues` for each expanded event and `formatAuditValue` for safe text display.

Important concepts:

- Recursion means a function calls itself. `sameValue` recursively checks nested arrays/objects.
- `Object.is` handles direct equality.
- `Object.keys` returns property names.
- Sorting keys makes comparison/display deterministic even if object insertion order differs.
- `Set` removes duplicate field names.
- `field in object` distinguishes a missing field from a field whose value is undefined.
- React renders returned strings as text, so JSON is not injected as HTML.

Function flow for `diffAuditValues(before, after)`:

- **Data in:** two JSON-compatible values.
- **Processing:** treat non-object roots as empty objects, combine/sort keys, remove equal fields, classify differences.
- **Data out:** rows shaped as `{ field, kind, before, after }`.
- **Who calls it:** `AuditTrailPage`.
- **What it calls:** `sameValue`, object/array helpers, and sorting.

### File: `frontend/src/pages/AuditTrailPage.jsx`

**Status:** Created

```jsx
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { AsyncState } from '../components/AsyncState.jsx';
import { apiRequest } from '../lib/api-client.js';
import { diffAuditValues, formatAuditValue } from '../lib/audit-diff.js';

const ENTITY_TYPES = [
  ['Document', 'Financial document'],
  ['JournalEntry', 'Journal entry'],
  ['BankAccount', 'Bank account'],
  ['BankStatement', 'Bank statement'],
  ['BankStatementLine', 'Statement line'],
  ['Reconciliation', 'Reconciliation'],
  ['Party', 'Customer'],
  ['Account', 'Ledger account'],
  ['AccountingPeriod', 'Accounting period'],
  ['Organization', 'Organization'],
  ['Membership', 'Membership'],
];

function queryPath(filters, page) {
  const params = new URLSearchParams();
  if (filters.entityType) params.set('entityType', filters.entityType);
  if (filters.actorId.trim()) params.set('actorId', filters.actorId.trim());
  if (filters.entityId.trim()) params.set('entityId', filters.entityId.trim());
  params.set('page', String(page));
  return `/audit-log?${params}`;
}

function actionLabel(action) {
  return action.replaceAll('.', ' · ').replaceAll('_', ' ');
}

function displayTime(value) {
  return new Intl.DateTimeFormat('en-NP', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kathmandu',
  }).format(new Date(value));
}

export function AuditTrailPage() {
  const { activeOrganizationId, activeOrganization } = useOutletContext();
  const canView = activeOrganization?.permissions?.includes('audit.view') ?? true;
  const emptyFilters = { entityType: '', actorId: '', entityId: '' };
  const [draftFilters, setDraftFilters] = useState(emptyFilters);
  const [filters, setFilters] = useState(emptyFilters);
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState(null);

  const audit = useQuery({
    queryKey: ['audit-log', activeOrganizationId, filters, page],
    queryFn: () => apiRequest(queryPath(filters, page)),
    enabled: Boolean(activeOrganizationId && canView),
  });
  const isFiltered = Object.values(filters).some(Boolean);

  function applyFilters(event) {
    event.preventDefault();
    setPage(1);
    setFilters({ ...draftFilters });
    setExpandedId(null);
  }

  function clearFilters() {
    setDraftFilters(emptyFilters);
    setFilters(emptyFilters);
    setPage(1);
  }

  if (!canView) {
    return <div className="accounting-page"><div className="page-heading"><div><p className="eyebrow">Controls</p><h1>Audit trail</h1></div></div><AsyncState tone="empty" title="Audit access required" message="Ask an owner to grant the audit.view permission." /></div>;
  }

  return (
    <div className="accounting-page audit-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Controls</p>
          <h1>Audit trail</h1>
          <p>Trace who changed a record, when it changed, and which request made it happen.</p>
        </div>
        <span className="audit-integrity-pill">Append-only record</span>
      </div>

      <form className="audit-filters report-surface" onSubmit={applyFilters}>
        <label>Entity type
          <select aria-label="Entity type" value={draftFilters.entityType} onChange={(event) => setDraftFilters((current) => ({ ...current, entityType: event.target.value }))}>
            <option value="">All entity types</option>
            {ENTITY_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label>Actor ID
          <input aria-label="Actor ID" value={draftFilters.actorId} onChange={(event) => setDraftFilters((current) => ({ ...current, actorId: event.target.value }))} placeholder="User UUID" />
        </label>
        <label>Entity ID
          <input aria-label="Entity ID" value={draftFilters.entityId} onChange={(event) => setDraftFilters((current) => ({ ...current, entityId: event.target.value }))} placeholder="Invoice or reconciliation ID" />
        </label>
        <div className="audit-filter-actions">
          <button className="primary-button" type="submit">Apply filters</button>
          <button className="secondary-button" type="button" onClick={clearFilters} disabled={!isFiltered && !Object.values(draftFilters).some(Boolean)}>Clear</button>
        </div>
      </form>

      {isFiltered && <p className="filter-result-note" role="status">Showing filtered activity</p>}
      {audit.isPending && <AsyncState title="Loading audit activity" message="Fetching the newest trace records." />}
      {audit.isError && <AsyncState tone="error" title="Audit trail unavailable" message={`${audit.error.message} Try again or clear the filters.`} />}
      {audit.data?.length === 0 && <AsyncState tone="empty" title="No audit activity found" message={isFiltered ? 'No records match these filters. Clear them to see all activity.' : 'Actions will appear here after users create, post, or reconcile records.'} />}

      {audit.data?.length > 0 && (
        <>
          <ol className="audit-timeline" aria-label="Audit activity, newest first">
            {audit.data.map((entry) => {
              const expanded = expandedId === entry.id;
              const changes = diffAuditValues(entry.before, entry.after);
              const panelId = `audit-changes-${entry.id}`;
              return (
                <li className="audit-event" key={entry.id}>
                  <span className="audit-event-dot" aria-hidden="true" />
                  <article>
                    <div className="audit-event-heading">
                      <div>
                        <span className="audit-action">{entry.action}</span>
                        <h2>{actionLabel(entry.action)}</h2>
                        <p>{entry.entityType} <span aria-hidden="true">·</span> <code>{entry.entityId}</code></p>
                      </div>
                      <time dateTime={entry.createdAt}>{displayTime(entry.createdAt)}</time>
                    </div>
                    <dl className="audit-metadata">
                      <div><dt>Actor</dt><dd>{entry.actor?.email ?? entry.actorId ?? 'System'}</dd></div>
                      <div><dt>IP address</dt><dd>{entry.ipAddress ?? 'Not captured'}</dd></div>
                      <div><dt>Request ID</dt><dd><code>{entry.requestId ?? 'Not captured'}</code></dd></div>
                    </dl>
                    <button
                      className="audit-expand-button"
                      type="button"
                      aria-expanded={expanded}
                      aria-controls={panelId}
                      aria-label={`${expanded ? 'Hide' : 'View'} changes for ${entry.action}`}
                      onClick={() => setExpandedId(expanded ? null : entry.id)}
                    >
                      <span>{changes.length} changed {changes.length === 1 ? 'field' : 'fields'}</span>
                      <span aria-hidden="true">{expanded ? '−' : '+'}</span>
                    </button>
                    {expanded && (
                      <div className="audit-diff" id={panelId} role="region" aria-label={`Changes for ${entry.action}`}>
                        {changes.length === 0 ? <p className="muted-copy">No top-level field changes were recorded.</p> : (
                          <div className="audit-diff-table" role="table" aria-label="Before and after values">
                            <div className="audit-diff-row audit-diff-head" role="row">
                              <span role="columnheader">Field</span><span role="columnheader">Before</span><span role="columnheader">After</span>
                            </div>
                            {changes.map((change) => (
                              <div className={`audit-diff-row change-${change.kind}`} role="row" key={change.field}>
                                <strong role="cell">{change.field}</strong>
                                <pre role="cell">{formatAuditValue(change.before)}</pre>
                                <pre role="cell">{formatAuditValue(change.after)}</pre>
                              </div>
                            ))}
                          </div>
                        )}
                        <div className="audit-json-grid">
                          <section><h3>Before JSON</h3><pre>{formatAuditValue(entry.before)}</pre></section>
                          <section><h3>After JSON</h3><pre>{formatAuditValue(entry.after)}</pre></section>
                        </div>
                      </div>
                    )}
                  </article>
                </li>
              );
            })}
          </ol>
          <nav className="audit-pagination" aria-label="Audit pages">
            <button className="secondary-button" type="button" disabled={page === 1} onClick={() => setPage((current) => current - 1)}>Previous</button>
            <span>Page {page}</span>
            <button className="secondary-button" type="button" disabled={audit.data.length < 25} onClick={() => setPage((current) => current + 1)}>Next</button>
          </nav>
        </>
      )}
    </div>
  );
}
```

**Purpose:** Makes append-only audit history readable and searchable.

**Why does this file exist?** An audit table hidden only in PostgreSQL does not help an owner investigate a posting or reconciliation. The screen exposes evidence without allowing edits.

**How does it connect to other files?** It reads active-organization permissions, calls the audit route, uses the diff helper and `AsyncState`, and is registered at `/audit`.

Important concepts:

- Draft filters hold current input; applied filters define the actual query. This prevents a network request after every character.
- `URLSearchParams` encodes optional filters safely.
- Page number is part of the query key.
- `aria-expanded` tells assistive technology whether change details are open.
- `aria-controls` links the button with its detail region.
- `time` uses a machine-readable `dateTime` plus localized visible text.
- `dl`, `dt`, and `dd` semantically represent metadata names and values.
- `pre` preserves JSON whitespace.
- React text escaping prevents audit strings from becoming executable markup.
- The Next button is disabled when fewer than 25 records return, matching the API page size.

Function flow for applying filters:

- **Data in:** form event and draft filter fields.
- **Processing:** prevent reload, reset page/expansion, copy drafts into applied filters.
- **Data out:** a new query key and API request.
- **Who calls it:** filter form.
- **What it calls:** React state setters.

Runtime:

1. User opens Audit Trail.
2. Page checks whether membership includes `audit.view`.
3. Query sends organization context and page/filter parameters.
4. Backend authenticates and verifies tenant membership.
5. Permission middleware checks `audit.view`.
6. Audit service queries only that organization.
7. Related user emails are loaded for actor display.
8. Serialized entries return newest first.
9. Page renders actor, timestamp, IP, request ID, action, and entity.
10. Expanding an event calculates changed fields and displays escaped snapshots.

### File: `frontend/src/components/AsyncState.jsx`

**Status:** Modified

```jsx
export function AsyncState({ title, message, action, tone = 'status' }) {
  return (
    <div className={`async-state async-state-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <span className="async-state-mark" aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        {message && <p>{message}</p>}
      </div>
      {action}
    </div>
  );
}
```

**Purpose:** Gives error states urgent announcement semantics while keeping loading and empty states non-urgent.

**Why does this file exist?** A screen reader should announce a failed financial request promptly, but ordinary loading updates should not behave like alarms.

**How does it connect to other files?** Pages pass `tone="error"` for failures and `tone="empty"` for valid zero-result states.

Important concepts:

- A default parameter supplies `"status"` when no tone is passed.
- `role="alert"` is assertive and appropriate for errors.
- `role="status"` is polite and appropriate for progress/empty information.
- The visual marker is hidden from assistive technology because the text already communicates meaning.

### File: `frontend/src/pages/BankingPage.jsx` — real Day 6 change

**Status:** Modified

**Purpose:** Keeps the desktop two-column reconciliation workspace but lets phone users switch between Statement and Ledger panels.

**Why does this file exist?** The page owns reconciliation work, and its Day 6 tab behavior prevents two dense financial columns from becoming unreadable when squeezed into a narrow screen.

**How does it connect to other files?** Local `mobilePanel` state controls data attributes consumed by responsive CSS. The same statement and ledger content remains mounted, so query state is not recreated.

The following is the complete Day 6 diff for this file:

```diff
diff --git a/frontend/src/pages/BankingPage.jsx b/frontend/src/pages/BankingPage.jsx
index 1475247..61418bd 100644
--- a/frontend/src/pages/BankingPage.jsx
+++ b/frontend/src/pages/BankingPage.jsx
@@ -43,10 +43,11 @@ export function BankingPage() {
   const [importSummary, setImportSummary] = useState(null);
   const [reconciliation, setReconciliation] = useState(null);
   const [candidateByLine, setCandidateByLine] = useState({});
   const [accountByLine, setAccountByLine] = useState({});
   const [reasonByLine, setReasonByLine] = useState({});
+  const [mobilePanel, setMobilePanel] = useState('statement');
 
   const bankAccounts = useQuery({ queryKey: ['bank-accounts', activeOrganizationId], queryFn: () => apiRequest('/bank-accounts'), enabled: Boolean(activeOrganizationId) });
   const bankAccountId = selectedBankId || bankAccounts.data?.[0]?.id || '';
   const bankAccount = bankAccounts.data?.find(({ id }) => id === bankAccountId);
   const accounts = useQuery({ queryKey: ['accounts', activeOrganizationId], queryFn: () => apiRequest('/accounts'), enabled: Boolean(activeOrganizationId) });
@@ -126,29 +127,43 @@ export function BankingPage() {
     event.preventDefault();
     if (!file || !mapping.columns.date || !mapping.columns.description || !mapping.columns.balance || (!mapping.columns.amount && (!mapping.columns.debit || !mapping.columns.credit))) { setFileError('Map the date, description, balance, and amount columns.'); return; }
     importStatement.mutate();
   }
 
+  function selectMobilePanel(event, panel) {
+    if (event.type === 'keydown' && !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
+    if (event.type === 'keydown') event.preventDefault();
+    const nextPanel = event.type === 'keydown' ? (panel === 'statement' ? 'ledger' : 'statement') : panel;
+    setMobilePanel(nextPanel);
+    if (event.type === 'keydown') {
+      event.currentTarget.parentElement.querySelector(`[data-panel-tab="${nextPanel}"]`)?.focus();
+    }
+  }
+
   if (bankAccounts.isPending || accounts.isPending) return <AsyncState title="Loading banking workspace" message="Fetching bank and ledger accounts." />;
   const loadError = bankAccounts.error ?? accounts.error;
-  if (loadError) return <AsyncState title="Banking unavailable" message={loadError.message} />;
+  if (loadError) return <AsyncState tone="error" title="Banking unavailable" message={loadError.message} />;
 
   return <div className="accounting-page banking-page">
     <div className="page-heading"><div><p className="eyebrow">Banking</p><h1>Statement reconciliation</h1><p>Import bank activity, resolve every line, and close at zero difference.</p></div><label className="bank-selector">Bank account<select aria-label="Bank account" value={bankAccountId} onChange={(event) => { setSelectedBankId(event.target.value); setStatementId(''); setImportSummary(null); setReconciliation(null); }}>{bankAccounts.data.map((item) => <option key={item.id} value={item.id}>{item.bankName} {item.accountNoMasked}</option>)}</select></label></div>
-    {!bankAccountId ? <AsyncState title="No bank account configured" message="Create a bank account before importing a statement." /> : <>
+    {!bankAccountId ? <AsyncState tone="empty" title="No bank account configured" message="Create a bank account before importing a statement." /> : <>
       <form className="statement-upload report-surface" onSubmit={submitImport}>
         <div className="section-heading"><div><h2>Import statement</h2><p>CSV only, maximum 2 MB. The import is all-or-nothing.</p></div></div>
         <label className="file-drop">Bank statement CSV<input aria-label="Bank statement CSV" type="file" accept=".csv,text/csv,application/vnd.ms-excel" onChange={chooseFile} /><span>{file?.name ?? 'Choose a CSV file'}</span></label>
         {headers.length > 0 && <div className="mapping-grid"><label>Date format<select value={mapping.dateFormat} onChange={(event) => setMapping((current) => ({ ...current, dateFormat: event.target.value }))}><option>YYYY-MM-DD</option><option>DD/MM/YYYY</option></select></label>{[['date', 'Date'], ['description', 'Description'], ['reference', 'Reference'], ['debit', 'Debit'], ['credit', 'Credit'], ['amount', 'Signed amount'], ['balance', 'Balance']].map(([key, label]) => <label key={key}>{label} column<select aria-label={`${label} column`} value={mapping.columns[key]} onChange={(event) => setColumn(key, event.target.value)}><option value="">Not mapped</option>{headers.map((header) => <option key={header} value={header}>{header}</option>)}</select></label>)}</div>}
         {fileError && <div className="form-alert" role="alert">{fileError}</div>}
         <button className="primary-button" type="submit" disabled={!canReconcile || importStatement.isPending}>{importStatement.isPending ? 'Importing…' : 'Import statement'}</button>
       </form>
       {importSummary && <div className="import-summary" aria-live="polite"><strong>{importSummary.imported} lines imported</strong><span>{importSummary.autoMatched} auto-matched</span><span>{importSummary.suggested} suggested</span><span>{importSummary.unmatched} unmatched</span></div>}
-      {statementId && (statement.isPending || ledgerMovements.isPending || summary.isPending) ? <AsyncState title="Preparing reconciliation" message="Loading statement lines and ledger movements." /> : statement.isError || ledgerMovements.isError || summary.isError ? <AsyncState title="Reconciliation unavailable" message={(statement.error ?? ledgerMovements.error ?? summary.error)?.message} /> : statement.data && <>
+      {statementId && (statement.isPending || ledgerMovements.isPending || summary.isPending) ? <AsyncState title="Preparing reconciliation" message="Loading statement lines and ledger movements." /> : statement.isError || ledgerMovements.isError || summary.isError ? <AsyncState tone="error" title="Reconciliation unavailable" message={(statement.error ?? ledgerMovements.error ?? summary.error)?.message} /> : statement.data && <>
+        <div className="reconciliation-tabs" role="tablist" aria-label="Reconciliation workspace">
+          <button id="statement-lines-tab" data-panel-tab="statement" role="tab" type="button" aria-selected={mobilePanel === 'statement'} aria-controls="statement-lines-panel" tabIndex={mobilePanel === 'statement' ? 0 : -1} onClick={(event) => selectMobilePanel(event, 'statement')} onKeyDown={(event) => selectMobilePanel(event, 'statement')}>Statement lines</button>
+          <button id="ledger-movements-tab" data-panel-tab="ledger" role="tab" type="button" aria-selected={mobilePanel === 'ledger'} aria-controls="ledger-movements-panel" tabIndex={mobilePanel === 'ledger' ? 0 : -1} onClick={(event) => selectMobilePanel(event, 'ledger')} onKeyDown={(event) => selectMobilePanel(event, 'ledger')}>Ledger movements</button>
+        </div>
         <div className="reconciliation-workspace">
-          <section><h2>Statement lines</h2><div className="statement-line-list">{statement.data.lines.map((line) => <StatementLine key={line.id} line={line} movements={ledgerMovements.data} otherAccounts={otherAccounts} candidate={candidateByLine[line.id] ?? ''} account={accountByLine[line.id] ?? ''} reason={reasonByLine[line.id] ?? ''} pending={updateLine.isPending} onCandidate={(value) => setCandidateByLine((current) => ({ ...current, [line.id]: value }))} onAccount={(value) => setAccountByLine((current) => ({ ...current, [line.id]: value }))} onReason={(value) => setReasonByLine((current) => ({ ...current, [line.id]: value }))} mutate={(path, body) => updateLine.mutate({ path, body })} />)}</div></section>
-          <section className="ledger-movement-column"><h2>Available ledger movements</h2>{ledgerMovements.data.length === 0 ? <AsyncState title="No available movements" message="Create an entry from an unmatched statement line when required." /> : ledgerMovements.data.map((line) => <article className="ledger-movement" key={line.id}><div><strong>{line.entryNumber}</strong><span>{line.entryDate}</span></div><p>{line.description ?? line.entryDescription}</p><Money value={toCents(line.debit) > 0n ? line.debit : line.credit} /></article>)}</section>
+          <section id="statement-lines-panel" role="tabpanel" aria-labelledby="statement-lines-tab" data-mobile-active={mobilePanel === 'statement'}><h2>Statement lines</h2><div className="statement-line-list">{statement.data.lines.map((line) => <StatementLine key={line.id} line={line} movements={ledgerMovements.data} otherAccounts={otherAccounts} candidate={candidateByLine[line.id] ?? ''} account={accountByLine[line.id] ?? ''} reason={reasonByLine[line.id] ?? ''} pending={updateLine.isPending} onCandidate={(value) => setCandidateByLine((current) => ({ ...current, [line.id]: value }))} onAccount={(value) => setAccountByLine((current) => ({ ...current, [line.id]: value }))} onReason={(value) => setReasonByLine((current) => ({ ...current, [line.id]: value }))} mutate={(path, body) => updateLine.mutate({ path, body })} />)}</div></section>
+          <section id="ledger-movements-panel" role="tabpanel" aria-labelledby="ledger-movements-tab" data-mobile-active={mobilePanel === 'ledger'} className="ledger-movement-column"><h2>Available ledger movements</h2>{ledgerMovements.data.length === 0 ? <AsyncState tone="empty" title="No available movements" message="Create an entry from an unmatched statement line when required." /> : ledgerMovements.data.map((line) => <article className="ledger-movement" key={line.id}><div><strong>{line.entryNumber}</strong><span>{line.entryDate}</span></div><p>{line.description ?? line.entryDescription}</p><Money value={toCents(line.debit) > 0n ? line.debit : line.credit} /></article>)}</section>
         </div>
         <div className={`reconciliation-footer ${toCents(currentDifference) === 0n ? 'reconciliation-zero' : ''}`}><div><span>Book</span><Money value={summary.data.bookBalance} /></div><div><span>Bank</span><Money value={summary.data.bankBalance} /></div><div><span>Difference</span><Money value={currentDifference} /></div><div><span>Unresolved</span><strong>{unresolved}</strong></div>{!reconciliation ? <button className="secondary-button" type="button" disabled={prepare.isPending || unresolved > 0} onClick={() => prepare.mutate()}>{prepare.isPending ? 'Preparing…' : 'Prepare reconciliation'}</button> : <button className="primary-button" type="button" disabled={!canComplete || complete.isPending} onClick={() => complete.mutate()}>{complete.isPending ? 'Completing…' : reconciliation.status === 'completed' ? 'Completed' : 'Complete reconciliation'}</button>}</div>
       </>}
     </>}
   </div>;
```

Important concepts:

- A tab list contains tab buttons controlling tab panels.
- `aria-selected`, `aria-controls`, and `aria-labelledby` describe the relationship.
- Roving `tabIndex` places only the selected tab in the normal tab order.
- ArrowLeft and ArrowRight switch selection and move keyboard focus.
- Desktop CSS hides the tab controls and shows both panels.
- Mobile CSS shows tabs and hides the panel whose `data-mobile-active` value is false.

### File: `backend/src/lib/audit/audit-query.js`

**Status:** Created

```jsx
export const AUDIT_PAGE_SIZE = 25;

export async function listAuditEntries(db, organizationId, filters = {}) {
  const page = filters.page ?? 1;
  const where = { organizationId };
  if (filters.entityType) where.entityType = filters.entityType;
  if (filters.entityId) where.entityId = filters.entityId;
  if (filters.actorId) where.userId = filters.actorId;

  const entries = await db.auditLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * AUDIT_PAGE_SIZE,
    take: AUDIT_PAGE_SIZE,
  });

  const actorIds = [...new Set(entries.map(({ userId }) => userId).filter(Boolean))];
  const actors = actorIds.length
    ? await db.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, email: true } })
    : [];
  const actorById = new Map(actors.map((actor) => [actor.id, actor]));

  return entries.map((entry) => ({
    id: entry.id,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    before: entry.before,
    after: entry.after,
    actorId: entry.userId,
    actor: entry.userId ? actorById.get(entry.userId) ?? { id: entry.userId, email: null } : null,
    ipAddress: entry.ipAddress,
    requestId: entry.requestId,
    createdAt: entry.createdAt.toISOString(),
  }));
}
```

**Purpose:** Contains database-independent construction of the audit read query and response.

**Why does this file exist?** Tenant scope and filter behavior are easier to test when they are not buried inside an Express callback.

**How does it connect to other files?** The route passes Prisma, organization ID, and validated filters. The service calls `auditLog.findMany` and `user.findMany`.

Important concepts:

- Prisma `findMany` reads rows matching `where`.
- `orderBy: { createdAt: "desc" }` returns newest events first.
- `skip` and `take` implement paging.
- A `Set` deduplicates actor IDs before the user query.
- A `Map` enables fast actor lookup during serialization.
- `toISOString()` makes date serialization explicit.
- Most importantly, `where` begins with `organizationId`. Filters can narrow this scope but never remove it.

Function flow:

- **Data in:** Prisma-like database client, trusted organization ID, validated optional filters.
- **Processing:** construct tenant query, fetch one page, fetch actors, serialize entries.
- **Data out:** audit-entry array.
- **Who calls it:** GET audit route.
- **What it calls:** Prisma models and JavaScript collection helpers.

### File: `backend/src/routes/audit.js`

**Status:** Created

```jsx
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { listAuditEntries } from '../lib/audit/audit-query.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { resolveTenant } from '../middleware/resolve-tenant.js';

const router = Router();
router.use(authenticate, resolveTenant);

const auditQuerySchema = z.object({
  entityType: z.string().trim().min(1).max(100).optional(),
  entityId: z.string().trim().min(1).max(200).optional(),
  actorId: z.string().uuid().optional(),
  page: z.coerce.number().int().positive().default(1),
}).strict();

router.get('/audit-log', authorize('audit.view'), async (req, res, next) => {
  try {
    const query = auditQuerySchema.parse(req.query);
    res.json(await listAuditEntries(prisma, req.organizationId, query));
  } catch (error) {
    next(error);
  }
});

export default router;
```

**Purpose:** Defines the HTTP boundary for audit reads.

**Why does this file exist?** Express needs a route that validates untrusted query strings and runs security middleware before database logic.

**How does it connect to other files?** `app.js` mounts it under `/api/v1`. It composes authenticate, tenant resolution, permission authorization, Zod parsing, and audit query service.

Important concepts:

- Middleware runs in order.
- `z.coerce.number()` converts a query-string number before validating it.
- `.strict()` rejects unexpected filter keys.
- `next(error)` hands failures to the shared Express error handler.
- The actor filter must be a UUID.
- Authorization uses a permission code rather than hardcoding a role name.

Runtime:

1. Express receives `GET /api/v1/audit-log`.
2. `authenticate` validates the user.
3. `resolveTenant` verifies organization membership.
4. `authorize("audit.view")` checks the membership’s permissions.
5. Zod validates filters.
6. Service runs tenant-scoped Prisma reads.
7. Express serializes the array to JSON.
8. Shared error middleware handles any failure.

### File: `backend/prisma/demo-data.js`

**Status:** Created

```jsx
const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
};

export const DEMO_SCENARIO = deepFreeze({
  organizationName: 'Annapurna Trading Pvt. Ltd.',
  actorEmail: 'sunita@annapurnatrading.com.np',
  opening: {
    date: '2025-07-17', reference: 'DEMO-OPENING-2082', amount: '500000.00',
    bankAccountCode: '1020', capitalAccountCode: '3100', narration: 'Demo opening balance',
  },
  invoices: [
    {
      date: '2026-01-12', customerCode: 'CUS-001', reference: 'DEMO-INV-HIMALAYAN', docNo: 'INV-2082-0001',
      description: '15 trekking backpacks @ NPR 8,000', revenueAccountCode: '4100', quantity: '15', unitPrice: '8000.00',
      taxableAmount: '120000.00', vatAmount: '15600.00', total: '135600.00',
    },
    {
      date: '2026-01-25', customerCode: 'CUS-002', reference: 'DEMO-INV-EVEREST', docNo: 'INV-2082-0002',
      description: 'Kitchen equipment installation', revenueAccountCode: '4200', quantity: '1', unitPrice: '45000.00',
      taxableAmount: '45000.00', vatAmount: '5850.00', total: '50850.00',
    },
    {
      date: '2026-02-18', customerCode: 'CUS-003', reference: 'DEMO-INV-SAGARMATHA', docNo: 'INV-2082-0003',
      description: 'Hand tools consignment', revenueAccountCode: '4100', quantity: '1', unitPrice: '30000.00',
      taxableAmount: '30000.00', vatAmount: '3900.00', total: '33900.00',
    },
  ],
  rent: {
    date: '2026-01-20', reference: 'DEMO-RENT-MAGH', amount: '25000.00',
    expenseAccountCode: '5300', bankAccountCode: '1020', narration: 'Office rent, Magh — DEMO-RENT-MAGH',
  },
  receipts: [
    { date: '2026-02-05', customerCode: 'CUS-001', invoiceReference: 'DEMO-INV-HIMALAYAN', reference: 'NEFT8834512', amount: '100000.00' },
    { date: '2026-02-08', customerCode: 'CUS-002', invoiceReference: 'DEMO-INV-EVEREST', reference: 'IPS2210094', amount: '50850.00' },
  ],
  statement: {
    bankName: 'Nabil Bank', accountNoMasked: '****9231', fileName: 'nabil-current-jan-feb-2026.csv',
    openingBalance: '500000.00', closingBalance: '624720.00', serviceCharge: '1130.00',
    csv: [
      'Date,Description,Reference,Debit,Credit,Balance',
      '2026-01-20,RENT PAYMENT ANNAPURNA COMPLEX PVT LTD,CHQ 004821,25000.00,,475000.00',
      '2026-02-05,NEFT/HIMALAYAN TREK SUPPLIES/INV-2082-0001,NEFT8834512,,100000.00,575000.00',
      '2026-02-08,IPS/EVEREST CAFE PVT LTD,IPS2210094,,50850.00,625850.00',
      '2026-02-25,MONTHLY SERVICE CHARGE,,1130.00,,624720.00',
    ].join('\n'),
  },
  expected: {
    receivables: '69500.00', overdue: '35600.00', cash: '624720.00', revenue: '195000.00',
    expenses: '26130.00', netProfit: '168870.00', reconciliationDifference: '0.00',
  },
});

function cents(value) {
  const match = String(value).match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) throw new Error(`Invalid demo money value: ${value}`);
  return BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
}

export function validateDemoScenario(scenario) {
  for (const invoice of scenario.invoices) {
    const taxable = cents(invoice.quantity) * cents(invoice.unitPrice) / 100n;
    if (taxable !== cents(invoice.taxableAmount)) throw new Error(`Demo invoice ${invoice.reference} taxable amount is inconsistent`);
    if (taxable * 13n / 100n !== cents(invoice.vatAmount)) throw new Error(`Demo invoice ${invoice.reference} VAT is not 13%`);
    if (taxable + cents(invoice.vatAmount) !== cents(invoice.total)) throw new Error(`Demo invoice ${invoice.reference} total is inconsistent`);
  }

  const statementRows = scenario.statement.csv.split('\n').slice(1).map((row) => row.split(','));
  let balance = cents(scenario.statement.openingBalance);
  for (const row of statementRows) {
    balance -= row[3] ? cents(row[3]) : 0n;
    balance += row[4] ? cents(row[4]) : 0n;
    if (balance !== cents(row[5])) throw new Error(`Demo statement balance is inconsistent on ${row[0]}`);
  }
  if (balance !== cents(scenario.statement.closingBalance)) throw new Error('Demo statement closing balance is inconsistent');

  const outstanding = scenario.invoices.reduce((total, invoice) => total + cents(invoice.total), 0n)
    - scenario.receipts.reduce((total, receipt) => total + cents(receipt.amount), 0n);
  if (outstanding !== cents(scenario.expected.receivables)) throw new Error('Demo receivables total is inconsistent');
  return true;
}

async function accountMap(db, organizationId) {
  const accounts = await db.account.findMany({ where: { organizationId } });
  return new Map(accounts.map((account) => [account.code, account]));
}

async function ensureManualEntry(db, actor, spec, debitAccount, creditAccount, postManualEntry) {
  const existing = await db.journalEntry.findFirst({
    where: { organizationId: actor.organizationId, documentType: 'manual', description: spec.narration },
    include: { lines: true },
  });
  if (existing) return existing;
  return postManualEntry(actor, {
    entryDate: spec.date,
    narration: spec.narration,
    lines: [
      { accountId: debitAccount.id, debit: spec.amount, credit: '0', description: spec.narration },
      { accountId: creditAccount.id, debit: '0', credit: spec.amount, description: spec.narration },
    ],
  });
}

async function loadDocumentWithJournal(db, document) {
  return db.document.findUniqueOrThrow({ where: { id: document.id }, include: { journalEntry: { include: { lines: true } } } });
}

async function ensureInvoice(db, actor, spec, masters, createDraftInvoice, postDocument) {
  let document = await db.document.findFirst({
    where: { organizationId: actor.organizationId, docType: 'INVOICE', referenceNo: spec.reference },
  });
  if (!document) {
    document = await createDraftInvoice(actor, {
      partyId: masters.parties.get(spec.customerCode).id,
      docDate: spec.date,
      referenceNo: spec.reference,
      notes: 'Ledgerline Section 14 demo data',
      lines: [{
        accountId: masters.accounts.get(spec.revenueAccountCode).id,
        description: spec.description,
        quantity: spec.quantity,
        unitPrice: spec.unitPrice,
        discountPct: '0',
        taxCodeId: masters.vat.id,
      }],
    });
  }
  if (document.status === 'DRAFT') await postDocument(document.id, actor);
  const posted = await loadDocumentWithJournal(db, document);
  if (posted.docNo !== spec.docNo) {
    throw new Error(`Expected ${spec.reference} to be ${spec.docNo}, received ${posted.docNo}. Seed a clean demo database.`);
  }
  return posted;
}

async function ensureReceipt(db, actor, spec, masters, invoice, postReceipt) {
  let receipt = await db.document.findFirst({
    where: { organizationId: actor.organizationId, docType: 'RECEIPT', referenceNo: spec.reference },
  });
  if (!receipt) {
    const result = await postReceipt(actor, {
      partyId: masters.parties.get(spec.customerCode).id,
      docDate: spec.date,
      depositAccountId: masters.accounts.get('1020').id,
      amount: spec.amount,
      referenceNo: spec.reference,
      notes: 'Ledgerline Section 14 demo receipt',
      allocations: [{ invoiceId: invoice.id, amount: spec.amount }],
    });
    receipt = result.document;
  }
  return loadDocumentWithJournal(db, receipt);
}

async function seedAuditRecord(db, actor, requestId, entry) {
  const exists = await db.auditLog.findFirst({ where: { organizationId: actor.organizationId, requestId } });
  if (!exists) await db.auditLog.create({ data: { organizationId: actor.organizationId, userId: actor.userId, requestId, ipAddress: '127.0.0.1', ...entry } });
}

export async function seedDemoScenario(db, context) {
  validateDemoScenario(DEMO_SCENARIO);
  const [
    { createDraftInvoice }, { postDocument }, { postManualEntry }, { postReceipt },
    { importStatement }, { manualMatchLine, createEntryFromLine, createReconciliation, completeReconciliation },
  ] = await Promise.all([
    import('../src/lib/invoices/invoice-service.js'),
    import('../src/lib/accounting/post-document.js'),
    import('../src/lib/accounting/post-manual-entry.js'),
    import('../src/lib/accounting/receipt-service.js'),
    import('../src/lib/banking/statement-import-service.js'),
    import('../src/lib/banking/reconciliation-service.js'),
  ]);

  const actor = { userId: context.userId, organizationId: context.organizationId, roleId: context.roleId };
  const accounts = await accountMap(db, actor.organizationId);
  const parties = new Map((await db.party.findMany({ where: { organizationId: actor.organizationId } })).map((party) => [party.code, party]));
  const vat = await db.taxCode.findUniqueOrThrow({ where: { organizationId_code: { organizationId: actor.organizationId, code: 'VAT13' } } });
  const masters = { accounts, parties, vat };

  const opening = await ensureManualEntry(db, actor, DEMO_SCENARIO.opening, accounts.get('1020'), accounts.get('3100'), postManualEntry);
  const firstInvoice = await ensureInvoice(db, actor, DEMO_SCENARIO.invoices[0], masters, createDraftInvoice, postDocument);
  const rent = await ensureManualEntry(db, actor, DEMO_SCENARIO.rent, accounts.get('5300'), accounts.get('1020'), postManualEntry);
  const secondInvoice = await ensureInvoice(db, actor, DEMO_SCENARIO.invoices[1], masters, createDraftInvoice, postDocument);
  const firstReceipt = await ensureReceipt(db, actor, DEMO_SCENARIO.receipts[0], masters, firstInvoice, postReceipt);
  const secondReceipt = await ensureReceipt(db, actor, DEMO_SCENARIO.receipts[1], masters, secondInvoice, postReceipt);
  const thirdInvoice = await ensureInvoice(db, actor, DEMO_SCENARIO.invoices[2], masters, createDraftInvoice, postDocument);

  const bankAccount = await db.bankAccount.upsert({
    where: { organizationId_accountId: { organizationId: actor.organizationId, accountId: accounts.get('1020').id } },
    update: { bankName: DEMO_SCENARIO.statement.bankName, accountNoMasked: DEMO_SCENARIO.statement.accountNoMasked, openingBalance: DEMO_SCENARIO.statement.openingBalance, isActive: true },
    create: { organizationId: actor.organizationId, accountId: accounts.get('1020').id, bankName: DEMO_SCENARIO.statement.bankName, accountNoMasked: DEMO_SCENARIO.statement.accountNoMasked, openingBalance: DEMO_SCENARIO.statement.openingBalance },
  });

  const imported = await importStatement(actor, {
    bankAccountId: bankAccount.id,
    fileName: DEMO_SCENARIO.statement.fileName,
    csvContent: DEMO_SCENARIO.statement.csv,
    columnMapping: { dateFormat: 'YYYY-MM-DD', columns: { date: 'Date', description: 'Description', reference: 'Reference', debit: 'Debit', credit: 'Credit', balance: 'Balance' } },
  });
  const statement = imported.statement;
  let statementLines = await db.bankStatementLine.findMany({ where: { statementId: statement.id }, orderBy: { txnDate: 'asc' } });

  const bankLine = (entry) => entry.lines.find((line) => line.accountId === accounts.get('1020').id);
  const expectedMatches = [bankLine(rent), bankLine(firstReceipt.journalEntry), bankLine(secondReceipt.journalEntry)];
  for (let index = 0; index < 3; index += 1) {
    const line = statementLines[index];
    if (!['MATCHED', 'RECONCILED'].includes(line.status)) await manualMatchLine(actor, line.id, expectedMatches[index].id);
  }

  statementLines = await db.bankStatementLine.findMany({ where: { statementId: statement.id }, orderBy: { txnDate: 'asc' } });
  const serviceChargeLine = statementLines[3];
  if (!['MATCHED', 'RECONCILED'].includes(serviceChargeLine.status)) {
    await createEntryFromLine(actor, serviceChargeLine.id, { accountId: accounts.get('5500').id, narration: 'Nabil monthly service charge' });
  }

  let reconciliation = await db.reconciliation.findFirst({ where: { organizationId: actor.organizationId, statementId: statement.id } });
  if (!reconciliation) reconciliation = await createReconciliation(actor, { bankAccountId: bankAccount.id, statementId: statement.id, asOfDate: '2026-02-25' });
  if (reconciliation.status !== 'COMPLETED') reconciliation = await completeReconciliation(actor, reconciliation.id);

  await seedAuditRecord(db, actor, 'demo-invoice-posted', {
    action: 'invoice.posted', entityType: 'Document', entityId: thirdInvoice.id,
    before: { status: 'DRAFT', docNo: null }, after: { status: 'POSTED', docNo: thirdInvoice.docNo },
  });
  await seedAuditRecord(db, actor, 'demo-reconciliation-completed', {
    action: 'reconciliation.completed', entityType: 'Reconciliation', entityId: reconciliation.id,
    before: { status: 'IN_PROGRESS', difference: DEMO_SCENARIO.statement.serviceCharge },
    after: { status: 'COMPLETED', difference: '0.00', unreconciledCount: 0 },
  });

  return {
    openingEntryId: opening.id,
    invoiceIds: [firstInvoice.id, secondInvoice.id, thirdInvoice.id],
    receiptIds: [firstReceipt.id, secondReceipt.id],
    bankAccountId: bankAccount.id,
    statementId: statement.id,
    reconciliationId: reconciliation.id,
  };
}
```

**Purpose:** Describes and persists the exact portfolio-demo accounting story.

**Why does this file exist?** Reviewers need the same meaningful organization and transactions every time they run the project. Random or partial seed data cannot demonstrate a known zero-difference reconciliation.

**How does it connect to other files?** `prisma/seed.js` calls `seedDemoScenario` after creating users, roles, fiscal periods, accounts, tax code, and customers. The function dynamically imports existing invoice, posting, receipt, import, matching, adjustment, and reconciliation services.

Important concepts:

- Deep freezing prevents accidental changes to the scenario constants at runtime.
- Stable references identify existing demo records on rerun.
- Validation checks invoice arithmetic, 13% VAT, statement running balances, closing balance, and receivables before writes begin.
- Dynamic `import()` loads service modules only when real persistence runs, allowing specification tests to import the scenario without booting the database.
- Upsert updates an existing unique record or creates it when absent.
- Idempotent checks find existing documents, statements, reconciliations, and audit samples before creating them.
- The seed deliberately uses production services. It does not insert fake journal lines around accounting controls.

Main scenario values:

- Opening Nabil bank balance: NPR 500,000.
- Three invoices: NPR 135,600; NPR 50,850; NPR 33,900.
- Office rent: NPR 25,000.
- Receipts: NPR 100,000 and NPR 50,850.
- Statement closing balance: NPR 624,720.
- Missing monthly service charge: NPR 1,130.
- Final reconciliation difference: NPR 0.00.

Function flow for `seedDemoScenario`:

- **Data in:** Prisma client and seeded actor/organization context.
- **Processing:** validate constants, load services, locate masters, ensure opening, invoices, rent, receipts, bank account, statement, matches, adjustment, reconciliation, and audit samples.
- **Data out:** IDs of major seeded records.
- **Who calls it:** `backend/prisma/seed.js`.
- **What it calls:** the real accounting and banking service layer.

Runtime:

1. Base seed creates roles, users, memberships, FY 2082/83, periods, accounts, VAT 13%, and customers.
2. Demo validation checks all fixed arithmetic in memory.
3. Opening journal is created if missing.
4. Draft invoices are created and posted if missing.
5. Rent and customer receipts are posted.
6. CSV statement is imported or reused by its content hash.
7. Known statement lines are matched to bank journal lines.
8. Service charge creates a normal bank-adjustment entry.
9. Reconciliation is created and completed at zero.
10. Sample audit events are added once.
11. A rerun locates stable records and avoids duplicates.

## 5. Complete request and runtime flows

### Audit-screen flow

```text
Filter form
  → AuditTrailPage query
    → GET /audit-log
      → authenticate
      → resolve tenant
      → authorize audit.view
      → validate filters
      → AuditLog query constrained by organizationId
      → actor lookup
        → serialized response
          → timeline
            → diffAuditValues on expansion
```

### Mobile reconciliation flow

```text
Viewport below 768px
  → tab controls become visible
    → selected panel state
      → responsive CSS shows Statement or Ledger
        → Arrow keys switch and focus tabs
```

### Demo-seed flow

```text
npm run seed:demo
  → backend seed
    → master data
      → seedDemoScenario
        → posting services
        → receipt/allocation services
        → statement import/matcher
        → bank-adjustment posting
        → reconciliation completion
        → audit samples
          → deterministic demo company
```

## 6. New concepts introduced

- **Audit trail:** Append-only evidence of actions affecting records.
- **Before/after snapshot:** JSON state recorded on each side of a change.
- **Request ID:** Identifier connecting UI/API behavior with logs and audit evidence.
- **IP address:** Network-origin metadata captured for traceability.
- **Append-only:** Existing events are not edited or deleted; corrections create later events.
- **Recursive comparison:** Checking nested values by repeatedly applying the same comparison rule.
- **ARIA:** Accessibility attributes describing control meaning and relationships.
- **Live region:** Screen-reader announcement area such as status or alert.
- **Roving tab index:** Keyboard pattern where only the active tab is reached by normal Tab navigation.
- **Idempotent seed:** A seed that can run repeatedly without duplicating the intended scenario.
- **Stable reference:** Known business identifier used to locate previously seeded data.
- **Dynamic import:** Loading a JavaScript module during execution rather than at initial module evaluation.
- **Deep freeze:** Recursively preventing mutation of a configured object graph.

## 7. Errors and debugging

### Problem: real demo seed could not start locally

**Error message:**

```text
ZodError:
path: ["DATABASE_URL"]
Invalid input: expected string, received undefined

path: ["JWT_SECRET"]
Invalid input: expected string, received undefined
```

**Why it happened:** The workspace had no `backend/.env`, database URL, or JWT secret.

**How we diagnosed it:** Running `npm run seed:demo` reached `backend/prisma/seed.js` and stopped in `src/env.js` before database work.

**Fix:** The code command and unit specification were verified. Real double-seed verification was correctly left pending until PostgreSQL and required environment variables are configured.

**Lesson:** A startup validation failure is different from a seed-logic failure. Read where the stack stops before blaming the feature.

### Problem: database-backed audit test could not boot

**Error message:** The same missing `DATABASE_URL` and `JWT_SECRET` validation stopped test-module import.

**Fix:** Database-independent audit query tests ran with a fake Prisma boundary. The real route integration test remains available for an environment with PostgreSQL.

**Lesson:** Clearly separate unit proof from integration proof.

### Problem: local preview port was occupied

**Message:**

```text
Port 5173 is in use, trying another one...
Local: http://127.0.0.1:5174/
```

**Diagnosis and fix:** The preview correctly selected 5174. The temporary process and log files created for inspection were later stopped and removed without touching the existing 5173 process.

**Lesson:** Do not kill a pre-existing developer server just because a preferred port is busy.

### Problem: no in-app browser was available

The browser list was empty, so screenshot/manual browser QA could not be claimed. Automated page tests, lint, and production build were used, and the visual limitation was reported.

## 8. Final understanding check

### On what we built

1. Why does the audit screen show both metadata and value differences?
2. Why are draft filters separated from applied filters?
3. Why do mobile tabs leave both panels mounted?
4. Why must demo data end at zero reconciliation difference?

### On security reasoning

1. What leak occurs if `organizationId` is removed from the audit query?
2. Why is `audit.view` checked on the backend?
3. Why is audit JSON rendered as text instead of raw HTML?
4. Why does the seed use production posting services rather than direct journal inserts?

### On architecture

1. Why is audit query construction separate from the Express route?
2. How does `requestId` connect audit evidence to API diagnostics?
3. Why is scenario validation database-independent?
4. Which existing services does the demo seed coordinate?

### On request lifecycle

1. Trace an audit filter from form submission to timeline rows.
2. What happens when an audit event is expanded?
3. Trace the NPR 1,130 service charge through the demo seed.
4. What must happen before a reconciliation becomes completed?

### On debugging

1. How do you distinguish missing environment configuration from faulty seed arithmetic?
2. Why was database-independent audit testing still useful?
3. Why was the existing process on port 5173 left untouched?
4. Which checks can pass without proving the real double-seed run?

## 9. Verification, limitations, and deferred work

Verified at Day 6 completion:

- Frontend: 21 test files and 61 tests passed.
- Frontend lint passed.
- Frontend production build passed.
- Backend lint passed.
- Seven database-independent backend files and 21 tests passed.
- `git diff --check` passed.
- No Git commit or push was performed during implementation; the user later created commit `3d15bf0`.

Not falsely claimed:

- Database-backed audit route execution.
- Running the real seed twice against PostgreSQL.
- Redis-dependent rate-limit integration.
- Manual browser screenshot QA in the unavailable in-app browser.

The optional AI extraction slot was intentionally not implemented. The plan allowed it only if both developers were ahead and required deletion of a half-finished attempt. Day 7 deployment/presentation work has no separate completed frontend implementation report in the repository.
