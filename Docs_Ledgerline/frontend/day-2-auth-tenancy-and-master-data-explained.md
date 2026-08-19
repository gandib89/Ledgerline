# Day 2 Frontend Identity, Tenancy, and Master Data — Explained from Zero

## 1. What we built

Day 2 connected the frontend’s authentication screens to the real API flow and made organization context useful. Users could sign in, select an organization, browse the Chart of Accounts, search and paginate customers, and open a validated customer form. The same screens visibly handled loading, empty, and error outcomes.

The accounting term **master data** means relatively stable records used by transactions. Customers and ledger accounts are master data. An invoice later points to these records instead of copying their definitions.

## 2. Why this work was necessary

Before creating invoices, LedgerLine must know:

- which human is signed in;
- which organization that human is acting for;
- which ledger accounts exist in that organization;
- which customers belong to that organization;
- whether submitted customer data has the correct shape.

These checks protect tenant separation and give later financial documents reliable references.

## 3. Architecture and important files

```text
LoginPage
  → AuthContext.login()
    → real /auth/login endpoint
      → user + memberships
        → AppShell organization selection

AccountsPage / CustomersPage
  → useQuery()
    → apiRequest()
      → Authorization header
      → organization header
        → Express auth + tenant middleware
          → tenant-scoped Prisma query
```

| File | Day 2 status | Role |
|---|---|---|
| `frontend/src/pages/LoginPage.jsx` | Modified | Sends credentials through the real authentication context and reports failures. |
| `frontend/src/pages/AccountsPage.jsx` | Created on Day 1; used unchanged on Day 2 | Displays tenant-scoped Chart of Accounts data grouped by account type. |
| `frontend/src/pages/CustomersPage.jsx` | Modified | Implements customer search, paging, creation/editing UI, validation, and query refresh. |
| `shared/party-schema.js` | Created | Defines one customer input contract shared by frontend and backend. |
| `frontend/src/components/AsyncState.jsx` | Created on Day 1; reused on Day 2 | Gives loading, empty, and error outcomes a consistent visible structure. |
| `frontend/src/mocks/handlers.js` | Modified supporting file | Kept browser tests deterministic while real endpoints were being connected. |

**Day 2 frontend commit:** `11fd3361d71f305cbddb82cd8dfdd3de8b044d16` — “Frontend Day 2” on 2026-08-14.

## 4. The code explained from zero

### File: `frontend/src/pages/LoginPage.jsx`

**Status:** Modified

**Purpose:** Renders the login form, holds typed values, calls the shared login function, and shows meaningful feedback.

**Why does this file exist?** Authentication infrastructure needs a human-facing entry point. The page collects credentials but does not itself decide whether they are correct.

**How does it connect to other files?** It obtains `login` from `AuthContext`, uses React Router for navigation, and relies on the API client indirectly.

