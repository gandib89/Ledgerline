# Day 3 Frontend — Invoices, Journal Entries, and Trial Balance

## Completed Result

Day 3 is implemented in the browser. A user can filter invoices, prepare a VAT draft, receive exact
preview totals from the backend, reopen and edit a versioned draft, post it with confirmation, inspect
the permanent debit-and-credit journal, and open a Trial Balance with a zero-difference integrity result.

The main implementation files are:

| File | Job |
| --- | --- |
| `frontend/src/pages/InvoicesPage.jsx` | Lists and filters customer invoices. |
| `frontend/src/pages/InvoiceEditorPage.jsx` | Creates or edits a draft and requests server previews. |
| `frontend/src/pages/invoice-form.js` | Holds Zod validation and converts form state into a safe API payload. |
| `frontend/src/pages/InvoiceDetailPage.jsx` | Shows the invoice beside its journal and controls confirmed posting. |
| `frontend/src/pages/TrialBalancePage.jsx` | Shows account debit/credit totals and the ledger integrity result. |
| `frontend/src/pages/day3-pages.test.jsx` | Tests the complete browser behavior through HTTP boundaries. |
| `frontend/src/pages/invoice-form.test.js` | Tests validation and confirms client totals never enter save payloads. |
| `frontend/src/mocks/handlers.js` | Provides a working NPR/VAT invoice demo when mock mode is enabled. |

The supporting backend changes expose active tax codes, membership role/permissions, inclusive invoice
date filters, and a seeded `VAT13` code linked to VAT Payable. These are small browser-support contracts;
all accounting calculation and authorization remains on the backend.

## Purpose

Day 3 makes Ledgerline's accounting engine visible and usable in the browser. A user must be able
to prepare a VAT invoice, review totals calculated by the backend, save a draft, post it, inspect
the resulting double-entry journal, and confirm that the Trial Balance remains balanced.

The backend remains the accounting authority. The frontend collects business inputs and displays
results; it never calculates authoritative invoice totals or journal entries itself.

## Scope

The Day 3 frontend includes:

- An invoice list with customer, status, and date filters.
- A shared invoice editor for creating and editing drafts.
- Dynamic invoice lines with revenue-account and tax-code selectors.
- Live totals returned by `POST /api/v1/invoices/preview`.
- An invoice detail screen beside its generated journal entry.
- A permission-gated Post action with confirmation.
- A Trial Balance screen with an explicit balanced/difference result.
- Loading, empty, validation, conflict, permission, and server-error states.

Day 3 does not include receipt allocation, credit notes, reversals, AR aging, bank reconciliation,
P&L, Balance Sheet, or a manual-journal frontend. Those belong to later days in the project plan.

## Completed Backend Contract Additions

The browser now receives three small supporting contracts in addition to the Day 3 accounting
endpoints:

1. `GET /api/v1/tax-codes` returns active tax codes for the selected organization. Each row exposes
   `id`, `code`, `name`, `rate`, `type`, and `isActive`. Decimal rates remain strings.
2. `GET /api/v1/orgs` includes the current user's role and permission codes for each membership.
   The frontend uses those codes to hide or show actions; the backend still performs the real
   authorization check on every request.
3. `GET /api/v1/invoices` accepts optional `from` and `to` ISO-date filters in addition to its
   existing `partyId`, `status`, and `page` filters.

The demo seed creates an active `VAT13` tax code at rate `0.1300`, connected to the organization's
VAT Payable output account. Omitting a tax code represents an exempt/no-VAT line.

## Frontend Routes

| Route | Responsibility |
| --- | --- |
| `/invoices` | List and filter invoices; start a new invoice; open an existing invoice. |
| `/invoices/new` | Prepare and save a new draft invoice. |
| `/invoices/:id/edit` | Load and update an existing draft using its current `version`. |
| `/invoices/:id` | Display invoice facts and its linked double-entry journal. |
| `/reports/trial-balance` | Display ledger debit/credit balances and integrity result. |

## Component Boundaries

### `InvoicesPage`

Loads invoices and customers for the active organization. It owns filter and pagination state.
Customer names are resolved from the already-loaded party list; invoice responses continue to carry
the stable `partyId` identifier.

### `InvoiceEditorPage`

Owns header fields and line inputs. For edit mode it first loads the invoice and converts response
strings into form strings without converting money through floating-point arithmetic for display.
On save it sends only user inputs: party, dates, notes, descriptions, quantities, rates, discounts,
accounts, and optional tax-code IDs.

The editor never sends subtotal, VAT, grand total, outstanding amount, or journal data.

### `InvoiceLinesEditor`

Renders dynamic rows. Every row contains description, revenue account, quantity, unit price,
discount percentage, and VAT selection. At least one row must remain. Buttons have text or accessible
labels, and inputs retain visible labels on small screens.

### `InvoiceTotals`

Displays the response from the preview endpoint: subtotal, discount, taxable amount, VAT, and grand
total. Until a valid preview exists it displays a clear instruction instead of guessed values.

### `InvoiceDetailPage`

Displays the invoice and journal in a two-column layout on desktop and a stacked layout on narrow
screens. Draft invoices show an Edit action. Users with `invoice.post` see the Post action.

