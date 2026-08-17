# Day 4–5 Frontend Design — Cash, Banking, Reconciliation, and Reports

**Date:** 2026-08-17  
**Status:** Approved for implementation  
**Scope:** Complete the Developer B work for Days 4 and 5 while preserving LedgerLine's existing React, React Query, MSW, and premium fintech design patterns.

## Goal

Make the backend work from Days 4 and 5 usable from the browser. A user must be able to receive and allocate a customer payment, inspect receivables and ledger activity, import a bank CSV, resolve its lines, complete reconciliation only at zero difference, and view or export the remaining financial reports.

## Constraints

- Use the existing React 19, React Router, TanStack Query, Zod, MSW, and CSS setup.
- Add no frontend dependency unless the existing platform cannot safely perform the work.
- Money remains a decimal string at every API and component boundary.
- The real backend and MSW demo mode must expose the same response shapes and state transitions.
- Organization changes invalidate all organization-scoped queries.
- Every screen must have loading, empty, error, success, and narrow-screen behavior.
- All amounts are right-aligned with tabular numerals and consistent negative formatting.
- All mutations use the existing API client, which supplies authorization, organization, refresh, and idempotency headers.
- Leave implementation changes uncommitted for the repository owner.

## Architecture

Each business workflow receives a focused route and page. Small pure helpers own decimal-safe allocation and CSV escaping. Report pages share presentation and export components, but business-specific layouts remain in their pages so that one generic report abstraction does not hide accounting meaning.

React Query owns server state. Mutations update or invalidate the smallest relevant query keys. MSW owns the demo ledger state and performs the same validation visible to the user, allowing the complete story to run without PostgreSQL.

## Routes and Navigation

| Route | Screen | Plan coverage |
|---|---|---|
| `/receipts/new` | Receive and allocate payment | Day 4 receipt screen |
| `/reports/ar-aging` | Customer aging and AR integrity | Day 4 AR Aging |
| `/reports/general-ledger` | Account activity and running balance | Day 4 General Ledger |
| `/banking` | Bank accounts, upload, mapping, reconciliation workspace | Day 5 banking and reconciliation |
| `/reports/profit-loss` | Revenue, expenses, and net profit | Day 5 P&L |
| `/reports/balance-sheet` | Assets, liabilities, equity, and balance proof | Day 5 Balance Sheet |
| `/reports/bank-reconciliation` | Book/bank summary and matching counts | Day 5 reconciliation report |

The existing sidebar gains working links for Receipts and Banking plus a Reports group exposing all report routes. The audit trail remains marked for Day 6.

## Day 4 Design

### Receipt allocation

The receipt screen loads customers, bank-enabled accounts, and the selected customer's posted or partially paid invoices. The user enters the receipt date, amount, deposit account, reference, and notes, then allocates amounts across open invoices.

Allocation uses decimal-string cents rather than JavaScript floating-point arithmetic. A summary shows receipt amount, allocated total, and unallocated remainder. Allocation cannot exceed either the invoice outstanding amount or the receipt amount. Submitting calls `POST /receipts`; success shows the permanent receipt number, allocation results, and balanced journal entry, then invalidates invoices, Trial Balance, AR Aging, General Ledger, dashboard, and report queries.

### Invoice payment history

Posted invoice details gain a Payment activity section showing allocated receipt number, date, reference, amount, and remaining balance. The current backend exposes receipt detail but no invoice-to-receipt read route, so implementation may add one narrow read-only endpoint: `GET /invoices/:id/payments`. It will read existing `PaymentAllocation` and `Document` rows only; no accounting behavior changes.

### AR Aging

The screen renders Current, 1–30, 31–60, 61–90, and 90+ buckets by customer. Rows can reveal the contributing invoices. Beneath the table, a control line compares the bucket total with the Accounts Receivable control-account balance. Green means reconciled; red displays the exact difference.

### General Ledger

The screen selects an account and date range, then shows opening balance, dated debit/credit movements, and a running balance. Source invoices link to their document route. Other source types remain identifiable text until their detail screens exist.

### Dashboard

The existing four metrics remain: total receivables, overdue receivables, current-period revenue, and cash at bank. They are populated from the AR Aging, P&L, bank-account, and bank-reconciliation data already used elsewhere. A missing bank statement produces a zero/empty cash state rather than failing the entire dashboard.

## Day 5 Design

### Statement import

The Banking screen starts with bank-account selection. A user drops or selects a CSV up to 2 MB. The browser reads only the header row to offer column selectors for date, description, reference, debit, credit or signed amount, and running balance, plus date format. The original file and JSON mapping are sent as multipart form data to `POST /bank-accounts/:id/statements`.