```jsx
import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/auth-context.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate({ email, password }) {
  const errors = {};
  if (!EMAIL_PATTERN.test(email)) errors.email = 'Enter a valid email address';
  if (password.length < 8) errors.password = 'Password must be at least 8 characters';
  return errors;
}

export function LoginPage() {
  const [fields, setFields] = useState({ email: '', password: '' });
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState('');
  const { login, status } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  function updateField(event) {
    setFields((current) => ({ ...current, [event.target.name]: event.target.value }));
    setErrors((current) => ({ ...current, [event.target.name]: undefined }));
    setServerError('');
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const nextErrors = validate(fields);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;

    try {
      await login(fields);
      navigate(location.state?.from?.pathname ?? '/dashboard', { replace: true });
    } catch (error) {
      setServerError(error.message);
    }
  }

  const busy = status === 'authenticating';

  return (
    <main className="auth-page">
      <section className="auth-story" aria-label="Ledgerline introduction">
        <Link className="brand brand-on-dark" to="/login" aria-label="Ledgerline home">
          <span className="brand-mark" aria-hidden="true">L</span>
          <span>Ledgerline</span>
        </Link>
        <div className="auth-story-copy">
          <p className="eyebrow">Financial clarity, line by line</p>
          <p className="auth-story-title">Your books should explain themselves.</p>
          <p>
            Every invoice, receipt, and bank movement resolves into one immutable ledger—ready
            for review, reconciliation, and reporting.
          </p>
        </div>
        <div className="ledger-preview" aria-hidden="true">
          <span>INV-2082-0001</span>
          <strong>Dr = Cr</strong>
          <span>NPR 113,000.00</span>
        </div>
      </section>

      <section className="auth-panel">
        <div className="auth-card">
          <p className="eyebrow">Secure workspace</p>
          <h1>Welcome back</h1>
          <p className="auth-intro">Sign in to continue to your organizations and ledgers.</p>

          {serverError && <div className="form-alert" role="alert">{serverError}</div>}

          <form className="auth-form" onSubmit={handleSubmit} noValidate>
            <label htmlFor="login-email">Email address</label>
            <input
              id="login-email"
              name="email"
              type="email"
              autoComplete="email"
              value={fields.email}
              onChange={updateField}
              aria-invalid={Boolean(errors.email)}
              aria-describedby={errors.email ? 'login-email-error' : undefined}
            />
            {errors.email && <p className="field-error" id="login-email-error">{errors.email}</p>}

            <label htmlFor="login-password">Password</label>
            <input
              id="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={fields.password}
              onChange={updateField}
              aria-invalid={Boolean(errors.password)}
              aria-describedby={errors.password ? 'login-password-error' : undefined}
            />
            {errors.password && (
              <p className="field-error" id="login-password-error">{errors.password}</p>
            )}

            <button className="primary-button" type="submit" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <div className="demo-credentials">
            <span>Demo access</span>
            <code>sunita@annapurnatrading.com.np</code>
            <code>Demo@2026</code>
          </div>

          <p className="auth-switch">
            New to Ledgerline? <Link to="/register">Create an account</Link>
          </p>
        </div>
      </section>
    </main>
  );
}
```

Important concepts:

- A controlled input gets its visible value from React state and sends every change back through `onChange`.
- An event handler is a callback React runs after an action such as form submission.
- `event.preventDefault()` stops the browser from reloading the page for a normal HTML form submission.
- `try/catch/finally` handles success, failure, and cleanup. `finally` runs whether the request succeeds or fails.
- A disabled submit button prevents accidental double submission while login is pending.

Function flow for the submit handler:

- **Data in:** the form event plus email/password held in state.
- **Processing:** prevent browser reload, clear old errors, mark pending, await `login`, then navigate.
- **Data out:** either a route change or an error message.
- **Who calls it:** the HTML form through `onSubmit`.
- **What it calls:** `login`, error state setters, and React Router navigation.

Runtime:

1. The user submits the form.
2. `LoginPage` calls the context’s `login`.
3. The API client sends credentials to Express.
4. The backend checks the password and issues session credentials.
5. The context loads memberships.
6. The page navigates into the protected application.
7. On failure, the page remains visible and announces the server message.

### File: `frontend/src/pages/AccountsPage.jsx`

**Status:** Created on Day 1; used unchanged and verified on Day 2

```jsx
import { useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { AsyncState } from '../components/AsyncState.jsx';
import { apiRequest } from '../lib/api-client.js';

// Balance-sheet accounts first, then P&L — the order every accountant expects
// to read a chart of accounts in.
const TYPE_ORDER = [
  ['ASSET', 'Assets'],
  ['LIABILITY', 'Liabilities'],
  ['EQUITY', 'Equity'],
  ['REVENUE', 'Revenue'],
  ['EXPENSE', 'Expenses'],
];

export function AccountsPage() {
  const { activeOrganizationId } = useOutletContext();
  const accounts = useQuery({
    // The org id is part of the key so switching orgs refetches rather than
    // showing the previous tenant's chart from cache.
    queryKey: ['accounts', activeOrganizationId],
    queryFn: () => apiRequest('/accounts'),
    enabled: Boolean(activeOrganizationId),
  });

  return (
    <div className="accounts-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Masters</p>
          <h1>Chart of accounts</h1>
          <p>Every ledger posting lands in one of these accounts.</p>
        </div>
      </div>

      {!activeOrganizationId || accounts.isPending ? (
        <AsyncState title="Loading accounts" message="Fetching this organization's chart of accounts." />
      ) : accounts.isError ? (
        <AsyncState title="Accounts unavailable" message={accounts.error.message} />
      ) : accounts.data.length === 0 ? (
        <AsyncState title="No accounts yet" message="This organization has no chart of accounts." />
      ) : (
        TYPE_ORDER.map(([type, label]) => {
          const group = accounts.data.filter((account) => account.type === type);
          if (group.length === 0) return null;

          return (
            <section className="account-group" key={type}>
              <h2>{label}</h2>
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Code</th>
                    <th scope="col">Name</th>
                    <th scope="col">Flags</th>
                  </tr>
                </thead>
                <tbody>
                  {group.map((account) => (
                    <tr key={account.id}>
                      <td className="numeric">{account.code}</td>
                      <td>{account.name}</td>
                      <td>
                        {/* A control account is reconciled against a subledger,
                            so manual journals into it are blocked server-side. */}
                        {account.isControlAccount && <span className="badge badge-control">Control</span>}
                        {account.isBankAccount && <span className="badge badge-bank">Bank</span>}
                        {!account.isActive && <span className="badge">Inactive</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          );
        })
      )}
    </div>
  );
}
```