### `JournalEntryPanel`

Loads the linked journal entry when `journalEntryId` exists. It shows account, description, debit,
and credit columns, total debits and credits, and a textual balanced indicator. Draft invoices show
an explanation that no journal exists until posting.

### `TrialBalancePage`

Loads `/reports/trial-balance` for the selected date range. It displays debit/credit totals using
the existing `Money` component and renders `integrity.balanced` as text plus color, never color alone.

### `ConfirmationDialog`

Requires explicit confirmation before posting. It names the irreversible effect: the draft becomes
posted and a permanent journal entry is created. It disables confirmation while the request runs and
offers a visible Cancel action.

## Data Flow

### Draft creation

1. Load customers, revenue accounts, and tax codes for the active organization.
2. The user enters invoice header and line inputs.
3. After valid line changes settle briefly, call `/invoices/preview`.
4. Render only the server's returned totals.
5. Submit the draft with `POST /invoices`.
6. Invalidate invoice queries and navigate to the new invoice detail route.

### Draft editing

1. Load `/invoices/:id` and populate the same editor.
2. Preserve the returned `version`.
3. Submit all lines and the version with `PATCH /invoices/:id`.
4. A `409 version_conflict` tells the user another session changed the invoice; provide a Reload
   action rather than overwriting the newer data.

### Posting

1. Show Post only when the active membership includes `invoice.post`.
2. Open the confirmation dialog.
3. Submit `POST /invoices/:id/post`.
4. Replace/invalidate invoice and journal queries using the returned invoice and journal entry.
5. Render the posted status, permanent document number, outstanding amount, and balanced journal.

The frontend permission check improves usability only. Backend RBAC remains mandatory and authoritative.

## Validation

Zod validates the browser form before requests:

- Customer is required.
- Document date is required and uses `YYYY-MM-DD`.
- Due date is optional but cannot be before the document date.
- At least one line is required.
- Description and revenue account are required for every line.
- Quantity must be greater than zero.
- Unit price must be zero or greater.
- Discount must be between 0 and 100.

Accounting amounts are still recomputed by the backend. Browser validation exists to provide quick,
field-level feedback, not to establish financial truth.

## Loading, Empty, and Error Behaviour

- Every query uses the existing reusable `AsyncState` pattern.
- Invoice-list empty state offers a direct Create invoice action.
- Preview errors remain beside the totals area and do not erase user input.
- Save/post errors use an accessible toast and keep the form or confirmation context intact.
- A 409 version conflict offers Reload.
- A 403 response states that the current role lacks permission.
- Missing invoice or journal resources display a stable error state instead of redirect loops.
- Organization switching invalidates all invoice, journal, account, customer, tax, and report queries.

## Responsive and Accessibility Behaviour

- Desktop invoice detail uses a document/journal split; mobile stacks the same sections.
- Wide tables use responsive wrappers instead of overflowing the viewport.
- All controls are keyboard reachable with visible focus states.
- Dynamic line remove buttons have descriptive accessible names.
- Form errors are connected to their fields and announced.
- Monetary columns use tabular numerals and right alignment.
- Status and balance meaning always includes text, not color alone.
- Existing reduced-motion support remains effective.

## Testing Strategy

Frontend integration tests use MSW at the HTTP boundary and exercise real React components:

- Invoice list renders party names, status, outstanding amounts, filters, and pagination.
- Invoice editor rejects invalid input.
- Valid line changes call server preview and display the returned VAT/totals.
- Saving a draft sends no client-computed totals.
- Editing sends the current version and handles a 409 conflict.
- Post is hidden without `invoice.post` and shown with it.
- Confirmed posting renders the returned balanced journal.
- Trial Balance renders rows, totals, and the integrity result.

Backend integration tests cover the supporting tax-code, permission, and invoice date-filter contracts.
The full backend suite requires a dedicated PostgreSQL `DATABASE_URL`; database-independent checks,
lint, frontend tests, and the production frontend build remain runnable without it.

## Documentation Layout

Existing backend explanations move into `Docs_Ledgerline/backend/`. Matching beginner-friendly
frontend explanations live in `Docs_Ledgerline/frontend/` for Days 1, 2, and 3. The teaching prompt
stays at `Docs_Ledgerline/_teaching-doc-prompt.md` because it applies to both sides.

Each frontend explanation covers:

- What the user can do.
- Why the feature exists.
- Which files participate.
- How data moves between components and the API.
- Validation, security, and accounting decisions.
- Tests and verification commands.
- Known limitations and the next day's boundary.

## Acceptance Criteria

- A seeded Owner can create a VAT invoice in the browser.
- Preview totals visibly come from the backend.
- The saved draft reopens with the same inputs and a version number.
- Posting creates a numbered invoice and a balanced journal entry shown side by side.
- A user without `invoice.post` does not see the Post action.
- Trial Balance totals match and show zero difference after posting.
- Switching organizations never shows cached data from the previous organization.
- Day 1–3 backend and frontend explanations are separated into their requested folders.
- Frontend tests, frontend build, both linters, and available backend tests pass.
- No Git commit or push is performed.