Import errors preserve the file and mapping so the user can correct them. Success displays imported, automatically matched, suggested, and unmatched counts, then loads `GET /statements/:id/lines`.

### Reconciliation workspace

Desktop uses two coordinated columns: statement lines on the left and bank-account ledger movements on the right. Mobile uses stacked tabs. Automatically matched lines are collapsed but expandable. Suggested rows show confidence plus Confirm and Reject. Unmatched rows can be matched to a ledger line, converted into a new journal entry by choosing the other account, or ignored with a reason.

The existing API supports confirming, manual matching, entry creation, and ignoring. Persistently rejecting a suggestion requires one narrow status-transition endpoint because the backend currently has no rejection route. The endpoint resets a suggested line to unmatched and clears its proposed journal-line link; it does not alter any journal entry.

After every action, statement lines and the reconciliation summary refresh. The sticky footer shows bank balance, book balance, difference, and unresolved count. Completion remains disabled until difference is exactly `0.00` and no lines are unresolved. The server remains authoritative and may reject completion even if the UI appears ready.

### Financial reports

- Profit & Loss groups revenue and expenses and emphasizes net profit or loss.
- Balance Sheet places assets beside liabilities and equity and displays the server's integrity proof.
- Bank Reconciliation Summary displays book balance, bank balance, difference, and matching counts.
- Date or account filters become URL query parameters so filtered views can be bookmarked.

Each report exports its currently displayed rows through a shared native CSV helper. Cells beginning with `=`, `+`, `-`, or `@` receive a leading apostrophe to prevent spreadsheet formula injection. CSV generation uses `Blob`, `URL.createObjectURL`, and a temporary download link; no dependency is needed.

## Components and Helpers

- `ReceiptPage`: form, open-invoice allocation table, success result.
- `PaymentHistory`: invoice allocation history.
- `ArAgingPage`: bucket report and AR control reconciliation.
- `GeneralLedgerPage`: account/date filters and running-balance table.
- `BankingPage`: bank selection and statement import orchestration.
- `StatementUpload`: file inspection and column mapping.
- `ReconciliationWorkspace`: line states and resolution actions.
- `ProfitLossPage`, `BalanceSheetPage`, `BankReconciliationPage`: accounting-specific report layouts.
- `ReportActions`: consistent report date controls and export action.
- `amount.js`: decimal-string cents operations for allocation and zero checks.
- `csv-export.js`: spreadsheet-safe CSV serialization and download.

Components remain local to the page when they have one consumer. They move into `components` only when at least two screens share the behavior.

## Error and Permission Behavior

- `payment.create` controls receipt submission.
- `bank.reconcile` controls import and reconciliation mutations.
- `report.view` controls report and ledger views through the backend.
- Validation errors are shown beside the responsible field.
- API errors show their human-readable message and preserve user input.
- Mutation buttons disable while pending to prevent accidental duplicate action.
- Empty states explain the prerequisite action, such as posting an invoice before allocating a payment.
- Integrity failures are never hidden; they show the server-provided difference.

## Testing Strategy

Tests are written before each implementation slice.

1. Pure amount tests prove allocation totals, remainders, limits, and decimal safety.
2. Pure CSV tests prove correct quoting and formula-injection escaping.
3. Receipt page tests cover customer selection, open invoices, over-allocation prevention, submission, and the posted result.
4. Invoice detail tests cover payment activity and refreshed outstanding amount.
5. AR and General Ledger tests cover bucket rendering, control reconciliation, running balance, filters, and source links.
6. Banking tests cover CSV mapping, multipart upload, imported counts, suggested confirmation/rejection, create-entry, ignore, zero-difference gating, and completion.
7. Report tests cover P&L, Balance Sheet, bank summary, integrity states, filters, and export.
8. Navigation tests prove every new route is reachable and no completed Day 4–5 item remains marked Soon.
9. Final verification runs frontend lint, all frontend tests, production build, and a repository diff review.

## Completion Criteria

- Every Developer B item listed for Days 4 and 5 in `ledgerline-7-day-plan_1.md` has a working route and test coverage.
- The full mock journey runs without a database: invoice, receipt, allocation, CSV upload, resolve lines, zero-difference reconciliation, and reports.
- The same pages use the real backend without changing request or response shapes.
- No money calculation relies on floating-point arithmetic.
- The layout remains usable at desktop and mobile widths.
- Lint, frontend tests, and production build pass.
- Work remains uncommitted and unpushed.
