# Day 4-5 Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete every Developer B deliverable from Days 4 and 5: customer receipts and allocation, AR and ledger reporting, dashboard metrics, bank CSV import, reconciliation, financial reports, and safe CSV export.

**Architecture:** Keep one focused React route per workflow, use TanStack Query for organization-scoped server state, and extend the existing MSW stateful demo so it mirrors backend transitions. Add only two narrow backend routes where the existing contract cannot support the required frontend behavior: invoice payment history and suggested-match rejection.

**Tech Stack:** React 19, React Router 7, TanStack Query 5, Zod 4, MSW 2, Vitest 4, Testing Library, native CSS, Express 5, Prisma 7.

## Global Constraints

- Preserve LedgerLine's existing cream, emerald, ink, and sidebar tokens.
- Use no new frontend dependencies.
- Keep money as decimal strings and use integer cents for browser-side allocation checks.
- Use the existing `apiRequest` client for auth, organization, idempotency, errors, and multipart bodies.
- Scope every query key with `activeOrganizationId` and include every query dependency in its key.
- Use visible labels, inline `role="alert"` errors, keyboard-reachable controls, and 44px touch targets.
- Use only subtle feedback motion and honor reduced-motion CSS.
- Keep mobile tables scrollable and collapse the reconciliation columns into stacked sections below 768px.
- Make no git commit or push.

---

### Task 1: Decimal-safe amount and CSV export helpers

**Files:**
- Create: `frontend/src/lib/amount.js`
- Create: `frontend/src/lib/amount.test.js`
- Create: `frontend/src/lib/csv-export.js`
- Create: `frontend/src/lib/csv-export.test.js`

**Interfaces:**
- Produces: `toCents(value) -> bigint`, `fromCents(value) -> string`, `sumAmounts(values) -> string`, `remainingAmount(total, allocations) -> string`, `isAllocationValid(total, allocations) -> boolean`.
- Produces: `toCsv(columns, rows) -> string`, `downloadCsv(filename, columns, rows) -> void`.

- [ ] Write failing tests using hand-derived literals:

```js
expect(toCents('113000.25')).toBe(11300025n);
expect(remainingAmount('100.00', ['35.25', '10.00'])).toBe('54.75');
expect(isAllocationValid('100.00', ['80.00', '20.01'])).toBe(false);
expect(toCsv([{ key: 'name', label: 'Name' }], [{ name: '=cmd' }]))
  .toBe('Name\r\n\'=cmd');
```

- [ ] Run `npm test -- src/lib/amount.test.js src/lib/csv-export.test.js` and confirm failure because the modules do not exist.
- [ ] Implement strict decimal parsing, integer-cent operations, RFC 4180 quoting, formula-prefix escaping, Blob download, and URL cleanup.
- [ ] Re-run the focused tests and confirm they pass.

### Task 2: Supporting read and rejection contracts

**Files:**
- Modify: `backend/src/routes/invoices.js`
- Modify: `backend/src/routes/invoices.test.js`
- Modify: `backend/src/routes/banking.js`
- Modify: `backend/src/routes/banking.test.js`
- Modify: `backend/src/lib/banking/reconciliation-service.js`

**Interfaces:**
- Produces: `GET /api/v1/invoices/:id/payments` returning `{ invoiceId, outstandingAmount, payments: [{ receiptId, receiptNo, docDate, referenceNo, amount, allocatedAt }] }`.
- Produces: `POST /api/v1/lines/:id/reject` returning a statement line with `status: "unmatched"`, `matchedJournalLineId: null`, and `matchConfidence: null`.

- [ ] Add an invoice-route integration test that posts an invoice and receipt, then expects the allocation to appear under `/invoices/:id/payments` with decimal strings.
- [ ] Add a banking integration test that imports a suggested line, rejects it, and verifies the proposed journal line becomes available again.
- [ ] Run the two backend test files against PostgreSQL and confirm the new assertions fail with 404.
- [ ] Implement the read query with tenant ownership checks and serialize dates and decimals.
- [ ] Implement `rejectSuggestedLine(actor, id)` in a transaction, accept only `SUGGESTED`, clear match metadata, and audit `statementLine.suggestionRejected`.
- [ ] Re-run the focused backend tests and confirm they pass when the database is available.

