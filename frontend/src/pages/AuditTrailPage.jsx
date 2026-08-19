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