**Purpose:** Displays the active organization’s Chart of Accounts in accounting groups.

**Why does this file exist?** Journal entries do not post to arbitrary text labels. They post to defined accounts such as Cash, Accounts Receivable, Sales Revenue, and Bank Charges.

**How does it connect to other files?** It reads the active organization from the route context, queries `/accounts`, uses `AsyncState`, and renders account flags returned by the API.

Important concepts:

- `useQuery` connects a unique cache key to an asynchronous request function.
- The query key includes `activeOrganizationId`. That prevents two organizations from intentionally sharing the same cache entry.
- `enabled` delays the request until an organization exists.
- `reduce` transforms a list into another structure. Here it groups accounts by type.
- Optional chaining safely accesses results that may not have arrived.
- Badges communicate special controls such as bank accounts and control accounts.

Data flow:

- **Data in:** active organization ID and `GET /accounts` response.
- **Processing:** group accounts by type and map each group into UI rows.
- **Data out:** an organized account tree.
- **Who calls it:** React Router through `App.jsx`.
- **What it calls:** TanStack Query, `apiRequest`, and `AsyncState`.

Runtime:

1. Organization selection becomes available.
2. TanStack Query checks its organization-specific cache key.
3. Missing/stale data triggers `GET /accounts`.
4. The backend verifies membership and filters by organization.
5. Accounts return to the browser.
6. The page groups and renders them.
7. Loading, failure, and zero-account results use explicit states.

### File: `frontend/src/pages/CustomersPage.jsx`

**Status:** Modified

**Purpose:** Implements the customer list and the create/edit drawer.

**Why does this file exist?** Invoices require real customer records. Search and pagination keep the screen usable as the customer list grows, while validation prevents incomplete or malformed data from reaching the API.

**How does it connect to other files?** It consumes the active organization, `apiRequest`, shared `partyInputSchema`, TanStack Query, toast notifications, and `AsyncState`.

