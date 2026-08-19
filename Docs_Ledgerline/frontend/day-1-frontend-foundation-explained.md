# Day 1 Frontend Foundation — Explained from Zero

## 1. What we built

Day 1 created the browser application foundation for LedgerLine. A user could open the React application, register or sign in against mock endpoints, remain protected from private pages when signed out, switch between seeded organizations, see the main navigation shell, receive toast messages, and display accounting amounts without turning database decimals into unsafe JavaScript numbers.

This was foundation work. Later invoice, receipt, banking, report, and audit screens all reuse the same application bootstrap, authentication context, API client, organization header, query cache, route guard, shell, and money formatter.

## 2. Why this work was necessary

A frontend is more than individual pages. Every page needs a shared answer to these questions:

- Where is the application started?
- Who is the signed-in user?
- Which organization is currently active?
- How does the browser call the API?
- What happens when an access token expires?
- How are server results cached?
- How are private routes protected?
- How are NPR amounts displayed safely?

Solving these once prevents each later page from inventing a different answer.

## 3. Architecture and important files

```text
index.html
  → main.jsx
    → QueryClientProvider
    → AuthProvider
    → ToastProvider
      → App.jsx routes
        → ProtectedRoute
          → AppShell
            → feature page
              → apiRequest()
                → backend API
```

| File | Day 1 status | Architectural role |
|---|---|---|
| `frontend/src/main.jsx` | Modified | Starts React and installs application-wide providers. |
| `frontend/src/App.jsx` | Modified | Defines public and protected browser routes. |
| `frontend/src/auth/AuthContext.jsx` | Created | Owns the signed-in user, organizations, active tenant, login, registration, logout, and startup refresh. |
| `frontend/src/lib/api-client.js` | Created | Centralizes HTTP requests, tokens, organization headers, mutation idempotency, errors, and one-time token refresh. |
| `frontend/src/components/ProtectedRoute.jsx` | Created | Prevents private pages from rendering before authentication succeeds. |
| `frontend/src/components/AppShell.jsx` | Created | Provides the sidebar, top bar, organization switcher, and page outlet. |
| `frontend/src/query-client.js` | Created | Configures TanStack Query caching and retry behavior. |
| `frontend/src/components/Money.jsx` | Created | Gives every screen one safe way to render money. |
| `frontend/src/lib/money.js` | Created | Converts decimal strings to display text without using floating-point arithmetic. |

**Day 1 commit:** `dbe603f10fb39a91911c03fc1c86485dae1ef4e2` — “Frontend design, Login and registration created, multitenant switching system created” on 2026-08-11.

## 4. The code explained from zero

### File: `frontend/src/main.jsx`

**Status:** Modified

**Purpose:** This is the browser entry point. It finds the HTML element named `root`, creates a React root there, and wraps the application with providers that make query caching, authentication, and toast notifications available everywhere.

**Why does this file exist?** Browsers do not automatically know how to start a React application. This file is the bridge from static `index.html` to the component tree.

**How does it connect to other files?** It imports `App`, `AuthProvider`, `ToastProvider`, and `queryClient`. Every page rendered by `App` becomes a child of those providers.

```jsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { AuthProvider } from './auth/AuthContext.jsx';
import { ToastProvider } from './components/ToastProvider.jsx';
import { createAppQueryClient } from './query-client.js';
import './index.css';

async function enableMocking() {
  if (!import.meta.env.DEV) return;
  const { worker } = await import('./mocks/browser.js');
  await worker.start({ onUnhandledRequest: 'bypass' });
}

function renderApp() {
  const queryClient = createAppQueryClient();
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <ToastProvider>
            <AuthProvider>
              <App />
            </AuthProvider>
          </ToastProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
}

enableMocking().then(renderApp);
```

Key concepts:

- `import` brings exported values from another module into this file.
- `const` creates a name that cannot be reassigned. The object it points to may still manage changing internal state.
- JSX is HTML-like syntax inside JavaScript. React converts it into element objects.
- A provider places shared data into React context so deeply nested components do not need that data passed through every intermediate component.
- `StrictMode` asks React to perform extra development checks. It does not add a visible screen.

