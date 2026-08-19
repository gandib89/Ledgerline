# Day 6 Frontend Design

## Goal

Complete the Developer B Day 6 work from `ledgerline-7-day-plan_1.md`: make the audit trail inspectable, finish accessibility and financial-formatting polish, provide a usable mobile reconciliation layout, and make `npm run seed:demo` reproduce the exact portfolio-demo company and transactions.

## Chosen approach

Use the existing Ledgerline shell, API client, React Query patterns, cream/emerald/ink visual system, and native CSS. Add only the smallest missing backend contract: a tenant-scoped `GET /api/v1/audit-log` route matching the frozen OpenAPI document. Keep the audit UI as one focused page and keep demo seeding in the existing Prisma seed script.

This is preferred over a mock-only audit page because an audit trail is useful only when it shows real committed activity. It is preferred over a general-purpose JSON-diff dependency because the required diff is small, deterministic, and can be rendered safely with native React.

## Audit trail

The API accepts `entityType`, `entityId`, `actorId`, and `page`. It verifies `audit.view`, scopes every query to the active organization, loads actor email separately because `AuditLog.userId` has no Prisma relation, and returns newest-first entries with decimal-free JSON values unchanged.

The page contains:

- entity-type, actor, and entity-ID filters;
- a newest-first vertical timeline;
- action, entity, timestamp, actor email, IP address, and request ID;
- an expandable before/after viewer;
- a compact changed-fields list derived from the two JSON objects;
- loading, empty, error, and pagination states;
- a permission message when the active membership lacks `audit.view`.

JSON is rendered as escaped text by React, never as HTML. Long IDs and JSON values wrap instead of overflowing.

## Mobile reconciliation

Desktop keeps the two-column statement/ledger workspace. Below 768px, an accessible two-tab control switches between “Statement lines” and “Ledger movements”. Both panels remain mounted for stable query state, while responsive CSS displays only the selected panel on mobile. The reconciliation totals remain visible below the active work area.

## Accessibility and financial polish

- Every icon-only control retains an explicit accessible name.
- Buttons, inputs, links, and selects keep visible focus states and minimum 44px targets.
- Loading states use `role="status"`; errors use `role="alert"`.
- All money continues through `<Money>`, which uses tabular numerals and accounting-style negative values such as `NPR (1,130.00)`.
- Numeric table columns remain right aligned.
- Dense tables keep horizontal scrolling on small screens.
- Reduced-motion preferences remain respected.

## Demo seed

The existing idempotent seed is extended for Annapurna Trading only. It creates the Section 14 opening entry, three posted invoices, rent journal, two posted receipts and allocations, Nabil Bank master account, four statement lines, matches the three known lines, leaves the service charge unresolved, posts the bank-charge adjustment, matches it, and completes the reconciliation at zero.

Stable natural keys and fixed UUIDs are used where the schema has no suitable unique business key. Re-running the seed must not duplicate documents, journal entries, statement lines, allocations, or reconciliation records. Financial entries are created through the existing posting services where practical so the seed exercises the same accounting rules as the app.

## Testing

- Backend unit/service test for audit serialization and filtering.
- Backend route integration test for permission, tenant scoping, newest-first ordering, and actor metadata; it runs when PostgreSQL is available.
- Frontend audit page tests for filters, timeline metadata, diff expansion, empty state, and pagination.
- Banking page test for accessible mobile tabs without changing desktop content.
- Money tests retain negative accounting-format coverage.
- Seed-plan unit test verifies the exact Section 14 transaction specification and stable identifiers without requiring a database.
- Final frontend lint, full tests, and production build; backend lint and all database-independent tests.

## Scope boundaries

Swagger UI, Postgres RLS, deployment, README production content, screenshots, video, and AI extraction belong to Developer A Day 6 or Day 7 and are not added here. No Git commit or push is performed.