```jsx
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { z } from 'zod';
import { AsyncState } from '../components/AsyncState.jsx';
import { apiRequest } from '../lib/api-client.js';
import { useToast } from '../components/toast-context.js';
import { createPartySchemas } from '../../../shared/party-schema.js';

const PAGE_SIZE = 20;

const EMPTY_FORM = { type: 'customer', code: '', name: '', email: '', phone: '', creditDays: 30 };
const { createPartySchema, updatePartySchema } = createPartySchemas(z);

function validationErrors(result) {
  if (result.success) return {};
  return Object.fromEntries(result.error.issues.map((issue) => [issue.path[0], issue.message]));
}

function partyInput(form, editing) {
  const input = {
    type: form.type,
    code: form.code.trim(),
    name: form.name.trim(),
    creditDays: Number(form.creditDays),
  };

  if (editing) {
    input.email = form.email.trim() || null;
    input.phone = form.phone.trim() || null;
  } else {
    if (form.email.trim()) input.email = form.email.trim();
    if (form.phone.trim()) input.phone = form.phone.trim();
  }

  return input;
}

export function CustomersPage() {
  const { activeOrganizationId } = useOutletContext();
  const queryClient = useQueryClient();
  const { notify } = useToast();

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingParty, setEditingParty] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});

  const parties = useQuery({
    queryKey: ['parties', activeOrganizationId, search, page],
    queryFn: () => apiRequest(`/parties?search=${encodeURIComponent(search)}&page=${page}`),
    enabled: Boolean(activeOrganizationId),
  });

  const saveParty = useMutation({
    mutationFn: ({ id, input }) => apiRequest(id ? `/parties/${id}` : '/parties', {
      method: id ? 'PATCH' : 'POST',
      body: input,
    }),
    onSuccess: (party, { id }) => {
      // Invalidate every page/search combination, not just the current one.
      queryClient.invalidateQueries({ queryKey: ['parties'] });
      notify({ title: id ? 'Customer updated' : 'Customer created', message: party.name, tone: 'success' });
      closeDrawer();
    },
    onError: (error, { id }) => {
      notify({ title: id ? 'Could not update customer' : 'Could not create customer', message: error.message, tone: 'error' });
    },
  });

  function closeDrawer() {
    setDrawerOpen(false);
    setEditingParty(null);
    setForm(EMPTY_FORM);
    setErrors({});
  }

  function openNewCustomer() {
    setEditingParty(null);
    setForm(EMPTY_FORM);
    setErrors({});
    setDrawerOpen(true);
  }

  function openEditCustomer(party) {
    setEditingParty(party);
    setForm({
      type: party.type,
      code: party.code,
      name: party.name,
      email: party.email ?? '',
      phone: party.phone ?? '',
      creditDays: party.creditDays,
    });
    setErrors({});
    setDrawerOpen(true);
  }

  function submit(event) {
    event.preventDefault();
    const input = partyInput(form, Boolean(editingParty));
    const schema = editingParty ? updatePartySchema : createPartySchema;
    const parsed = schema.safeParse(input);
    const found = validationErrors(parsed);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    saveParty.mutate({ id: editingParty?.id, input: parsed.data });
  }

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  }

  return (
    <div className="customers-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Masters</p>
          <h1>Customers</h1>
          <p>Everyone you invoice, and the credit terms they trade on.</p>
        </div>
        <button className="primary-button" type="button" onClick={openNewCustomer}>
          New customer
        </button>
      </div>

      <div className="toolbar">
        <label className="search-field">
          <span className="visually-hidden">Search customers</span>
          <input
            type="search"
            placeholder="Search by name"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1); // a new search invalidates the current page number
            }}
          />
        </label>
      </div>

      {!activeOrganizationId || parties.isPending ? (
        <AsyncState title="Loading customers" message="Fetching this organization's customers." />
      ) : parties.isError ? (
        <AsyncState title="Customers unavailable" message={parties.error.message} />
      ) : parties.data.length === 0 ? (
        <AsyncState
          title={search ? 'No matches' : 'No customers yet'}
          message={search ? `Nothing matched “${search}”.` : 'Create your first customer to start invoicing.'}
        />
      ) : (
        <>
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Credit days</th>
                <th scope="col"><span className="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {parties.data.map((party) => (
                <tr key={party.id}>
                  <td className="numeric">{party.code}</td>
                  <td>{party.name}</td>
                  <td>{party.email ?? '—'}</td>
                  <td className="numeric">{party.creditDays}</td>
                  <td className="table-actions">
                    <button
                      className="table-action"
                      type="button"
                      aria-label={`Edit ${party.name}`}
                      onClick={() => openEditCustomer(party)}
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="pagination">
            <button type="button" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </button>
            <span>Page {page}</span>
            {/* The list endpoint returns rows, not a total count, so "next" is
                offered whenever the page came back full. */}
            <button
              type="button"
              disabled={parties.data.length < PAGE_SIZE}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </>
      )}

      {drawerOpen && (
        <div
          className="drawer"
          role="dialog"
          aria-modal="true"
          aria-label={editingParty ? 'Edit customer' : 'New customer'}
        >
          <form className="drawer-panel" onSubmit={submit} noValidate>
            <h2>{editingParty ? 'Edit customer' : 'New customer'}</h2>

            <label>
              Code
              <input autoFocus={!editingParty} value={form.code} onChange={(e) => update('code', e.target.value)} aria-invalid={Boolean(errors.code)} />
              {errors.code && <span className="field-error" role="alert">{errors.code}</span>}
            </label>

            <label>
              Name
              <input autoFocus={Boolean(editingParty)} value={form.name} onChange={(e) => update('name', e.target.value)} aria-invalid={Boolean(errors.name)} />
              {errors.name && <span className="field-error" role="alert">{errors.name}</span>}
            </label>

            <label>
              Email
              <input type="email" value={form.email} onChange={(e) => update('email', e.target.value)} aria-invalid={Boolean(errors.email)} />
              {errors.email && <span className="field-error" role="alert">{errors.email}</span>}
            </label>

            <label>
              Phone
              <input type="tel" value={form.phone} onChange={(e) => update('phone', e.target.value)} />
            </label>

            <label>
              Credit days
              <input
                type="number"
                min="0"
                value={form.creditDays}
                onChange={(e) => update('creditDays', e.target.value)}
                aria-invalid={Boolean(errors.creditDays)}
              />
              {errors.creditDays && <span className="field-error" role="alert">{errors.creditDays}</span>}
            </label>

            <div className="drawer-actions">
              <button className="secondary-button" type="button" onClick={closeDrawer}>
                Cancel
              </button>
              <button className="primary-button" type="submit" disabled={saveParty.isPending}>
                {saveParty.isPending
                  ? (editingParty ? 'Saving…' : 'Creating…')
                  : (editingParty ? 'Save changes' : 'Create customer')}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
```