Runtime:

1. The browser loads `index.html`.
2. The JavaScript module loads `main.jsx`.
3. React attaches to `#root`.
4. TanStack Query prepares its cache.
5. Authentication startup logic runs.
6. Toast support becomes available.
7. `App` chooses the route matching the URL.

### File: `frontend/src/App.jsx`

**Status:** Modified

**Purpose:** This file is the route table. It maps URLs such as `/login` and `/app/dashboard` to React components.

**Why does this file exist?** Without a central route table, navigation links and browser URLs would not have a dependable destination.

**How does it connect to other files?** Public routes render authentication pages directly. Private routes pass through `ProtectedRoute`, then render inside `AppShell`.

```jsx
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell.jsx';
import { ProtectedRoute } from './components/ProtectedRoute.jsx';
import { DashboardPage } from './pages/DashboardPage.jsx';
import { LoginPage } from './pages/LoginPage.jsx';
import { RegisterPage } from './pages/RegisterPage.jsx';

function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route element={<ProtectedRoute />}>
        <Route element={<AppShell />}>
          <Route path="/dashboard" element={<DashboardPage />} />
        </Route>
      </Route>
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}

export default App;
```

Important concepts:

- An array stores an ordered collection. Route configuration is represented by nested JSX elements instead.
- A component is a function that returns JSX.
- A nested route uses `Outlet` inside the parent shell to show its selected child page.
- The wildcard route catches unknown URLs and redirects them to a known location.

Runtime for `/app/dashboard`:

1. React Router matches the protected `/app` branch.
2. `ProtectedRoute` checks authentication.
3. When allowed, `AppShell` renders.
4. The dashboard child is inserted into the shell’s `Outlet`.
5. Sidebar and page content appear together.

### File: `frontend/src/auth/AuthContext.jsx`

**Status:** Created

**Purpose:** This provider keeps authentication and organization selection in one place.

**Why does this file exist?** Login state is needed by the route guard, API client, shell, and feature pages. Duplicating that state would allow parts of the UI to disagree about who is signed in.

**How does it connect to other files?** It calls `apiRequest`, stores the returned access token through `setAccessToken`, exposes values through `AuthContext`, and clears TanStack Query data when the active organization changes.

```jsx
import { useMemo, useState } from 'react';
import { apiRequest, resetApiClient, setAccessToken } from '../lib/api-client.js';
import { AuthContext } from './auth-context.js';

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState('unauthenticated');

  async function authenticate(path, input) {
    setStatus('authenticating');
    try {
      const session = await apiRequest(path, { method: 'POST', body: input, retryAuth: false });
      setAccessToken(session.accessToken);
      setUser(session.user);
      setStatus('authenticated');
      return session.user;
    } catch (error) {
      setStatus('unauthenticated');
      throw error;
    }
  }

  async function logout() {
    try {
      await apiRequest('/auth/logout', { method: 'POST' });
    } finally {
      resetApiClient();
      setUser(null);
      setStatus('unauthenticated');
    }
  }

  const value = useMemo(
    () => ({
      user,
      status,
      login: (input) => authenticate('/auth/login', input),
      register: (input) => authenticate('/auth/register', input),
      logout,
    }),
    [status, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
```

Important syntax and design:

- `useState` stores values that can change and cause a rerender.
- `useEffect` performs work after rendering. Here it attempts session restoration at startup.
- `async` marks a function that returns a promise.
- `await` pauses that function until a promise settles.
- `try/catch` separates the successful path from failure handling.
- Destructuring such as `{ user, organizations }` extracts named properties from an object.
- The spread syntax `{ ...data }` copies properties into a new object.
- `useMemo` reuses a calculated context object until its dependencies change.
- `activeOrganizationId` is frontend tenant state. It is not proof of authorization; the server still verifies membership.

