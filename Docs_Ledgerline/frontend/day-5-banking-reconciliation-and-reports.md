# Day 5 Frontend: Banking, Reconciliation, and Financial Reports

## What was built

- A banking workspace with bank-account selection and CSV upload.
- CSV file size/type checks, header reading, and a column-mapping step before import.
- A reconciliation workspace showing statement lines beside available ledger movements.
- Matched, suggested, unmatched, ignored, and reconciled states with clear visual treatment.
- Suggested matches can be confirmed or rejected.
- Unmatched lines can be manually matched, turned into a ledger entry, or ignored with a reason.
- A sticky Book / Bank / Difference footer that turns green only at zero difference.
- Reconciliation preparation and completion actions.
- Profit & Loss, Balance Sheet, and Bank Reconciliation Summary screens.
- CSV export with spreadsheet-formula injection protection.
- Demo-mode handlers for the complete receipt, reporting, statement, matching, and reconciliation flow.

## Why this work exists

The bank statement and the company's ledger often differ because a transaction exists on only one side or has not been identified yet. Reconciliation makes the user explain every difference. Completion is allowed only when unresolved items are gone and the book balance equals the bank balance. This is an important cash-control process, not just a file import.

The financial reports exist so the user can see performance, financial position, and bank-control results directly from ledger data. Current Year Earnings is shown in equity so the Balance Sheet remains mathematically complete.

## Safety and integrity controls

- CSV upload is restricted to accepted CSV types and 2 MB.
- The user explicitly maps columns before import.
- Automated matches remain human-reviewable suggestions.
- Rejecting a suggestion is supported by an audited backend endpoint and clears the proposed match.
- Reconciliation completion is disabled until the difference is zero and there are no unresolved statement lines.
- CSV cells beginning with spreadsheet formula characters are escaped before download.
- Report and reconciliation queries are organization-scoped through the existing API client and query keys.

## Verification

- CSV mapping and import-summary test.
- Suggested-match confidence and rejection test.
- P&L, Balance Sheet integrity, and Bank Reconciliation Summary tests.
- CSV escaping and quoting tests.
- Backend unit tests for rejecting a suggested match.
- Full frontend suite, lint, and production build.