Important concepts:

- Local state separates search text, current page, selected customer, drawer visibility, and form fields.
- Query parameters such as `?search=Everest&page=1` carry filters to the server.
- A mutation changes server state. `useMutation` provides pending, success, and error lifecycle values.
- Query invalidation marks cached customer data stale after a successful save.
- Object spread creates a new state object without mutating the old one.
- A ternary expression chooses between the create and edit request.
- `safeParse` returns structured validation success/failure rather than throwing.
- Pagination is server-oriented: the browser requests only the current slice instead of downloading every customer.

Function flow for saving a customer:

- **Data in:** controlled form fields.
- **Processing:** normalize and validate input, choose POST or PATCH, send the request, close the drawer, then invalidate customer queries.
- **Data out:** a created/updated customer and refreshed list.
- **Who calls it:** the drawer form.
- **What it calls:** the shared Zod schema, API client, toast system, and query client.

Runtime:

1. The user opens “New customer” or edits an existing row.
2. Fields are placed into controlled inputs.
3. Submission runs shared validation.
4. Invalid data remains in the browser and field errors appear.
5. Valid data is sent to the tenant-scoped party endpoint.
6. The backend validates the same contract and performs the write.
7. The frontend invalidates the list query.
8. A fresh page of customers is fetched and displayed.

### File: `shared/party-schema.js`

**Status:** Created

```jsx
export const PARTY_TYPES = ['customer', 'supplier', 'both'];

export function createPartySchemas(z) {
  const fields = {
    type: z.enum(PARTY_TYPES),
    code: z.string().trim().min(1, 'Code is required'),
    name: z.string().trim().min(1, 'Name is required'),
    email: z.string().trim().email('Enter a valid email').optional(),
    phone: z.string().trim().optional(),
    creditDays: z.number().int().min(0, 'Credit days must be 0 or more').optional(),
  };

  const createPartySchema = z.object(fields).strict();
  const updatePartySchema = z.object({
    type: fields.type.optional(),
    code: fields.code.optional(),
    name: fields.name.optional(),
    email: fields.email.nullable(),
    phone: fields.phone.nullable(),
    creditDays: fields.creditDays,
    isActive: z.boolean().optional(),
  }).strict().refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field is required',
  });

  return { createPartySchema, updatePartySchema };
}
```

**Purpose:** Defines the accepted shape for customer input.

**Why does this file exist?** If the frontend and backend maintain different validation rules, a form can appear valid but be rejected after submission. A shared schema makes the contract explicit.

**How does it connect to other files?** `CustomersPage` uses it for immediate feedback. The backend masters route uses the same exported schema before writing with Prisma.

Important concepts:

- Zod is a runtime validation library. TypeScript-like expectations alone disappear at runtime; Zod actually checks received values.
- `.strict()` rejects unexpected keys instead of silently accepting them.
- `.trim()` removes surrounding whitespace.
- `.min()` and `.max()` enforce text length.
- `.int()` ensures a number has no fraction.
- `.optional()` permits omission.
- `.default()` supplies a value when one is absent.

Data flow:

- **Data in:** a plain JavaScript object from the form or HTTP request.
- **Processing:** Zod validates each property and rejects unknown fields.
- **Data out:** normalized safe data or structured errors.
- **Who calls it:** frontend customer form and backend route.
- **What it calls:** Zod validators.

### File: `frontend/src/components/AsyncState.jsx`

**Status:** Created on Day 1; reused on Day 2