Function flow for `login(credentials)`:

- **Data in:** email and password.
- **Processing:** POST credentials to `/auth/login`, store the returned access token, then load the user’s session and memberships.
- **Data out:** the login response promise resolves.
- **Who calls it:** `LoginPage`.
- **What it calls:** `apiRequest`, `setAccessToken`, and `loadSession`.

Runtime:

1. The login form calls `login`.
2. The backend validates credentials.
3. The frontend keeps the short-lived access token in memory.
4. `loadSession` fetches the current user and organizations.
5. The first organization becomes active if none was selected.
6. Components consuming the context rerender.

### File: `frontend/src/lib/api-client.js`

**Status:** Created

**Purpose:** This is the one HTTP doorway used by the frontend.

**Why does this file exist?** Authentication headers, organization headers, JSON parsing, refresh behavior, idempotency, and error conversion are security-sensitive cross-cutting rules. Centralizing them prevents one page from forgetting a rule.

**How does it connect to other files?** Pages call `apiRequest`. `AuthContext` supplies token changes. The backend receives the generated headers and returns the standard error envelope.

```jsx
const API_BASE_URL = import.meta.env.VITE_API_URL ?? '/api/v1';
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

let accessToken = null;
let activeOrganizationId = null;
let refreshPromise = null;

export class ApiError extends Error {
  constructor({ code = 'request_failed', message = 'Request failed', requestId = null, status = 500 }) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.requestId = requestId;
    this.status = status;
  }
}

export function setAccessToken(token) {
  accessToken = token || null;
}

export function setActiveOrganization(id) {
  activeOrganizationId = id || null;
}

export function getActiveOrganization() {
  return activeOrganizationId;
}

export function resetApiClient() {
  accessToken = null;
  activeOrganizationId = null;
  refreshPromise = null;
}

function apiUrl(path) {
  return `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

async function readPayload(response) {
  if (response.status === 204) return null;
  const contentType = response.headers.get('Content-Type') ?? '';
  if (!contentType.includes('application/json')) return null;
  return response.json();
}

function toApiError(payload, status) {
  return new ApiError({
    code: payload?.error?.code,
    message: payload?.error?.message,
    requestId: payload?.error?.requestId,
    status,
  });
}

