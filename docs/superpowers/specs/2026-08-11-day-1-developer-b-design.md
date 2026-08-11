# Ledgerline Day 1 Developer B Design

## Purpose

Complete the frontend foundation assigned to Developer B in the seven-day plan. The result is a runnable, tested React application that can support Day 2 feature work without waiting for unfinished backend authentication or tenant endpoints.

## Product direction

Ledgerline will use a modern premium-fintech visual language while remaining conservative where financial accuracy matters. The interface will use deep navy and warm off-white surfaces, emerald for healthy financial states, restrained cyan for interaction, tabular numerals for money, crisp borders, and subtle motion. It will avoid decorative gradients, glass-heavy cards, and generic starter-page patterns.

The first-day UI includes polished login and registration screens plus a responsive authenticated shell. The shell contains a sidebar, top bar, organization switcher, protected routing, toast notifications, and a small foundation dashboard. Accounting feature screens remain outside this scope.

## Technical decisions

- Keep the existing React 19, Vite 8, and Tailwind 4 setup. Downgrading React provides no Day 1 benefit.
- Use React Router for public and protected routes.
- Use TanStack Query for server-state ownership and cache invalidation.
- Use MSW only in development and tests so frontend work can continue against stable mock contracts.
- Do not add a component library. The required interface is small enough for focused React components and Tailwind/CSS tokens.
- Keep access tokens in memory. Treat refresh as a single deduplicated promise so simultaneous `401` responses do not create multiple refresh calls.
- Keep the active organization in memory and send it through `X-Organization-Id`; changing organizations invalidates all cached queries.
- Generate an `Idempotency-Key` for mutations when the caller did not provide one.
- Accept monetary values as decimal strings. The `<Money>` component never accepts a JavaScript number and renders NPR with tabular numerals.

## Components and responsibilities

- `src/lib/api-client.js`: request construction, headers, error-envelope parsing, refresh retry, and runtime auth/organization state.
- `src/lib/money.js`: validates and formats decimal strings without doing accounting arithmetic.
- `src/components/Money.jsx`: accessible NPR presentation with tabular numerals.
- `src/auth/AuthContext.jsx`: session state and login, register, and logout actions.
- `src/components/AppShell.jsx`: responsive navigation, top bar, organization switcher, and content outlet.
- `src/components/ProtectedRoute.jsx`: redirects unauthenticated visitors to login while preserving the intended destination.
- `src/components/ToastProvider.jsx`: small application-level notification queue.
- `src/pages/LoginPage.jsx` and `src/pages/RegisterPage.jsx`: validated authentication forms with loading and API-error states.
- `src/pages/DashboardPage.jsx`: minimal authenticated landing screen demonstrating the shell and money presentation.
- `src/mocks/handlers.js` and `src/mocks/browser.js`: deterministic authentication, organization, and dashboard mock endpoints.
- `src/test/`: shared test setup and behavior-focused tests.

## Data flow

At startup, the app creates one Query Client, starts MSW in development, and renders the router inside query, authentication, and toast providers. Public authentication actions call the central API client. Successful responses place the access token in memory and navigate to the protected dashboard. The shell fetches organization memberships through TanStack Query; choosing an organization updates the API client and invalidates cached queries.

For an authenticated request, the API client adds the bearer token and active organization header. A mutation also receives an idempotency key. If the server returns `401`, one shared refresh request obtains a replacement access token and the original request is attempted once more. Further failure becomes a normalized `ApiError` containing the server error code, message, request ID, and HTTP status.

## Error and accessibility behavior

- Forms display field-level validation and a visible submission error.
- Buttons expose loading and disabled states without changing their labels unpredictably.
- Keyboard focus is always visible.
- Navigation has an accessible mobile toggle and semantic labels.
- Status is not communicated by color alone.
- Reduced-motion preferences disable nonessential transitions.
- Empty, loading, and failure states use one reusable presentation pattern.

## Testing strategy

Use Vitest, React Testing Library, and MSW. Tests cover:

1. Decimal-string validation and NPR formatting.
2. API headers and automatic idempotency keys.
3. Deduplicated refresh followed by one request retry.
4. Login validation and successful navigation.
5. Protected-route redirection.
6. Organization switching and query invalidation.

The implementation follows red-green-refactor: each behavior test must fail for the expected missing behavior before its production code is added.

## Deliverables

- A runnable frontend with login, registration, protected shell, organization switcher, toast system, and foundation dashboard.
- Configured TanStack Query and MSW development mocks.
- A tested central API client and string-only money component.
- Passing frontend tests, lint, and production build.
- `docs/day-1-developer-b-work-report.md`, containing the completed checklist, important files, commands, verification results, and remaining Day 2 integration notes.

## Explicit boundaries

This work does not implement real backend authentication, customers, accounts, invoices, or accounting logic. Those belong to later days. The Day 1 mocks use the agreed frontend shapes and can be replaced with real endpoints without restructuring the UI.