```jsx
export function AsyncState({ title, message, action }) {
  return (
    <div className="async-state" role="status">
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

**Purpose:** Provides a reusable visual pattern for work that is loading, missing, or unsuccessful.

**Why does this file exist?** A blank area leaves a beginner wondering whether the page is broken. Explicit states explain what the application is doing.

**How does it connect to other files?** Accounts and customers render it based on TanStack Query’s `isPending`, `isError`, and empty result states.

## 5. Complete request and runtime flows

### Tenant-scoped account read

```text
AccountsPage
  → useQuery(["accounts", activeOrganizationId])
    → apiRequest("/accounts")
      → access-token header
      → organization header
        → authenticate middleware
          → resolveTenant middleware
            → permission check
              → Prisma query with organizationId
                → PostgreSQL
                  → JSON response
                    → grouped account UI
```

### Customer creation

```text
Customer drawer
  → shared Zod validation
    → POST /parties
      → authentication
      → tenant resolution
      → backend Zod validation
      → Prisma insert scoped to organization
        → success response
          → query invalidation
            → refreshed customer list
```

### Organization switching

```text
AppShell selector changes organization
  → activeOrganizationId changes
    → query keys change
      → old tenant result is not used for new tenant
        → new API request carries new organization header
          → backend verifies membership again
```

## 6. New concepts introduced

- **Master data:** Stable records, such as customers and accounts, referenced by transactions.
- **Chart of Accounts:** The organized list of accounts allowed in the ledger.
- **Control account:** A General Ledger account whose balance must agree with a supporting subledger, such as Accounts Receivable.
- **Tenant scope:** Restricting data to one organization.
- **Membership:** The database relationship proving a user belongs to an organization.
- **RBAC:** Role-based access control; permissions are associated with roles such as Owner or Accountant.
- **Zod schema:** Executable rules describing accepted data.
- **Client validation:** Early feedback in the browser.
- **Server validation:** The authoritative check because browser requests can be forged.
- **Query key:** The identity of cached server data.
- **Mutation:** A request that changes server state.
- **Invalidation:** Marking cached data stale so it is fetched again.
- **Pagination:** Loading one limited page of a larger dataset.
- **Drawer:** A side panel used for focused create/edit work without leaving the list.

## 7. Errors and debugging

### Problem: frontend and backend validation could drift

**What happened:** Customer fields existed on both sides of the API. Separate rules could disagree.

**Why it happened:** Duplicated validation naturally changes at different times.

**Diagnosis:** Day 2 added a contract test and moved customer input rules into `shared/party-schema.js`.

**Fix:** Both layers import the same strict Zod schema.

**Lesson:** Share the contract when both runtimes can safely consume it, but keep server validation even when the browser already validates.

### Problem: stale tenant data could remain visible

**What happened:** Cached queries can outlive one organization selection.

**Why it happened:** Caches identify data by their query keys. A key without tenant identity can represent two different organizations incorrectly.

**Fix:** Organization IDs are included in query keys, and switching invalidates relevant queries.

**Lesson:** Multi-tenant isolation is not only a database concern. The browser cache must also understand tenant identity.

No preserved Day 2 terminal error output identifies another specific failure, so no error message is fabricated here.

## 8. Final understanding check

### On what we built

1. Why must customers exist before invoices can reference them?
2. Why does the account screen group accounts by type?
3. Why does the customer form use a drawer instead of embedding all fields in every row?

### On security reasoning

1. Why can the organization header not be trusted without a membership check?
2. Why must the backend validate a customer even after frontend validation succeeds?
3. What could leak if the tenant ID were missing from a query key?

### On architecture

1. Why is `partyInputSchema` stored in `shared`?
2. What is the responsibility difference between `CustomersPage` and the backend parties route?
3. Why does `AsyncState` belong in a reusable component?

### On request lifecycle

1. Trace a customer save from button click to refreshed list.
2. What prevents `AccountsPage` from querying before an organization is active?
3. What happens to cached queries when the organization changes?

### On debugging

1. How would you recognize frontend/backend validation drift?
2. Why is a blank page a poor loading state?
3. Which two layers protect tenant-specific account reads?

## 9. Verification and deferred work

The Day 2 frontend commit added customer contract tests, page tests, authentication-page tests, and backend isolation/permission coverage related to the delivered flow.

Deferred according to the plan:

- Invoice creation and posting were Day 3 work.
- Payments and receivable aging were Day 4 work.
- Bank imports and reconciliation were Day 5 work.
- Audit viewing and cross-app accessibility hardening were Day 6 work.