async function refreshAccessToken() {
  if (!refreshPromise) {
    refreshPromise = fetch(apiUrl('/auth/refresh'), {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
      .then(async (response) => {
        const payload = await readPayload(response);
        if (!response.ok) throw toApiError(payload, response.status);
        const token = payload?.data?.accessToken ?? payload?.accessToken;
        if (!token) {
          throw new ApiError({ code: 'invalid_refresh_response', message: 'Unable to restore session' });
        }
        setAccessToken(token);
        return token;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }

  return refreshPromise;
}

export async function apiRequest(
  path,
  { method = 'GET', body, headers: providedHeaders = {}, retryAuth = true } = {},
) {
  const normalizedMethod = method.toUpperCase();
  const isMutation = MUTATION_METHODS.has(normalizedMethod);
  const idempotencyKey =
    providedHeaders['Idempotency-Key'] ??
    providedHeaders['idempotency-key'] ??
    (isMutation ? globalThis.crypto.randomUUID() : null);

  async function execute(canRetry) {
    const headers = new Headers(providedHeaders);
    headers.set('Accept', 'application/json');
    if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
    if (activeOrganizationId) headers.set('X-Organization-Id', activeOrganizationId);
    if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey);

    let requestBody = body;
    if (body !== undefined && !(body instanceof FormData)) {
      headers.set('Content-Type', 'application/json');
      requestBody = JSON.stringify(body);
    }

    const response = await fetch(apiUrl(path), {
      method: normalizedMethod,
      credentials: 'include',
      headers,
      body: requestBody,
    });
    const payload = await readPayload(response);

    if (response.status === 401 && canRetry && accessToken && path !== '/auth/refresh') {
      await refreshAccessToken();
      return execute(false);
    }
    if (!response.ok) throw toApiError(payload, response.status);

    return payload?.data ?? payload;
  }

  return execute(retryAuth);
}
```

Important concepts:

- HTTP methods describe intent: GET reads, POST creates or performs an action, PATCH changes part of a resource.
- The `Authorization: Bearer` header carries the in-memory access token.
- The organization header tells the API which tenant the user wants to operate in. The server must still verify access.
- An idempotency key lets a repeated mutation return the first result instead of creating a duplicate financial action.
- Optional chaining, for example `payload?.error`, safely reads a property when the left side may be null or undefined.
- `??` uses the value on its right only when the left value is null or undefined.
- A closure is a function that remembers surrounding variables. The refresh promise is shared so concurrent 401 responses do not start many refresh requests.
- A promise represents work that completes later.

Function flow for `apiRequest(path, options)`:

- **Data in:** API path, HTTP options, and optional retry state.
- **Processing:** build headers, serialize JSON when needed, attach tokens, send `fetch`, refresh once after a 401, parse the response, and throw `ApiError` for failures.
- **Data out:** parsed response data.
- **Who calls it:** authentication code and every data page.
- **What it calls:** browser `fetch`, token refresh logic, and error parsing.

Runtime for an expired token:

1. A page sends an API request.
2. The backend returns HTTP 401.
3. The client starts or joins one refresh promise.
4. The refresh cookie is sent by the browser.
5. A new access token is stored in memory.
6. The original request is attempted once more.
7. If it still fails, the error is returned rather than creating an infinite loop.

### File: `frontend/src/lib/money.js`

**Status:** Created

**Purpose:** This module validates decimal strings and converts them into consistent NPR display text.

**Why does this file exist?** JavaScript floating-point numbers cannot exactly represent many decimal fractions. Financial values arrive from Prisma as strings so the browser must not casually convert them with `Number` or `parseFloat`.

**How does it connect to other files?** It exports `isDecimalString` and `formatMoney`. The `Money` component calls `formatMoney`, and tests exercise both functions directly.

```jsx
const DECIMAL_PATTERN = /^-?\d+(\.\d{1,4})?$/;

export function isDecimalString(value) {
  return typeof value === 'string' && DECIMAL_PATTERN.test(value);
}

export function formatMoney(value, { currency = 'NPR' } = {}) {
  if (!isDecimalString(value)) {
    throw new TypeError('Money value must be a decimal string');
  }

  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.');
  const paddedFraction = fraction.padEnd(3, '0');
  let cents = BigInt(whole) * 100n + BigInt(paddedFraction.slice(0, 2));

  if (paddedFraction[2] >= '5') {
    cents += 1n;
  }

  const integerPart = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const decimalPart = (cents % 100n).toString().padStart(2, '0');
  const amount = `${integerPart}.${decimalPart}`;

  return `${currency}\u00a0${negative && cents !== 0n ? `(${amount})` : amount}`;
}
```

### File: `frontend/src/components/Money.jsx`

**Status:** Created

**Purpose:** This small React component gives every page one declarative way to display a financial amount.

**Why does this file exist?** Pages should not repeat formatting rules or accidentally display the raw decimal string differently.

**How does it connect to other files?** Feature pages pass a server amount through the `value` prop. The component calls `formatMoney` and returns an accessible `span`.


```jsx
import { formatMoney } from '../lib/money.js';

export function Money({ value, currency = 'NPR', className = '' }) {
  const formatted = formatMoney(value, { currency });

  return (
    <span className={`money ${className}`.trim()} aria-label={formatted}>
      {formatted}
    </span>
  );
}
```

Function flow for `formatMoney`:

- **Data in:** a decimal string and optional currency settings.
- **Processing:** validate the string, separate sign/whole/fraction parts, add thousands separators, pad fractional digits, and use parentheses for negatives.
- **Data out:** display text such as `NPR (1,130.00)`.
- **Who calls it:** `Money`.
- **What it calls:** string and regular-expression methods only.

A regular expression is a text pattern. It verifies that the value looks like a decimal before formatting it. No arithmetic is required just to display the number.

Function flow for `Money({ value, currency, className })`:

- **Data in:** component props containing a decimal string and optional presentation values.
- **Processing:** call `formatMoney`, combine CSS class names, and use the formatted text as visible content and the accessible label.
- **Data out:** one React `span`.
- **Who calls it:** every page with money values.
- **What it calls:** `formatMoney`.

### File: `frontend/src/components/ProtectedRoute.jsx`

**Status:** Created

**Purpose:** This component decides whether protected content, a loading state, or a redirect should render.

**Why does this file exist?** Private pages should not briefly appear while session restoration is unresolved, and signed-out users should not remain on protected routes.

**How does it connect to other files?** It reads `AuthContext`, displays `AsyncState`, returns an `Outlet` for allowed child routes, or returns React Router’s `Navigate`.

```jsx
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/auth-context.js';

export function ProtectedRoute() {
  const { status } = useAuth();
  const location = useLocation();

  if (status !== 'authenticated') {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <Outlet />;
}
```

The ternary operator chooses one of two expressions using `condition ? whenTrue : whenFalse`. Route protection improves the user experience, but the backend remains the real security boundary.

### File: `frontend/src/components/AppShell.jsx`

**Status:** Created

**Purpose:** The shell provides LedgerLine’s permanent navigation and organization context around changing feature pages.

**Why does this file exist?** Repeating navigation and tenant selection inside every page would create inconsistent behavior and duplicated code.

**How does it connect to other files?** It consumes authentication data, uses React Router links, clears cached organization data during switching, and renders child pages through `Outlet`.

```jsx
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/auth-context.js';
import { apiRequest, setActiveOrganization } from '../lib/api-client.js';
import { AsyncState } from './AsyncState.jsx';
import { Icon } from './Icon.jsx';
import { useToast } from './toast-context.js';

const navigation = [
  ['dashboard', 'Dashboard'],
  ['customers', 'Customers'],
  ['invoices', 'Invoices'],
  ['receipts', 'Receipts'],
  ['banking', 'Banking'],
  ['reports', 'Reports'],
  ['audit', 'Audit trail'],
];

export function AppShell() {
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [selectedOrganizationId, setSelectedOrganizationId] = useState('');
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { notify } = useToast();
  const organizations = useQuery({
    queryKey: ['organizations'],
    queryFn: () => apiRequest('/orgs'),
  });
  const activeOrganizationId = selectedOrganizationId || organizations.data?.[0]?.id || '';

  useEffect(() => {
    if (activeOrganizationId) setActiveOrganization(activeOrganizationId);
  }, [activeOrganizationId]);

  async function changeOrganization(event) {
    const id = event.target.value;
    const selected = organizations.data.find((organization) => organization.id === id);
    setSelectedOrganizationId(id);
    setActiveOrganization(id);
    await queryClient.invalidateQueries();
    notify({ title: 'Organization switched', message: selected.name, tone: 'success' });
  }

  async function signOut() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="app-frame">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <aside className={`sidebar ${navigationOpen ? 'sidebar-open' : ''}`}>
        <div className="sidebar-head">
          <NavLink className="brand brand-on-dark" to="/dashboard" onClick={() => setNavigationOpen(false)}>
            <span className="brand-mark" aria-hidden="true">L</span>
            <span>Ledgerline</span>
          </NavLink>
          <button className="icon-button sidebar-close" type="button" aria-label="Close navigation" onClick={() => setNavigationOpen(false)}>
            <Icon name="close" />
          </button>
        </div>

        <div className="workspace-label">Workspace</div>
        <nav className="primary-nav" aria-label="Primary navigation">
          {navigation.map(([icon, label]) => (
            <NavLink
              className={({ isActive }) => `nav-link ${isActive && icon === 'dashboard' ? 'nav-link-active' : ''}`}
              key={label}
              to={icon === 'dashboard' ? '/dashboard' : `/dashboard?module=${icon}`}
              onClick={() => setNavigationOpen(false)}
            >
              <Icon name={icon} />
              <span>{label}</span>
              {icon !== 'dashboard' && <span className="nav-soon">Soon</span>}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-note">
          <span className="status-dot" />
          <div>
            <strong>System ready</strong>
            <span>Frontend foundation</span>
          </div>
        </div>
      </aside>

      {navigationOpen && <button className="sidebar-scrim" type="button" aria-label="Close navigation" onClick={() => setNavigationOpen(false)} />}

      <div className="app-column">
        <header className="topbar">
          <button className="icon-button mobile-menu" type="button" aria-label="Open navigation" aria-expanded={navigationOpen} onClick={() => setNavigationOpen(true)}>
            <Icon name="menu" />
          </button>

          <div className="organization-control">
            <span className="organization-kicker">Viewing books for</span>
            {organizations.isPending && <span className="organization-loading">Loading organizations…</span>}
            {organizations.isError && (
              <AsyncState title="Organizations unavailable" message="Try refreshing this page." />
            )}
            {organizations.data && (
              <select aria-label="Active organization" value={activeOrganizationId} onChange={changeOrganization}>
                {organizations.data.map((organization) => (
                  <option value={organization.id} key={organization.id}>{organization.name}</option>
                ))}
              </select>
            )}
          </div>

          <div className="topbar-meta">
            <span className="fiscal-pill">FY 2082/83</span>
            <div className="user-summary">
              <span className="user-avatar" aria-hidden="true">{user?.name?.slice(0, 1) ?? 'A'}</span>
              <span><strong>{user?.name ?? 'Account user'}</strong><small>{user?.email ?? 'Secure session'}</small></span>
            </div>
            <button className="secondary-button compact" type="button" onClick={signOut}>Sign out</button>
          </div>
        </header>

        <main className="app-content" id="main-content" tabIndex="-1">
          <Outlet context={{ activeOrganizationId }} />
        </main>
      </div>
    </div>
  );
}
```

Important concepts:

- `.map(callback)` transforms each array item into a rendered navigation item.
- A callback is a function passed to another function to run later.
- `className` controls CSS styling.
- `aria-label` supplies an accessible name when an icon alone is not enough.
- Organization switching invalidates cached queries so information from the previous tenant is not left on screen.

### File: `frontend/src/query-client.js`

**Status:** Created

**Purpose:** Creates the application’s single TanStack Query cache and default request behavior.

**Why does this file exist?** All query hooks need one shared client. Creating clients inside pages would divide the cache and make invalidation unreliable.

**How does it connect to other files?** `main.jsx` passes this client to `QueryClientProvider`; feature pages then use it through query and mutation hooks.

```jsx
import { QueryClient } from '@tanstack/react-query';

export function createAppQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
  });
}
```

Function flow for `createAppQueryClient()`:

- **Data in:** no arguments.
- **Processing:** construct a QueryClient with one retry and disabled refetch-on-window-focus.
- **Data out:** configured QueryClient instance.
- **Who calls it:** `main.jsx` during application startup.
- **What it calls:** TanStack Query’s `QueryClient` constructor.

Conservative retries avoid repeatedly sending requests that are unlikely to succeed, while a shared cache prevents unnecessary duplicate reads.

## 5. Complete request and runtime flows

### Sign-in flow

```text
LoginPage
  → AuthContext.login(credentials)
    → apiRequest("/auth/login")
      → backend authentication endpoint
        → response with access token
    → token stored in browser memory
    → loadSession()
      → current user and memberships
    → ProtectedRoute allows /app
      → AppShell renders DashboardPage
```

### Organization-switch flow

```text
AppShell organization selector
  → AuthContext.setActiveOrganizationId()
    → query cache cleared/invalidated
      → next page query
        → apiRequest adds organization header
          → backend verifies membership
            → tenant-specific response
```

### Money-display flow

```text
PostgreSQL NUMERIC
  → Prisma Decimal
    → backend serializes decimal as a string
      → frontend receives "1130.00"
        → <Money value="1130.00" />
          → formatMoney()
            → NPR 1,130.00
```

## 6. New concepts introduced

- **React component:** A JavaScript function that returns a piece of user interface.
- **Context:** A React mechanism for sharing data with many descendants.
- **Provider:** The component that supplies a context value.
- **State:** Data that changes while the application runs.
- **Hook:** A React function such as `useState` or `useEffect` that adds React behavior to a component.
- **Route:** A rule connecting a browser URL to a component.
- **Access token:** A short-lived credential sent with API calls.
- **Refresh cookie:** A longer-lived browser cookie used to obtain a new access token. An HttpOnly cookie cannot be read by application JavaScript.
- **Authentication:** Proving who the user is.
- **Authorization:** Deciding what that authenticated user may do.
- **Multi-tenancy:** One application serving multiple organizations while keeping their data separated.
- **Query cache:** Stored server responses that can be reused until they become stale.
- **Idempotency:** Making a repeated request safe from duplicate effects.
- **Decimal string:** Money represented as text so binary floating-point rounding cannot silently alter it.
- **Mock Service Worker:** A development/test tool that intercepts browser requests and returns controlled responses.

## 7. Errors and debugging

### Problem: Prisma Decimal objects are unsafe UI values

**What happened:** Prisma money fields are Decimal objects on the backend. Sending or rendering their internal object shape can expose values resembling `{s,e,d}` instead of a human-readable amount.

**Why it happened:** Database decimals and JavaScript numbers use different representations.

**Diagnosis:** The team traced the value from PostgreSQL NUMERIC through Prisma and the JSON boundary.

**Fix:** The API contract uses decimal strings, and the frontend accepts strings through `Money` and `formatMoney`.

**Lesson:** Choose the money representation at the system boundary. Do not repair financial formatting independently on every screen.

### Problem: simultaneous 401 responses could trigger several refreshes

**Why it matters:** Several page queries may fail at the same time when one token expires.

**Fix:** The API client shares one refresh promise. Other requests wait for it and retry only once.

**Lesson:** Authentication refresh is application infrastructure, not page-specific logic.

No additional Day 1 runtime error log is preserved in the repository. The report does not invent an error message that was never recorded.

## 8. Final understanding check

### On what we built

1. Why does `main.jsx` wrap `App` with providers?
2. Why should every page use `apiRequest` instead of calling `fetch` differently?
3. Why does `Money` accept a string rather than a JavaScript number?

### On security reasoning

1. Why is `ProtectedRoute` not a replacement for backend authorization?
2. Why is the access token kept in memory while refresh uses a cookie?
3. What data-leak risk appears if query data is not invalidated during an organization switch?

### On architecture

1. Why does authentication state belong in one context?
2. What would become duplicated if `AppShell` did not exist?
3. Why is the organization ID sent on each relevant API request?

### On request lifecycle

1. What happens after the first API request receives a 401?
2. Which component decides whether `/app/dashboard` may render?
3. How does a PostgreSQL decimal become visible NPR text?

### On debugging

1. What symptom would suggest that a Prisma Decimal was not serialized correctly?
2. Why must refresh retry be limited?
3. Which layer should reject an unauthorized organization even when the UI appears correct?

## 9. Verification and deferred work

Day 1 tests covered the application render, authentication pages, API-client behavior, query configuration, app shell, and money formatting. The later feature pages were intentionally deferred:

- Day 2: real auth integration, organization-aware masters, accounts, and customers.
- Day 3: invoices, posting, journal display, and Trial Balance.
- Day 4: receipts, allocations, aging, General Ledger, and dashboard KPIs.
- Day 5: statement import, reconciliation, and financial statements.
- Day 6: audit trail, accessibility hardening, mobile reconciliation, and exact demo seeding.
- Day 7: deployment and presentation work; no separate Day 7 frontend implementation commit currently exists.
