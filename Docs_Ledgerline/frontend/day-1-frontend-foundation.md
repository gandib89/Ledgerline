# Day 1 Frontend — The Application Foundation

## What Day 1 Built

Day 1 created the safe base that every LedgerLine screen uses. It did not try to build all accounting
features immediately. It established the browser application, its visual language, its connection to
the backend, and reusable ways to display money, loading states, errors, and notifications.

In simple terms, Day 1 built the building, wiring, and reception desk before adding the accounting rooms.

## Why This Work Was Necessary

Accounting screens repeatedly need the same basics:

- A predictable place for pages and navigation.
- A single safe way to call the API.
- Exact NPR formatting without changing decimal values into unreliable floating-point calculations.
- Consistent loading, empty, and error messages.
- A test environment that can imitate the backend while frontend work continues.
- Keyboard focus, readable contrast, mobile layout, and reduced-motion support.

Building those once prevents each later page from inventing a different solution.

## Main Files and Their Jobs

| File | Job |
| --- | --- |
| `frontend/src/main.jsx` | Starts React and installs the router, query cache, authentication, and toast providers. |
| `frontend/src/App.jsx` | Maps browser URLs to LedgerLine pages. |
| `frontend/src/components/AppShell.jsx` | Provides the sidebar, organization selector, top bar, and page outlet. |
| `frontend/src/lib/api-client.js` | Adds authentication, organization identity, JSON handling, idempotency keys, token refresh, and normalized API errors. |
| `frontend/src/query-client.js` | Configures server-data caching with TanStack Query. |
| `frontend/src/components/Money.jsx` | Displays decimal strings as NPR currency. |
| `frontend/src/components/AsyncState.jsx` | Displays consistent loading, empty, and unavailable states. |
| `frontend/src/components/ToastProvider.jsx` | Displays short success and error notifications. |
| `frontend/src/mocks/handlers.js` | Imitates backend responses for local browser development and tests. |
| `frontend/src/index.css` | Defines LedgerLine's warm, premium fintech visual system and responsive behavior. |

## How a Page Reaches the Backend

1. A page calls `apiRequest('/some-route')`.
2. The API client adds the access token when the user is signed in.
3. It adds `X-Organization-Id` when an organization is active.
4. It adds an idempotency key to write requests so accidental retries do not duplicate money actions.
5. It sends and reads JSON.
6. If the access token expired, it tries the secure refresh-cookie flow once and repeats the request.
7. A failed response becomes one consistent `ApiError` that every page can display.

This exists so pages focus on their business job instead of repeating security and networking code.

## Why Money Stays a String

The backend returns amounts such as `"113000.00"`. The frontend passes that string to `Money`, which
formats it as `NPR 113,000.00` for people. It does not use ordinary JavaScript decimal arithmetic to
decide accounting totals. This avoids familiar computer-number errors and keeps the backend as the
financial source of truth.

## Visual and Accessibility Decisions

- Warm off-white surfaces reduce glare during long bookkeeping sessions.
- Deep emerald communicates trust without looking like a generic blue admin template.
- Tabular numerals make money columns line up.
- Every interactive control keeps a visible keyboard focus state.
- Important buttons meet a comfortable touch size.
- Layouts collapse for phones instead of forcing horizontal page scrolling.
- Reduced-motion preferences shorten animations automatically.
- Status meaning is written in text and never communicated by color alone.

## How Day 1 Is Tested

From `frontend/`:

```powershell
npm run lint
npm test
npm run build
```

The tests cover the API client, money formatting, query-client behavior, main route rendering, app
shell behavior, and reusable components. MSW intercepts HTTP requests so tests exercise real page and
API-client behavior without needing a running backend.

## Day 1 Boundary

Day 1 deliberately stopped at the reusable foundation. Login, organization switching, master data,
invoices, and reports use this foundation in later days.
