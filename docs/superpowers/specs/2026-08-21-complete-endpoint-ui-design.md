# Complete Endpoint UI Design

## Goal

Expose every Ledgerline business endpoint through a usable, permission-aware frontend flow while preserving the existing React architecture and visual system.

## Architecture

The existing protected application shell remains the owner of authentication and active-organization state. New UI is grouped by user intent instead of creating one page per endpoint:

- `SettingsPage` covers organization creation, members, chart-of-account creation, fiscal years, period locks, and bank-account setup.
- `JournalEntriesPage` covers journal listing, detail, manual posting, and reversal.
- `CreditNotePage` and `CreditNoteDetailPage` cover invoice corrections.
- `ReceiptDetailPage` provides a permanent view of a posted receipt.
- `OrganizationCreator` is reused by Settings and first-run onboarding.

TanStack Query owns server state. Every mutation invalidates the smallest relevant query families and provides toast feedback. Existing `apiRequest`, `AsyncState`, `Money`, controlled form, permission, and responsive patterns are reused. No new frontend dependency is introduced.

## Backend support

Member creation requires a role UUID, but the existing API does not expose available roles. Add tenant-authenticated `GET /api/v1/roles`, authorized by `org.manage`, returning `{ id, name }` records. The Settings role selector consumes it. This new endpoint is itself represented in the UI.

## User flows

### Organization onboarding

A registered user with no memberships sees a first-organization form instead of a dead dashboard. Creating an organization refreshes `/orgs`, selects the new organization, and unlocks the normal shell. Existing users can create another organization in Settings.

### Settings

Settings uses compact sections for organization, team, accounts, fiscal controls, and banking setup. Forms use visible labels, inline validation, permission-aware disabled states, and explicit success/error feedback.

### Journals

The journal workspace lists entries, displays the selected entry's lines, posts a balanced manual journal, and reverses eligible posted entries after a reason and optional reversal date are supplied. Debit and credit totals are displayed before submission.

### Credit notes

Invoice detail exposes an `Issue credit note` action for users with `invoice.post`. The form begins with the invoice's original lines and permits credit quantity adjustment. Successful posting navigates to the permanent credit-note detail, including its journal.

### Receipt detail

The receipt success panel links to a detail route. The detail page displays receipt totals, allocations, and the linked balanced journal entry.

## Error handling and access control

Backend authorization remains authoritative. Frontend permission checks hide or disable destructive financial actions and explain missing permission. Every query has loading, error, and empty states. Mutation errors use the existing toast provider. Financial corrections require confirmation or an explicit reason.

## Testing

Tests are written before production code and must fail because the new behavior is absent. Coverage is grouped around observable flows:

- First organization creation and Settings endpoint calls.
- Manual journal posting and reversal.
- Credit-note creation/detail and receipt detail.
- Navigation and fiscal-year loading.

Final verification runs frontend lint, all frontend tests, production build, backend lint, and the focused backend role-route test. No commit or push is performed.
