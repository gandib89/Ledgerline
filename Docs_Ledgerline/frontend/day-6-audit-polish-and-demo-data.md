# Day 6 Frontend — Audit, Polish, Mobile Reconciliation, and Demo Data

## What works now

### Audit trail

- `/audit` is a real navigation destination instead of a “Soon” item.
- It reads tenant-scoped activity from `GET /api/v1/audit-log`.
- Owners and accountants with `audit.view` can filter by entity type, actor ID, and entity ID.
- Every event shows its actor, time, IP address, request ID, and affected record.
- Expanding an event shows changed fields plus safe, escaped before/after JSON.
- The API always includes `organizationId` in its database filter and returns the newest records first.

Why: an accounting system must explain who changed a financial record and which request caused it. The tenant filter prevents one organization from seeing another organization’s history.

### Mobile reconciliation

- Desktop retains the two-column statement-versus-ledger workspace.
- Below 768 px, the workspace becomes keyboard-accessible Statement and Ledger tabs.
- The tabs use native buttons, `tablist`/`tab`/`tabpanel` roles, linked ARIA IDs, selected state, and left/right arrow switching.

Why: the two-column layout is too narrow on phones. Tabs preserve the full workflow without horizontal squeezing or hiding either source of truth.

### Accessibility and financial presentation

- Loading and normal status messages use `role="status"`.
- Errors use `role="alert"` and a non-spinning danger treatment.
- Empty states no longer look like active loading.
- Existing visible focus rings, 44 px icon controls, labeled icon buttons, reduced-motion support, and table overflow were retained and reviewed.
- Money stays in decimal strings and is rendered with tabular figures, right-aligned numeric columns, and accounting negatives such as `NPR (1,130.00)`.

Why: financial work is detail-heavy and frequently keyboard-driven. Stable number columns and immediate error announcements reduce reading and input mistakes.

### Exact demo seed

Running `npm run seed:demo` from the project root now delegates to the backend seed. It creates the exact Section 14 Annapurna Trading story:

- NPR 500,000 opening bank balance;
- three 13% VAT invoices totaling NPR 220,350;
- NPR 25,000 office rent;
- NPR 100,000 partial Himalayan receipt and NPR 50,850 full Everest receipt;
- the four-line Nabil CSV with NPR 624,720 closing balance;
- the NPR 1,130 bank-charge adjustment;
- matched statement lines and a completed zero-difference reconciliation;
- sample invoice-posted and reconciliation-completed audit records.

The seed locates records through stable references, uses upserts for bank masters, relies on the statement content hash, and skips completed work. Re-running it does not duplicate the planned invoices, receipts, allocations, statement, adjustment, audit samples, or reconciliation.

Why: reviewers need one command that always produces the same demonstrable accounting result. Using the real posting, receipt, import, matching, and reconciliation services also exercises the same controls as the UI.

## Main files

- `frontend/src/pages/AuditTrailPage.jsx`
- `frontend/src/lib/audit-diff.js`
- `frontend/src/pages/BankingPage.jsx`
- `frontend/src/components/AsyncState.jsx`
- `frontend/src/index.css`
- `backend/src/routes/audit.js`
- `backend/src/lib/audit/audit-query.js`
- `backend/prisma/demo-data.js`
- `backend/prisma/seed.js`
- root `package.json`

## Verification

- Frontend: 61 tests pass, lint passes, and the production build passes.
- Backend: lint passes and 21 database-independent tests pass, including the audit query and exact demo specification.
- Database-backed audit-route testing and running the seed twice require `DATABASE_URL`, `JWT_SECRET`, and PostgreSQL; the existing rate-limit integration test also requires Redis. Those services and variables were not available in this workspace, so the integration test and real double-seed run remain environment-dependent rather than falsely reported as executed.
- No Git commit or push was performed.