### Task 3: Day 4 receipt allocation and payment history

**Files:**
- Create: `frontend/src/pages/ReceiptPage.jsx`
- Create: `frontend/src/components/PaymentHistory.jsx`
- Create: `frontend/src/pages/day4-receipts.test.jsx`
- Modify: `frontend/src/pages/InvoiceDetailPage.jsx`
- Modify: `frontend/src/mocks/handlers.js`

**Interfaces:**
- Consumes: `/parties`, `/accounts`, `/invoices`, `POST /receipts`, and `GET /invoices/:id/payments`.
- Produces: a posted receipt result and invalidates `invoices`, `invoice-payments`, `trial-balance`, `ar-aging`, `general-ledger`, `dashboard`, and financial-report keys.

- [ ] Write a failing page test that selects Himalayan Trek Supplies, enters `60000.00`, allocates `50000.00`, sees a `10000.00` remainder, submits, and sees a receipt number and balanced journal.
- [ ] Write a failing invoice-detail test that displays a receipt allocation and the refreshed outstanding amount.
- [ ] Run `npm test -- src/pages/day4-receipts.test.jsx` and confirm route/component failures.
- [ ] Add MSW receipt, allocation, and invoice-payment state matching the backend responses.
- [ ] Implement the controlled receipt form with customer, date, bank account, amount, reference, notes, and allocation inputs.
- [ ] Enforce allocation limits with `amount.js`; place errors below the offending input and announce them.
- [ ] Render `PaymentHistory` only for non-draft invoices, with an explanatory empty state.
- [ ] Re-run focused tests and confirm they pass.

### Task 4: Day 4 AR Aging, General Ledger, and dashboard

**Files:**
- Create: `frontend/src/pages/ArAgingPage.jsx`
- Create: `frontend/src/pages/GeneralLedgerPage.jsx`
- Create: `frontend/src/pages/day4-reports.test.jsx`
- Modify: `frontend/src/pages/DashboardPage.jsx`
- Modify: `frontend/src/mocks/handlers.js`

**Interfaces:**
- Consumes: `/reports/ar-aging`, `/reports/general-ledger`, `/reports/profit-loss`, `/bank-accounts`, and `/reports/bank-reconciliation`.
- Produces: query keys `['ar-aging', org, asOf]`, `['general-ledger', org, accountId, from, to]`, and `['dashboard', org]`.

- [ ] Write failing tests for aging bucket totals, invoice disclosure, AR control equality, account/date filters, opening/running/closing balances, and invoice source links.
- [ ] Write a failing dashboard test proving report data replaces the mock-only `/dashboard/summary` dependency.
- [ ] Run the focused tests and confirm the new screens are missing.
- [ ] Extend MSW with complete AR, ledger, P&L, bank-account, and reconciliation report shapes.
- [ ] Implement AR Aging with an expandable invoice detail row and a visible control-account integrity line.
- [ ] Implement General Ledger with native date inputs, account selector, running-balance table, and invoice links.
- [ ] Refactor the dashboard to compose existing report queries and isolate a missing bank statement from the other metrics.
- [ ] Re-run focused tests and confirm they pass.

### Task 5: Day 5 CSV import and reconciliation workspace

**Files:**
- Create: `frontend/src/pages/BankingPage.jsx`
- Create: `frontend/src/pages/day5-banking.test.jsx`
- Modify: `frontend/src/mocks/handlers.js`

**Interfaces:**
- Consumes: `/bank-accounts`, multipart `/bank-accounts/:id/statements`, `/statements/:id/lines`, `/journal-entries`, `/journal-entries/:id`, line match/reject/create-entry/ignore mutations, and reconciliation create/complete mutations.
- Produces: a stateful import-to-completion workflow using backend-compatible payloads.

