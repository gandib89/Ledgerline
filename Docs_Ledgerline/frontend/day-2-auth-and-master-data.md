# Day 2 Frontend — Sign-In, Organizations, Accounts, and Customers

## What Day 2 Built

Day 2 turned the Day 1 shell into a usable multi-organization application. A person can register,
sign in, restore a session after reloading, sign out, choose an organization, inspect its chart of
accounts, and create or edit customers.

In simple terms, Day 2 answered three questions: who are you, which company's books are you viewing,
and which accounts and customers belong to those books?

## Why This Work Was Necessary

LedgerLine cannot safely show invoices or reports before it knows the user and organization. The same
invoice identifier or customer name must never reveal another company's data. Accounts and customers
also need to exist before an invoice can choose where revenue goes and who owes the money.

## Main Files and Their Jobs

| File | Job |
| --- | --- |
| `frontend/src/auth/AuthContext.jsx` | Restores, creates, and ends the signed-in session. |
| `frontend/src/components/ProtectedRoute.jsx` | Keeps private pages unavailable until authentication is known. |
| `frontend/src/pages/LoginPage.jsx` | Collects credentials and starts a session. |
| `frontend/src/pages/RegisterPage.jsx` | Creates a new user account. |
| `frontend/src/components/AppShell.jsx` | Loads memberships, chooses the active organization, and clears organization-specific cached data when it changes. |
| `frontend/src/pages/AccountsPage.jsx` | Displays the chart of accounts grouped as Assets, Liabilities, Equity, Revenue, and Expenses. |
| `frontend/src/pages/CustomersPage.jsx` | Lists, searches, creates, and edits customer master data. |
| `shared/party-schema.js` | Gives the frontend and backend the same customer validation rules. |

## Authentication Flow in Simple Terms

1. The app reloads and does not yet know whether a secure refresh cookie exists.
2. `AuthContext` calls `/auth/refresh` once.
3. A valid cookie returns a short-lived access token and user details.
4. The access token stays in browser memory instead of permanent local storage.
5. `ProtectedRoute` opens the private app only after authentication succeeds.
6. Signing out revokes the refresh-token family, clears local API state, and returns to login.

The refresh attempt is guarded because React development mode can run effects twice. Sending the same
rotating refresh token twice could look like token theft and revoke the session.

## Organization Switching

`AppShell` loads `/orgs` and places the selected organization ID into every tenant request through the
API client. When the user changes the organization:

1. The active `X-Organization-Id` changes.
2. TanStack Query invalidates cached server data.
3. Pages refetch accounts, customers, and later accounting documents for the new organization.
4. A toast confirms which books are now open.

Organization IDs are also part of query keys. That prevents the previous company's cached data from
briefly appearing while the new request is loading.

## Chart of Accounts

`AccountsPage` loads `/accounts`, groups rows in familiar accounting order, and identifies special
accounts:

- A control account is maintained by a subledger, so direct manual posting may be blocked.
- A bank account will later participate in statement matching and reconciliation.
- An inactive account remains visible as historical master data but should not be selected for new work.

This screen exists so users understand where later invoice and payment journal lines will land.

## Customer Master Data

`CustomersPage` loads `/parties`, supports name search and pagination, and uses one drawer for creating
or editing a customer. Zod validates required code/name, email format, party type, and credit days before
the request. Backend validation and authorization still run because browser validation is only a user
experience improvement, not a security boundary.

After a successful write, all customer query variations are invalidated. That refreshes every search
and page instead of leaving an old customer name in the cache.

## Security Decisions

- The browser never decides whether an API action is truly allowed; backend RBAC is authoritative.
- Every private accounting request carries the active organization ID.
- Access tokens stay in memory and refresh tokens stay in httpOnly cookies.
- Write requests use idempotency keys.
- API errors are normalized before pages display them.
- Shared customer validation reduces disagreement between frontend and backend.

## How Day 2 Is Tested

From `frontend/`:

```powershell
npm run lint
npm test -- src/pages/auth-pages.test.jsx src/pages/master-pages.test.jsx src/components/app-shell.test.jsx
npm run build
```

Tests exercise real forms and page components through MSW. They cover sign-in behavior, organization
switching, account grouping, customer validation, customer editing, cache refresh, and accessible mobile
navigation.

## Day 2 Boundary

Day 2 prepared identity, tenant context, accounts, and customers. It did not create invoices or ledger
reports. Day 3 combines these master records with the backend posting engine.