- [ ] Write a failing upload test using a real `File` with columns `Date,Description,Reference,Debit,Credit,Balance`; expect header mapping and multipart submission.
- [ ] Write failing tests for suggested confidence, confirm, reject, manual match, create-entry, ignore, and disabled completion while unresolved or different.
- [ ] Run the focused banking tests and confirm the route is missing.
- [ ] Add MSW bank accounts, statements, lines, journals, matches, and reconciliation state transitions.
- [ ] Implement CSV header parsing with `File.text()`, mapping selectors, date format, file-size/type feedback, and FormData upload.
- [ ] Implement the desktop two-column reconciliation surface; render it as stacked tabs/sections below 768px.
- [ ] Derive available ledger movements by loading the latest journal entries and their details, then filter to the selected bank GL account.
- [ ] Make every mutation invalidate statement, journal, reconciliation, dashboard, and report keys as appropriate.
- [ ] Create reconciliation from the imported statement, show the sticky Book/Bank/Difference footer, and enable completion only at zero with no unresolved lines.
- [ ] Re-run focused tests and confirm they pass.

### Task 6: Day 5 financial reports and safe export

**Files:**
- Create: `frontend/src/pages/ProfitLossPage.jsx`
- Create: `frontend/src/pages/BalanceSheetPage.jsx`
- Create: `frontend/src/pages/BankReconciliationPage.jsx`
- Create: `frontend/src/components/ReportActions.jsx`
- Create: `frontend/src/pages/day5-reports.test.jsx`
- Modify: `frontend/src/mocks/handlers.js`

**Interfaces:**
- Consumes: `/reports/profit-loss`, `/reports/balance-sheet`, `/reports/bank-reconciliation`, `downloadCsv`.
- Produces: filtered report routes and downloadable CSVs representing the displayed rows.

- [ ] Write failing tests for P&L grouping/net profit, Balance Sheet current-year earnings and integrity, bank summary counts/difference, date filters, and export action.
- [ ] Run the focused tests and confirm the report components do not exist.
- [ ] Implement `ReportActions` with explicit date labels and export button.
- [ ] Implement each report with its accounting-specific sections and server integrity proof.
- [ ] Export only current filtered data with plain accounting headers and decimal strings.
- [ ] Re-run focused tests and confirm they pass.

### Task 7: Routes, navigation, responsive premium styling, and documentation

**Files:**
- Modify: `frontend/src/App.jsx`
- Modify: `frontend/src/components/AppShell.jsx`
- Modify: `frontend/src/components/app-shell.test.jsx`
- Modify: `frontend/src/index.css`
- Create: `Docs_Ledgerline/frontend/day-4-cash-receipts-and-reports.md`
- Create: `Docs_Ledgerline/frontend/day-5-banking-reconciliation-and-reports.md`

**Interfaces:**
- Produces: reachable Day 4-5 routes and a sidebar with no `Soon` labels for completed modules.

- [ ] Write a failing shell test asserting Receipts, Banking, AR Aging, General Ledger, P&L, Balance Sheet, and Bank Reconciliation have real links.
- [ ] Run the shell test and confirm Receipts/Banking still point to dashboard placeholders.
- [ ] Register all routes and preserve the existing auth shell.
- [ ] Add responsive styles using the existing radius, border, color, and typography system; ensure all tables retain readable headers and mobile scroll.
- [ ] Add active, pending, focus-visible, disabled, empty, and integrity-error states.
- [ ] Re-read every visible string and replace vague or decorative copy with plain accounting language.
- [ ] Document Day 4 and Day 5 frontend behavior, reasons, data flow, files, tests, and remaining Day 6 boundary.
- [ ] Re-run the shell and page tests and confirm they pass.

### Task 8: Full verification and scope audit

**Files:**
- Review: all changed files
- Review: `ledgerline-7-day-plan_1.md` Day 4 and Day 5 Developer B lists

**Interfaces:**
- Produces: verified, uncommitted Day 4-5 frontend delivery.

- [ ] Run `npm run lint` in `frontend` and require exit code 0.
- [ ] Run `npm test` in `frontend` and require zero failed tests.
- [ ] Run `npm run build` in `frontend` and require exit code 0.
- [ ] Run backend lint and all database-independent tests.
- [ ] If PostgreSQL, Redis, and required environment variables are available, run the complete backend suite; otherwise report that limitation exactly.
- [ ] Inspect the UI at 375px, 768px, 1024px, and 1440px where a browser is available.
- [ ] Compare the implementation line-by-line with both Developer B lists and record any genuine gap instead of claiming completion.
- [ ] Run `git status --short` and `git diff --check`; confirm no commit or push was made.
