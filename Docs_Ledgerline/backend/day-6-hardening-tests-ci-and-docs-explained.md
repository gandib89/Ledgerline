# Day 6 — Hardening, Property Tests, CI, API Docs, and the RLS Attempt

This document explains everything built in the Day 6 session, from zero. It uses the actual
LedgerLine codebase as the source of truth. Every code block below is copied from a real file in
this repository, and every file path is exact.

Commits:

- `b975e34 — Day 6 backend: env validation, CORS allowlist, Redis rate limiting, log redaction,
  INV-2/INV-4 property tests, golden E2E, CONC-1/2 concurrency tests, CI workflow`
  (23 files changed, 1200 insertions, 27 deletions)
- `5219279 — Day 6: Swagger UI via zod-to-openapi; RLS attempted and reverted with documented
  tradeoff` (9 files changed, 556 insertions, 1 deletion)

One important note before you read further. This session contains a **failure**. We attempted
Postgres Row-Level Security, hit a genuine technical wall, and rolled the application code back.
Section 7.9 documents that attempt in full — what was tried, what broke, how we diagnosed it, and
why stopping was the right call. Nothing is hidden. A session where everything works teaches you
less than a session where something doesn't.

---

## Table of contents

1. [What we built in this session](#1-what-we-built-in-this-session)
2. [How it relates to the 7-day plan](#2-how-it-relates-to-the-7-day-plan)
3. [Files created and modified](#3-files-created-and-modified)
4. [The code explained from zero](#4-the-code-explained-from-zero)
5. [Complete request and runtime flows](#5-complete-request-and-runtime-flows)
6. [New concepts introduced](#6-new-concepts-introduced)
7. [Errors and debugging](#7-errors-and-debugging)
8. [Final understanding check](#8-final-understanding-check)

---

## 1. What we built in this session

### Where we started

At the end of Day 5, LedgerLine could do the entire accounting story end to end: create a customer,
raise an invoice, post it to the ledger, receive a payment, allocate it, issue a credit note,
reverse a mistake, import a bank statement CSV, match statement lines to ledger movements,
reconcile a bank account, and render a Trial Balance, Profit & Loss, Balance Sheet, AR Aging, and
Bank Reconciliation Summary.

That is a lot. But the application was, in a specific sense, *undefended*. Consider what was true
on the morning of Day 6:

- If you started the server without a `JWT_SECRET` environment variable, it started perfectly
  happily. It would then crash on the first login attempt, in production, in front of a user.
- Any website on the internet could make requests to the API from a browser, because CORS was
  configured with a bare `cors()` call that allows every origin.
- An attacker could try ten million passwords against the login endpoint as fast as their network
  allowed. Nothing counted, nothing blocked.
- When an error was logged, the entire error object was printed — including, potentially, a
  password or a token that some future code had attached to it.
- There was no automated verification that any of this worked on any machine except the developer's
  own laptop.
- There was no browsable documentation of the API.

Day 6 is the day none of that is true any more.

### The eight problems we solved

**Problem 1 — The application could boot in a broken state.**

The code read configuration values like this, scattered across four different files:

```js
process.env.JWT_SECRET
```

`process.env` is Node.js's object holding **environment variables** — configuration values passed
into a program from outside it, rather than written in the code. (Why outside? Because a secret key
must never be committed to git, and because the same code must run against a local database in
development and a real one in production.)

The problem is that reading a missing environment variable does not fail. It returns `undefined`.
So a missing `JWT_SECRET` produced a server that started fine, served the homepage fine, and then
threw an unhandled error deep inside the token-signing library the moment somebody logged in.

We built `backend/src/env.js`, which validates the entire configuration once, at startup, and
refuses to let the process start if anything is missing or malformed. A missing secret is now a
loud crash before the server accepts a single request, instead of a mysterious 500 error at the
worst possible moment.

**Problem 2 — Any website could call the API from a browser.**

The old line was `app.use(cors())` — which means "allow requests from every origin on the
internet." We replaced it with an allowlist driven by the `CORS_ORIGINS` environment variable.
Section 4.2 explains what CORS actually is from zero, and why the refresh-token cookie makes the
allowlist mandatory rather than merely advisable.

**Problem 3 — Nothing limited how many requests anyone could make.**

We added Redis-backed rate limiting at four different tiers: a global limit, a much stricter limit
on login and registration, a limit on CSV imports, and a limit on report endpoints. The numbers
come straight from the plan's §9 security checklist.

**Problem 4 — Error logs could leak secrets.**

We built `backend/src/lib/log-redact.js`, which walks an error object and replaces the value of any
property whose *name* looks sensitive (`password`, `secret`, `token`, `authorization`, `cookie`,
`jwt`) with the literal string `[REDACTED]` before it reaches the log.

**Problem 5 — The test suite proved specific examples, not general truths.**

Before Day 6, every accounting test was *example-based*: "post this specific invoice, and check
these specific numbers." That is valuable, but it can only ever prove the cases somebody thought
to write down. We added **property-based tests** (INV-2 and INV-4), which generate *random*
sequences of forty accounting operations and assert that the books balance after every single one.
Section 4.6 explains this technique in depth. The plan calls it "the single best thing to point at
in an interview."

**Problem 6 — Concurrency was designed for but never proven.**

Days 3 to 5 built row-level database locks (`SELECT ... FOR UPDATE`) specifically so that two
simultaneous requests could not both allocate the same money or grab the same invoice number. But
no test ever fired two requests simultaneously, so the locks were an untested assumption. We added
CONC-1 and CONC-2, which use `Promise.all` to fire five and ten genuinely parallel requests.

**Problem 7 — Nothing verified the whole story end to end, or on any other machine.**

We wrote the **golden E2E test** — one test that walks the entire demo from customer to reconciled
bank account to balanced Balance Sheet, asserting every figure to the paisa. And we wrote a
**GitHub Actions** workflow so that this, and every other test, runs automatically on a clean
machine every time code is pushed.

**Problem 8 — The API had no browsable documentation.**

We generated an **OpenAPI** document describing all forty-plus endpoints and served it through
**Swagger UI** at `/api/v1/docs`, so anyone can read and try the API in a browser.

### The one thing we attempted and rolled back

**Postgres Row-Level Security (RLS)** as a second, database-level tenant-isolation layer. Built,
debugged for a long stretch, and then deliberately reverted when a second, undiagnosed failure
surfaced. The database migrations were kept (they are real and harmless); the application wiring
was removed. Section 7.9 is the full post-mortem, and the README carries a permanent writeup.

### Everything created

**Configuration and security** (`backend/src/`)
- `env.js` — validates every environment variable at boot
- `lib/rate-limit.js` — four Redis-backed rate limiters
- `lib/log-redact.js` — strips secrets out of anything being logged
- `.env.example` — a committed template of the required variables (no real secrets)

**Tests** (`backend/src/`)
- `test/invariants.property.test.js` — INV-2 and INV-4, property-based
- `test/golden-e2e.test.js` — the whole demo, asserted to the paisa
- `test/concurrency.test.js` — CONC-1 and CONC-2
- `lib/rate-limit.test.js` — proves the rate-limiting mechanism itself
- `lib/log-redact.test.js` — proves redaction keeps `message`/`stack` and hides secrets
- `openapi.test.js` — proves the docs generate and the UI serves

**API documentation**
- `backend/src/openapi.js` — the OpenAPI document, built from Zod schemas

**Continuous integration**
- `.github/workflows/ci.yml` — backend and frontend jobs on every push and pull request

**Database migrations (kept, currently inert — see section 7.9)**
- `backend/prisma/migrations/20260817120000_enable_row_level_security/migration.sql`
- `backend/prisma/migrations/20260817120500_grant_truncate_to_app_role/migration.sql`

**Editor/tooling**
- `.claude/launch.json` — dev-server launch configuration used to preview the app in a browser

### Everything modified

- `backend/src/app.js` — CORS allowlist, global rate limiter, redacted error logging, Swagger UI
- `backend/src/index.js` — reads the port from validated config
- `backend/src/db/client.js` — reads the database URL from validated config
- `backend/src/lib/auth/tokens.js` — reads the JWT secret from validated config
- `backend/src/routes/auth.js` — validated config, plus the strict auth rate limiter on
  `/register` and `/login`
- `backend/src/routes/banking.js` — CSV import rate limiter on the statement upload route
- `backend/src/routes/reports.js` — report rate limiter on the whole router
- `backend/src/middleware/audit-log.js` — redacted error logging
- `backend/vitest.config.js` — code-coverage configuration
- `backend/package.json` — new dependencies and a `test:coverage` script
- `README.md` — CI badge and the permanent RLS tradeoff writeup
- `.gitignore` — ignore `coverage/`, but do not ignore `.env.example`

### Everything configured

- New environment variables: `CORS_ORIGINS`, `REDIS_URL`, plus explicit `PORT` and `NODE_ENV`
- Redis container started (it was already declared in `docker-compose.yml` since Day 1, but had
  never actually been used until now)
- Two database migrations applied
- Vitest coverage provider installed and wired

---

## 2. How it relates to the 7-day plan

This session is **Day 6 — Hardening, tests, audit, (optional AI)**
(`ledgerline-7-day-plan_1.md`, line 1520).

### The plan's Day 6 goals for Developer A (backend)

> - Complete the test suite to ~70 tests: property tests INV-2 and INV-4, the golden E2E, remaining
>   isolation and permission cases.
> - GitHub Actions: Postgres service, `prisma migrate deploy`, `vitest run --coverage`. Badge in README.
> - Rate limiting, helmet, CORS allowlist, env validation at boot, log redaction.
> - Postgres RLS as the second isolation layer, **if the suite is green by 15:00**.
> - `zod-to-openapi` → Swagger UI at `/api/v1/docs`.

### Plan → What we built → Why it matters

| Plan objective | What we built | Why it matters |
|---|---|---|
| Property tests INV-2 and INV-4 | `test/invariants.property.test.js` | Plan line 1194: "This one test catches an entire class of bugs that unit tests never reach. It is also the single best thing to point at in an interview." |
| The golden E2E | `test/golden-e2e.test.js` | Plan line 1332: "One test, asserted to the paisa, that *is* the demo." It is the single test that proves the whole story holds together. |
| Concurrency cases | `test/concurrency.test.js` | Plan line 1310: "CONC-1 is the test that makes experienced reviewers stop scrolling." The `FOR UPDATE` locks from Days 3–5 were an untested claim until now. |
| GitHub Actions with Postgres + coverage | `.github/workflows/ci.yml`, `vitest.config.js` coverage block | Proves the suite passes on a clean machine, not just on one laptop with one particular database state. |
| Rate limiting | `lib/rate-limit.js` + wiring in `app.js`, `auth.js`, `banking.js`, `reports.js` | Plan line 1124 gives the exact figures. Without it, the login endpoint is a free brute-force target. |
| CORS allowlist | `app.js` | Plan line 1120: "Never `origin: '*'` with credentials — the browser blocks it anyway, and reviewers check." |
| Env validation at boot | `env.js` | Turns a silent late failure into a loud early one. |
| Log redaction | `lib/log-redact.js` | Plan line 1796 lists log redaction as part of "Security engineered for financial data". |
| `zod-to-openapi` → Swagger UI | `openapi.js`, `app.js` | Makes the API self-documenting and testable from a browser. |
| Postgres RLS (conditional) | Migrations kept; app wiring reverted | The plan makes this explicitly conditional ("if the suite is green by 15:00") and demands the tradeoff be written up "either way" (line 104). Section 7.9 and the README do exactly that. |

### What is completed

Every non-conditional item on the Day 6 Developer A list. At the end of this session the suite stood
at **130 tests across 24 files, all passing**, up from 122 at the start. Lint is clean. The CI
workflow, the Swagger UI, and all four rate limiters are live and verified.

> **Note on the current count.** If you run `npm test` today you will see **135 tests across 26
> files**. The extra five come from Developer B's Day 4/5 branch, merged in commit `1eb1e85` right
> after this session — it added `backend/src/lib/accounting/payment-history.test.js` and
> `backend/src/lib/banking/reject-suggestion.test.js`, plus new cases in `routes/banking.test.js`
> and `routes/invoices.test.js`. Those are not Day 6 work; the 130/24 figure is what this session
> itself produced.

### What is intentionally incomplete, and why

**Postgres RLS is not enforced.** The migrations exist and are applied, so the `ledgerline_app`
role and the policies are physically present in the database — but the application still connects
as the table owner, and Postgres table owners bypass RLS by default. So the policies sit inert.
The plan permits this explicitly. Section 7.9 explains the technical wall in full.

**The optional AI extraction feature was not attempted.** The plan gates it behind "only if both
devs are ahead at 12:00" with a hard 18:00 stop and the instruction "If it is not working at 18:00,
delete the branch." The hardening and test work consumed the session, so the gate never opened.
This is the plan working as designed, not a slip.

**The audit trail screen (Developer B's Day 6 item) is not part of this session.** This session
covered the backend track only.

### How this prepares Day 7

Day 7 is deployment, README, architecture diagram, and demo rehearsal. Three Day 6 pieces feed it
directly:

- **CI** means the Day 7 deploy is pushing code that is already known-good on a clean machine.
- **`env.js`** means a misconfigured production environment fails loudly at deploy time, in the
  logs, instead of silently at demo time.
- **The golden E2E test** is the demo script in executable form. If it passes, the demo works.

---

## 3. Files created and modified

### 3.1 Configuration and security

| File | Status | Role |
|---|---|---|
| `backend/src/env.js` | Created | Single source of truth for configuration. Validates and crashes at boot on bad input. |
| `backend/.env.example` | Created | Committed template showing which variables are needed, with no real secrets. |
| `backend/src/lib/rate-limit.js` | Created | Builds and exports four rate limiters sharing one Redis connection. |
| `backend/src/lib/log-redact.js` | Created | Pure function that redacts sensitive keys from any object before logging. |
| `backend/src/app.js` | Modified | Wires the CORS allowlist, the global limiter, redacted logging, and Swagger UI. |

### 3.2 The four small config-consumer changes

These four files each did exactly one thing: stop reading `process.env` directly and read the
validated `env` object instead.

| File | Status | Change |
|---|---|---|
| `backend/src/index.js` | Modified | `env.PORT` instead of `process.env.PORT \|\| 3000` |
| `backend/src/db/client.js` | Modified | `env.DATABASE_URL`; also dropped its own `import 'dotenv/config'` because `env.js` now owns that |
| `backend/src/lib/auth/tokens.js` | Modified | `env.JWT_SECRET` in both `signAccessToken` and `verifyAccessToken` |
| `backend/src/routes/auth.js` | Modified | `env.NODE_ENV` for the cookie's `secure` flag; plus the auth rate limiter |

### 3.3 Rate-limiter wiring

| File | Status | Change |
|---|---|---|
| `backend/src/app.js` | Modified | `app.use(globalLimiter)` — applies to every route |
| `backend/src/routes/auth.js` | Modified | `authLimiter` on `POST /register` and `POST /login` only |
| `backend/src/routes/banking.js` | Modified | `csvImportLimiter` on the statement upload route only |
| `backend/src/routes/reports.js` | Modified | `reportLimiter` on the whole router via `router.use(...)` |

### 3.4 Tests

| File | Status | What it proves |
|---|---|---|
| `backend/src/test/invariants.property.test.js` | Created | INV-2 and INV-4 over random 40-operation sequences |
| `backend/src/test/golden-e2e.test.js` | Created | The whole demo path, every figure asserted exactly |
| `backend/src/test/concurrency.test.js` | Created | CONC-1 (no over-allocation under parallel load), CONC-2 (no duplicate/gapped doc numbers) |
| `backend/src/lib/rate-limit.test.js` | Created | The limiter mechanism blocks the request that exceeds the limit |
| `backend/src/lib/log-redact.test.js` | Created | Redaction hides secrets but keeps `message` and `stack` |
| `backend/src/openapi.test.js` | Created | The OpenAPI document generates correctly and the UI serves HTML |
| `backend/vitest.config.js` | Modified | Coverage provider, reporters, and exclusions |

### 3.5 API documentation

| File | Status | Role |
|---|---|---|
| `backend/src/openapi.js` | Created | Declares every endpoint's shape as Zod schemas and generates an OpenAPI 3.0 document |
| `backend/src/app.js` | Modified | Serves that document through Swagger UI at `/api/v1/docs` |

### 3.6 Continuous integration

| File | Status | Role |
|---|---|---|
| `.github/workflows/ci.yml` | Created | Two jobs — backend (with Postgres and Redis service containers) and frontend |
| `README.md` | Modified | CI status badge, plus the RLS tradeoff section |
| `.gitignore` | Modified | Ignore `coverage/`; explicitly *un*-ignore `.env.example` |

### 3.7 Database migrations (kept, inert)

| File | Status | Role |
|---|---|---|
| `.../20260817120000_enable_row_level_security/migration.sql` | Created | Creates the `ledgerline_app` role and RLS policies on 17 tables |
| `.../20260817120500_grant_truncate_to_app_role/migration.sql` | Created | Grants `TRUNCATE`, which is a separate privilege from `DELETE` |

---

## 4. The code explained from zero

### 4.1 File: `backend/src/env.js`

**Status:** Created

**Purpose:** Read every configuration value the application needs, check that each one is present
and correctly shaped, and make them available as one object. If anything is wrong, crash
immediately rather than starting a broken server.

**Why does this file exist?**

Because `process.env.ANYTHING` returns `undefined` when the variable is missing, and `undefined`
propagates silently. Consider the real failure this prevents. `jwt.sign(payload, secret)` with
`secret === undefined` throws `secretOrPrivateKey must have a value` — but only when somebody
actually logs in. So the sequence in production was: deploy succeeds, health check passes,
monitoring is green, first user tries to log in, 500 error.

**How does it connect to other files?**

Four files import from it: `index.js`, `db/client.js`, `lib/auth/tokens.js`, `routes/auth.js`, plus
`app.js` and `lib/rate-limit.js`. Because JavaScript modules run their top-level code the first
time they are imported, the validation happens automatically the moment any of them loads.

Here is the whole file:

```js
import 'dotenv/config';
import { z } from 'zod';

// Parsed once at import time. A missing/invalid var throws here — at boot,
// before app.listen — instead of surfacing later as an undefined-secret bug
// on the first request that needs it (e.g. JWT_SECRET undefined at sign time).
const schema = z.object({
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Comma-separated list of allowed browser origins, e.g. "http://localhost:5173,https://app.example.com"
  CORS_ORIGINS: z.string().default(''),
  REDIS_URL: z.string().default('redis://localhost:6379'),
});

export const env = schema.parse(process.env);
```

#### Concepts, from zero

**What is a module?** A JavaScript file. Each file is its own private world — variables declared in
one file are invisible to another unless explicitly shared. `import` brings things in; `export`
sends things out.

**What is `import 'dotenv/config'`?** Notice this import has no `{ something }` and no `from`
binding — it imports the module purely for its **side effect**. A side effect is something a piece
of code *does* rather than something it *returns*. This particular module reads the file
`backend/.env` from disk and copies every `KEY=value` line into `process.env`. Without it, the
`.env` file would just be a text file nobody reads.

**What is an environment variable?** A named value handed to a program by the system that starts
it, rather than written inside the program. Two reasons they exist: secrets must not be committed
to git, and the same code must connect to a different database in development than in production.

**What is Zod?** A **schema validation** library. A *schema* is a description of what shape data
should have. Zod lets you write that description in JavaScript, then check real data against it.
LedgerLine already used Zod on every route to validate incoming request bodies; this file reuses
the exact same tool for configuration, which is why no new dependency was needed.

**What is `const`?** A declaration that creates a name bound to a value which cannot be reassigned.
(`let` allows reassignment; `const` does not.) Default to `const`.

**Reading the schema line by line:**

- `z.object({ ... })` — "this should be an object with the following properties."
- `DATABASE_URL: z.string().url()` — must be a string, and that string must look like a URL. This
  is **method chaining**: `z.string()` returns a Zod object, and calling `.url()` on it returns
  another Zod object with an extra rule attached. Each call adds a constraint.
- `JWT_SECRET: z.string().min(32)` — at least 32 characters. This is a real security rule, not
  decoration. The JWT signing algorithm here is HS256, whose security depends on the secret being
  long and unguessable; a short secret can be brute-forced offline.
- `PORT: z.coerce.number().int().positive().default(3000)` — four rules in one chain.
  **`z.coerce`** matters: environment variables are *always strings*, even when they look like
  numbers. `PORT=3000` gives you the string `"3000"`, not the number `3000`. `coerce` converts it.
  Then `.int()` requires a whole number, `.positive()` requires greater than zero, and
  `.default(3000)` means "if this variable is absent entirely, use 3000."
- `NODE_ENV: z.enum([...])` — an **enum** is a fixed list of allowed values. This catches typos:
  `NODE_ENV=prodction` would be accepted by a plain string check and would silently disable the
  secure-cookie flag. Here it crashes instead.
- `CORS_ORIGINS: z.string().default('')` — defaults to empty, meaning no cross-origin browser
  requests allowed. Failing **closed** (deny by default) rather than **open** (allow by default) is
  the correct security posture.

**The last line is the whole mechanism:**

```js
export const env = schema.parse(process.env);
```

`schema.parse(data)` either returns the validated, converted data or **throws** an error. Throwing
means the module fails to load, which means the import fails, which means Node.js exits with the
error printed. There is no `try`/`catch` here **on purpose** — catching the error would let the
program continue in a broken state, which is exactly what we are trying to prevent. The crash *is*
the feature.

Note also that `parse` returns *converted* data: `env.PORT` is a real number, while
`process.env.PORT` was a string.

#### What happens at runtime

1. You run `npm run dev`, which runs `node --watch src/index.js`.
2. Node begins loading `index.js`, sees `import { env } from './env.js'`, and pauses to load
   `env.js` first.
3. `env.js` runs `import 'dotenv/config'`, which reads `backend/.env` into `process.env`.
4. The `schema` object is built.
5. `schema.parse(process.env)` runs.
6. **If everything is valid:** `env` is exported; loading continues; `app.listen` runs; the server
   accepts requests.
7. **If anything is invalid:** Zod throws; the process exits immediately with a message naming the
   offending variable. `app.listen` never runs. No request is ever served by a misconfigured
   server.

---

### 4.2 The CORS allowlist, in `backend/src/app.js`

**Status:** Modified

Here is the code as it now stands:

```js
// Allowlist, not `cors()` wide-open — required anyway since the refresh
// token travels as a credentialed cookie, and CORS forbids `credentials:
// true` paired with a wildcard origin.
const allowedOrigins = env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
app.use(cors({
  origin(origin, callback) {
    // No Origin header = same-origin, curl, server-to-server — allow.
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
```

#### Concepts, from zero

**What is an HTTP request?** When a browser needs something from a server, it sends a text message
over the network containing a **method** (`GET` to fetch, `POST` to create, `PATCH` to modify), a
**path** (`/api/v1/invoices`), a set of **headers** (metadata as name/value pairs), and sometimes a
**body** (the data being sent). The server sends back a **response** containing a **status code**
(200 = success, 404 = not found, 429 = too many requests, 500 = server error), headers, and a body.

**What is an origin?** The combination of scheme, host, and port: `http://localhost:5173` is one
origin; `https://evil.com` is another. Two URLs are the "same origin" only if all three parts match.

**What is CORS?** *Cross-Origin Resource Sharing.* By default, browsers enforce the **same-origin
policy**: JavaScript running on page A may not read responses from server B. This exists to stop a
malicious page reading your bank's API using your logged-in session. CORS is the controlled
exception: server B can send headers saying "actually, page A is allowed to read my responses."

Crucially, **CORS is enforced by the browser, not the server**. A command-line tool like `curl`
ignores it entirely. CORS protects *users browsing the web*, not the server itself. This is why it
sits alongside — never instead of — authentication.

**Why the allowlist is mandatory here, not optional.** LedgerLine stores its refresh token in a
cookie. For a browser to send cookies on a cross-origin request, the server must set
`credentials: true`. And the CORS specification flatly forbids combining `credentials: true` with a
wildcard origin (`*`). A browser will reject that combination outright. So `cors()` with defaults
plus cookie-based refresh is not merely insecure — it does not function.

#### Reading the code

`env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)` — a chain of three array
operations turning one string into a clean list:

- **`.split(',')`** turns `"http://a.com, http://b.com"` into `["http://a.com", " http://b.com"]`.
- **`.map((o) => o.trim())`** builds a *new* array by running a function on each element. `.trim()`
  removes surrounding whitespace, so `" http://b.com"` becomes `"http://b.com"`. Without this, a
  space after a comma in the `.env` file would silently break matching.
- **`.filter(Boolean)`** builds a new array containing only elements that are "truthy". `Boolean`
  used as a function converts a value to `true`/`false`; empty strings become `false` and are
  dropped. This handles a trailing comma or an empty `CORS_ORIGINS`.

**What is an arrow function?** `(o) => o.trim()` is shorthand for a function taking `o` and
returning `o.trim()`. A function passed *into* another function like this is called a **callback**.

**The `origin` function.** Rather than a fixed list, the `cors` library accepts a function it calls
for each request, passing the request's `Origin` header and a `callback` to report the decision.

- `if (!origin || ...)` — `!` means "not". `||` means "or", and it **short-circuits**: if the left
  side is already true, the right side is never evaluated. So a missing `Origin` header is allowed
  immediately. Why allow it? Because browsers only send `Origin` on cross-origin requests. No
  `Origin` header means the request came from the same origin, or from `curl`, or from another
  server — none of which the same-origin policy governs.
- `allowedOrigins.includes(origin)` — exact string match against the allowlist.
- `callback(null, true)` — the **error-first callback** convention: the first argument is an error
  (`null` means no error), the second is the result. So this means "no error, and yes, allow it."
- `callback(new Error('Not allowed by CORS'))` — an error, so deny.

---

### 4.3 File: `backend/src/lib/rate-limit.js`

**Status:** Created

**Purpose:** Create four rate limiters — pieces of middleware that count requests and reject
callers who exceed a threshold — backed by shared Redis storage.

**Why does this file exist?**

Without rate limiting, the login endpoint can be attacked at network speed. Argon2id password
hashing (from Day 2) makes each guess slow, which helps enormously — but "slow" is relative, and
an attacker with a botnet still gets a lot of guesses. Rate limiting caps the attempts regardless.

The whole file:

```js
import { createClient } from 'redis';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { env } from '../env.js';

const redisClient = createClient({ url: env.REDIS_URL });
redisClient.on('error', (err) => console.error('[redis]', err.message));
await redisClient.connect();

function store(prefix) {
  return new RedisStore({
    sendCommand: (...args) => redisClient.sendCommand(args),
    prefix,
  });
}

// Skipped under test: the functional suite fires hundreds of requests from
// one IP inside one Redis-backed window, which would trip these limits and
// fail unrelated tests. The mechanism itself is covered independently in
// rate-limit.test.js, against a throwaway limiter instance.
const shared = { standardHeaders: true, legacyHeaders: false, skip: () => env.NODE_ENV === 'test' };

// §9 checklist figures: global 300/min/IP, auth 5/15min, CSV import
// 10/hour/org, reports 60/min/org. Shared Redis store so limits hold across
// however many API instances end up behind the load balancer.
export const globalLimiter = rateLimit({
  ...shared,
  windowMs: 60 * 1000,
  limit: 300,
  store: store('rl:global:'),
});

export const authLimiter = rateLimit({
  ...shared,
  windowMs: 15 * 60 * 1000,
  limit: 5,
  store: store('rl:auth:'),
  // IP + email: an attacker cycling emails from one IP still hits the IP
  // component, and one cycling IPs against a single victim still hits the
  // email component.
  keyGenerator: (req) => `${ipKeyGenerator(req.ip)}:${req.body?.email || ''}`,
});

export const csvImportLimiter = rateLimit({
  ...shared,
  windowMs: 60 * 60 * 1000,
  limit: 10,
  store: store('rl:csv:'),
  keyGenerator: (req) => req.organizationId,
});

export const reportLimiter = rateLimit({
  ...shared,
  windowMs: 60 * 1000,
  limit: 60,
  store: store('rl:report:'),
  keyGenerator: (req) => req.organizationId,
});
```

#### Concepts, from zero

**What is middleware?** Express (the web framework this project uses) processes a request by
passing it through a chain of functions. Each function receives the request (`req`), the response
being built (`res`), and a function called `next`. It can inspect or modify things, then either
call `next()` to pass control along the chain, or end the request itself by sending a response.

Think of an airport: check-in, security, passport control, boarding. Each stage can wave you
through or stop you. A rate limiter is a stage that counts how many times you have come through
recently and stops you if it is too many.

**What is Redis?** An in-memory data store — essentially a very fast key-value dictionary that
lives in RAM rather than on disk. It has been in this project's `docker-compose.yml` since Day 1,
declared but unused, precisely for this moment.

**Why Redis instead of just counting in the server's memory?** Because of what happens when the
application is deployed at scale. Real deployments run several copies of the API behind a load
balancer that spreads requests across them. If each copy counted in its own memory, an attacker
allowed 5 attempts per server would get 5 × (number of servers). A shared Redis store means all
copies read and write the same counter. Counters in Redis also expire automatically, which is
exactly the behaviour a time-window limit needs.

**What is `await` at the top level of a file?** `await redisClient.connect()` pauses until the
connection is established. Normally `await` is only allowed inside an `async` function, but modern
JavaScript modules allow it at the top level. The effect is that any module importing this file
waits for Redis to be connected before continuing — so no request can reach a limiter whose store
is not ready.

**What is a promise?** An object representing a value that is not available yet. Network operations
return promises. `await` unwraps one: it pauses execution until the promise resolves and gives you
the value. `async` marks a function as one that may contain `await`.

**What is `...args` and `...shared`?** The `...` is **spread/rest syntax**.

- In `(...args) =>`, it is **rest**: collect all arguments into an array named `args`. This lets the
  function accept any number of arguments and pass them along as one array, which is exactly what
  the Redis client's `sendCommand` expects.
- In `{ ...shared, windowMs: ... }`, it is **spread**: copy every property of `shared` into this new
  object, then add more. The four limiters share three settings without repeating them, and each
  adds its own. Order matters — properties written after the spread override the spread ones.

**What is `?.` (optional chaining)?** In `req.body?.email`, the `?.` means: if `req.body` is
`null` or `undefined`, stop and give `undefined` rather than throwing "cannot read property of
undefined." This matters because a malformed request might not have a body at all, and a crash in
the *rate limiter* would be worse than the malformed request itself.

**What is `||` here?** `req.body?.email || ''` — if the left side is falsy (undefined, empty), use
the right side. This guarantees the key is always a valid string.

#### Reading the four limiters

**`store(prefix)`** is a small helper returning a Redis-backed store with a **key prefix**. Since
all four limiters share one Redis database, prefixes (`rl:global:`, `rl:auth:`, …) keep their
counters in separate namespaces. Without prefixes, one caller's global count and auth count would
collide on the same key.

**`shared`** holds three settings:
- `standardHeaders: true` — send the standard `RateLimit-*` response headers telling the client its
  limit, remaining allowance, and reset time. Well-behaved clients can then back off politely.
- `legacyHeaders: false` — do not also send the older `X-RateLimit-*` headers.
- `skip: () => env.NODE_ENV === 'test'` — a function returning `true` to skip enforcement. Under
  test, all limiters are disabled. **This is a deliberate tradeoff and it needs justifying**: the
  functional test suite fires hundreds of requests from one IP within a single window, which would
  trip the limits and fail tests that have nothing to do with rate limiting. The mechanism is
  instead proven independently in `rate-limit.test.js`. The cost is that the *wiring* (is the
  limiter actually attached to the login route?) is not covered by an automated test — that was
  verified manually, and section 7.10 shows it firing for real.

**The four tiers, and why each key is different:**

| Limiter | Window | Limit | Counted per |
|---|---|---|---|
| `globalLimiter` | 1 minute | 300 | IP address |
| `authLimiter` | 15 minutes | 5 | IP + email combined |
| `csvImportLimiter` | 1 hour | 10 | organization |
| `reportLimiter` | 1 minute | 60 | organization |

**What is a `keyGenerator`?** The function deciding *what to count per*. Change the key, change the
meaning of the limit entirely.

The auth limiter's key is the most interesting design decision in this file:

```js
keyGenerator: (req) => `${ipKeyGenerator(req.ip)}:${req.body?.email || ''}`,
```

The backtick syntax is a **template literal** — a string with `${...}` placeholders substituted in.
The key combines IP address and the email being attempted. Consider the two attacks:

- **One attacker, many victims.** They try `alice@x.com`, `bob@x.com`, `carol@x.com` from one IP.
  Different emails mean different keys — so the email half does not stop them. But the IP half is
  identical every time, so the count climbs and they are blocked.
- **Many machines, one victim.** A botnet attacks `alice@x.com` from a thousand IPs. Different IPs
  mean different keys — so the IP half does not stop them. But the email half is identical, so the
  count climbs and they are blocked.

Either half alone leaves a gap. Combined, both attacks are covered.

**Why `ipKeyGenerator(req.ip)` rather than `req.ip` directly?** This is an IPv6 subtlety. Under
IPv6, a single user is often allocated an enormous block of addresses — trivially many for one
attacker to cycle through, defeating a per-address limit. `ipKeyGenerator` normalises an IPv6
address down to its network prefix so that the whole allocated block counts as one caller. Using
`req.ip` raw would leave an IPv6 bypass; the library even warns about this.

**Why do CSV import and reports count per organization, not per IP?** Because these are
*authenticated* endpoints, and the resource being protected is server capacity consumed on behalf
of a tenant. Ten users in one company sharing an office IP should not exhaust each other's
allowance, and one user should not be able to hammer reports from many IPs. `req.organizationId`
is set by the `resolveTenant` middleware (Day 2) — which is why the limiter must run *after*
authentication in the chain, not before.

---

### 4.4 File: `backend/src/lib/log-redact.js`

**Status:** Created

**Purpose:** Take an error about to be written to the log and return a copy with any
sensitive-looking value replaced by `[REDACTED]`.

**Why does this file exist?**

Logs get shipped to third-party services, read by contractors, and pasted into bug reports. A
password or token that reaches a log has effectively leaked. The risk is not that today's code logs
a password — it does not. The risk is that some future code attaches a request body to an error for
debugging, and that body contains a password. This file makes that mistake harmless in advance.

```js
const SENSITIVE_KEY = /password|secret|token|authorization|cookie|jwt/i;

function redact(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redact(val);
  }
  return out;
}

// Error.message/.stack are non-enumerable own props (spread/Object.entries
// skip them, so redact() alone would silently drop them) — pulled out
// explicitly so they still reach the log, while any *other* own prop (status,
// code, or anything future code attaches, e.g. a raw request body) is
// redacted by key name before it does.
export function safeErrorLog(err) {
  const { message, stack, ...rest } = err;
  return { message, stack, ...redact(rest) };
}
```

#### Concepts, from zero

**What is a regular expression?** A pattern for matching text, written between slashes.
`/password|secret|token/i` means "contains `password` **or** `secret` **or** `token`", and the
trailing `i` means case-**i**nsensitive, so `Password` and `JWT` match too. `.test(string)` returns
`true` or `false`.

Note that this matches *substrings*, which is deliberate: `refreshToken`, `jwtSecret`, and
`userPassword` all match, because each contains one of the words.

**What is recursion?** A function that calls itself. `redact` needs it because objects nest: an
error might carry `{ details: { credentials: { password: 'x' } } }`. Every recursive function needs
a **base case** — a condition where it stops calling itself, or it would loop forever.

Reading `redact`:

- `if (value === null || typeof value !== 'object') return value;` — the **base case**. If the
  value is not an object (a string, number, boolean) there is nothing to walk into, so return it
  unchanged. The explicit `null` check exists because of a famous JavaScript quirk:
  `typeof null === 'object'`, even though `null` has no properties. Without the check, the code
  would try to iterate `null` and crash.
- `if (Array.isArray(value)) return value.map(redact);` — arrays are objects too, but need
  different handling: apply `redact` to each element and keep the array shape.
- `Object.entries(value)` — converts `{ a: 1, b: 2 }` into `[['a', 1], ['b', 2]]`, so it can be
  iterated as key/value pairs. `const [key, val] of ...` is **destructuring**: unpack the two-element
  array into two named variables.
- `SENSITIVE_KEY.test(key) ? '[REDACTED]' : redact(val)` — the **ternary operator**:
  `condition ? valueIfTrue : valueIfFalse`. If the *key name* looks sensitive, replace the value;
  otherwise recurse into it.

**The subtle bug this file avoids.** `safeErrorLog` looks like it could have been written as just
`redact(err)`. It cannot, and the reason is worth understanding.

JavaScript properties have a flag called **enumerable**. Most properties you create are enumerable,
meaning loops and spread syntax see them. But `Error.message` and `Error.stack` are
**non-enumerable** — deliberately, so that printing an error does not produce noise. The
consequence is that `Object.entries(err)` and `{ ...err }` both **skip `message` and `stack`
entirely**.

So `redact(err)` alone would have produced a log entry with the status code and error code, but no
message and no stack trace — the two things you actually need for debugging. The fix:

```js
const { message, stack, ...rest } = err;
return { message, stack, ...redact(rest) };
```

This is destructuring with a **rest property**: pull `message` and `stack` out *by name* (which
works regardless of enumerability), and collect everything else into `rest`. Then rebuild: keep the
two named fields as-is, and redact everything else. Both goals are met — full debuggability, no
secret leakage.

The accompanying test in `backend/src/lib/log-redact.test.js` pins exactly this behaviour:

```js
const err = new Error('boom');
err.status = 500;
err.jwtSecret = 'super-secret-value';
err.userPassword = 'hunter2';
err.details = { refreshToken: 'abc123', accountId: 'keep-me' };

const logged = safeErrorLog(err);

expect(logged.message).toBe('boom');
expect(logged.stack).toContain('Error: boom');
expect(logged.status).toBe(500);
expect(logged.jwtSecret).toBe('[REDACTED]');
expect(logged.userPassword).toBe('[REDACTED]');
expect(logged.details.refreshToken).toBe('[REDACTED]');
expect(logged.details.accountId).toBe('keep-me');
```

Read what each assertion proves: `message` and `stack` survive (the non-enumerable fix works);
`status` survives (harmless data is not over-redacted); the two top-level secrets are hidden;
`details.refreshToken` is hidden (recursion works); and `details.accountId` survives (recursion
does not over-redact).

**Where it is used.** Two places, both in error paths:

```js
// backend/src/app.js — the global error handler
app.use((err, req, res, _next) => {
  console.error(`[${req.id}]`, safeErrorLog(err));
```

```js
// backend/src/middleware/audit-log.js
    }).catch((err) => {
      console.error(`[${req.id}] audit log write failed`, safeErrorLog(err));
    });
```

---

### 4.5 The golden E2E test — `backend/src/test/golden-e2e.test.js`

**Status:** Created

**Purpose:** One test that walks the entire product story and asserts every resulting number
exactly.

**Why does this file exist?**

Unit tests prove pieces work. This proves the *pieces work together*. In an accounting system that
distinction is everything: each individual operation can be correct while the totals still fail to
agree, because agreement is a property of the whole system.

It is also the demo, executable. If this test passes, the Day 7 demo works.

#### The scenario

Two invoices for two customers, both with 13% VAT:

| Invoice | Customer | Account | Amount | VAT | Total |
|---|---|---|---:|---:|---:|
| 1 | Himalayan Trek Supplies | 4100 Sales — Goods | 120,000 | 15,600 | 135,600 |
| 2 | Everest Cafe | 4200 Sales — Services | 45,000 | 5,850 | 50,850 |

Then a partial receipt of 100,000 against invoice 1, a full receipt of 50,850 against invoice 2, a
three-row bank statement, and a reconciliation.

#### The posting assertions

```js
const inv1Posted = await request(app).post(`/api/v1/invoices/${inv1.body.id}/post`).set(owner.headers).send();
expect(inv1Posted.status).toBe(200);
expect(inv1Posted.body.invoice.docNo).toMatch(/^INV-2082-\d{4}$/);
const inv1Lines = inv1Posted.body.journalEntry.lines;
expect(inv1Lines.find((l) => l.accountId === arAccount.id).debit).toBe('135600.00');
expect(inv1Lines.find((l) => l.accountId === salesGoods.id).credit).toBe('120000.00');
expect(inv1Lines.find((l) => l.accountId === vatAccount.id).credit).toBe('15600.00');
```

This is **double-entry bookkeeping** asserted directly. One invoice produces three journal lines:
the customer owes the full 135,600 (a **debit** to Accounts Receivable, an asset), of which 120,000
is revenue earned and 15,600 is VAT collected on the government's behalf (both **credits**). Debits
135,600 = credits 135,600. The books balance.

`.toMatch(/^INV-2082-\d{4}$/)` uses a regular expression: `^` = start, `INV-2082-` literally,
`\d{4}` = exactly four digits, `$` = end. This asserts the document-numbering format without
hard-coding which number this particular invoice got.

#### The subledger-equals-ledger assertion (INV-3)

```js
const openInvoices = await prisma.document.findMany({ where: { organizationId: owner.orgId, docType: 'INVOICE', status: { not: 'REVERSED' } } });
const subledgerOutstanding = openInvoices.reduce((t, d) => t + Number(d.outstandingAmount), 0);
expect(subledgerOutstanding.toFixed(2)).toBe('35600.00');
expect(await arGlBalance()).toBe('35600.00'); // INV-3: subledger == GL
```

**What is `.reduce()`?** An array method that collapses many values into one. It takes a function
receiving an accumulator (`t`, the running total) and the current element (`d`), plus a starting
value (`0`). Here it sums every open invoice's outstanding amount.

**Why this assertion is the important one.** These two numbers are computed by completely different
routes. `subledgerOutstanding` sums a column on the `Document` table — the *subledger*, the
customer-by-customer view. `arGlBalance()` runs raw SQL summing debits minus credits on account
1100 in the journal — the *general ledger*, the accounting view.

They must be equal. Invoice 1 has 35,600 left unpaid (135,600 − 100,000); invoice 2 is fully paid.
So both views must say 35,600. If they ever disagree, the system has recorded a payment in one
place but not the other, and the books are wrong. Accountants call this reconciling the subledger
to the control account; the plan calls it "the auditor's test."

#### The report assertions

```js
const tb = await request(app).get('/api/v1/reports/trial-balance').set(owner.headers);
expect(tb.body.integrity.balanced).toBe(true);
// 135600 + 50850 + 100000 + 50850 + 1130 = every entry's debit side, once each
expect(tb.body.totals.debit).toBe('338430.00');
expect(tb.body.totals.credit).toBe('338430.00');

const pl = await request(app).get('/api/v1/reports/profit-loss').query({ from: '2025-07-16', to: '2026-07-15' }).set(owner.headers);
expect(pl.body.revenueTotal).toBe('165000.00'); // 120000 + 45000
expect(pl.body.expenseTotal).toBe('1130.00');
expect(pl.body.netProfit).toBe('163870.00');

const bs = await request(app).get('/api/v1/reports/balance-sheet').query({ asOf: '2026-07-15' }).set(owner.headers);
expect(bs.body.integrity.balanced).toBe(true);
expect(bs.body.totals.assets).toBe('185320.00'); // AR 35600 + Bank 149720
expect(bs.body.totals.liabilities).toBe('21450.00'); // VAT payable 15600 + 5850
expect(bs.body.totals.equity).toBe('163870.00'); // Current Year Earnings == P&L netProfit
```

Every one of these numbers was calculated by hand from the five journal entries and written into
the test. That is what "asserted to the paisa" means, and it is what makes the test meaningful: if
the code ever produces a different number, the test fails, and the number in the test is defensible
because a human derived it.

Check the accounting equation yourself: assets 185,320 = liabilities 21,450 + equity 163,870.
185,320 = 185,320. ✓

Note the last line especially: equity equals the P&L's net profit exactly. As Day 5 established,
Current Year Earnings is never stored — it is computed at render time as revenue minus expenses.
This assertion proves the two reports agree.

---

### 4.6 Property-based testing — `backend/src/test/invariants.property.test.js`

**Status:** Created

**Purpose:** Prove that **no** sequence of valid accounting operations can leave the books
unbalanced, by generating random sequences and checking after every single step.

#### What is property-based testing?

Every test written before Day 6 was **example-based**: you pick specific inputs, you state the
specific expected output.

```js
// example-based: one specific case
expect(invoiceTotal(15, 8000, 0.13)).toBe('135600.00');
```

That proves one case. It says nothing about the other billions of possible inputs.

**Property-based testing** inverts this. Instead of specific inputs and outputs, you state a
**property** — something that must be true for *all* valid inputs — and let a library generate
hundreds of random inputs trying to break it.

```
Example-based:  "For THIS input, I expect THIS output."
Property-based: "For ANY valid input, THIS must remain true."
```

The property here is the fundamental law of double-entry bookkeeping: **total debits always equal
total credits**. Not after some operations. After every operation, always, forever.

The library is `fast-check`. It generates random data, and — critically — when it finds a failure it
**shrinks** it: it automatically retries with progressively simpler inputs to find the smallest case
that still fails. You get "it breaks with 2 invoices and 1 reversal" rather than "it breaks with
this wall of 40 random operations."

#### The operations

Five operation types, matching the plan's list:

```js
async function applyOp(op) {
  const amount = op.amount;
  switch (op.type) {
    case 'invoice': return opCreateInvoice(amount, op.partyIdx);
    case 'receipt': return opReceipt(amount);
    case 'creditNote': return opCreditNote(amount);
    case 'manualJv': return opManualJv(amount);
    case 'reverse': return opReverse();
  }
}
```

Each one calls the **real HTTP API** through supertest, not internal functions. That matters — the
test exercises the full stack including validation, middleware, and routing, exactly as a user
would.

#### Guarding against invalid operations

An important design point. Some randomly generated operations would be *legitimately* rejected by
business rules — allocating a payment to an already-paid invoice, for instance. Those rejections
are correct behaviour, not bugs, so the test must not treat them as failures. It avoids generating
them:

```js
async function opReceipt(amount) {
  if (invoiceIds.length === 0) return;
  const invoiceId = invoiceIds[Math.floor(Math.random() * invoiceIds.length)];
  const outstanding = await currentOutstanding(invoiceId);
  if (outstanding <= 0) return;
  const allocated = Math.min(amount, outstanding);
  ...
```

Three guards: skip if no invoice exists yet; skip if this invoice is fully paid; and cap the
allocation at what is actually outstanding. `Math.min(amount, outstanding)` guarantees the receipt
never over-allocates.

There is an explicit comment recording a related decision:

```js
const reversibleEntries = []; // {id}: receipt/creditNote/manualJV entries only
                               // (invoice entries are excluded — reversing one
                               // with activity applied is a real business rule
                               // rejection, not a bug, and would make the
                               // property test's "every op succeeds" premise false)
```

This is worth pausing on. Reversing an invoice that already has payments applied *should* be
refused — Day 4 built that rule deliberately (issue a credit note instead). Including invoice
reversals in the random pool would produce failures that are actually the system working correctly.
So the pool excludes them.

#### The invariant check

```js
async function assertInvariants() {
  const [glRow] = await prisma.$queryRaw`
    SELECT COALESCE(SUM(debit), 0) AS total_debit, COALESCE(SUM(credit), 0) AS total_credit
    FROM "JournalLine" WHERE "organizationId" = ${owner.orgId}
  `;
  expect((Number(glRow.total_debit) - Number(glRow.total_credit)).toFixed(4)).toBe('0.0000'); // INV-2

  const bs = await request(app).get('/api/v1/reports/balance-sheet').query({ asOf: '2026-07-15' }).set(owner.headers);
  expect(bs.status).toBe(200);
  expect(bs.body.integrity.balanced).toBe(true); // INV-4, via the endpoint

  const rows = await prisma.$queryRaw`
    SELECT a.type, COALESCE(SUM(jl.debit), 0) AS total_debit, COALESCE(SUM(jl.credit), 0) AS total_credit
    FROM "JournalLine" jl JOIN "Account" a ON a.id = jl."accountId"
    WHERE jl."organizationId" = ${owner.orgId}
    GROUP BY a.type
  `;
  const byType = Object.fromEntries(rows.map((r) => [r.type, Number(r.total_debit) - Number(r.total_credit)]));
  const assets = byType.ASSET ?? 0;
  const liabilities = -(byType.LIABILITY ?? 0);
  const equity = -(byType.EQUITY ?? 0);
  const revenue = -(byType.REVENUE ?? 0);
  const expense = byType.EXPENSE ?? 0;
  // Assets - (Liabilities + Equity + Income - Expenses) == 0, computed
  // independently from raw SQL across every account type (INV-4).
  expect((assets - (liabilities + equity + revenue - expense)).toFixed(4)).toBe('0.0000');
}
```

**INV-2** is the first block: sum every debit and every credit in the organization, subtract. Must
be exactly zero. `COALESCE(x, 0)` is SQL for "if this is NULL, use 0 instead" — needed because
summing zero rows yields NULL, not 0.

**INV-4** is checked **two independent ways**, and this redundancy is the point. First through the
Balance Sheet endpoint's own `integrity.balanced` flag. Then again with raw SQL that shares no code
with that endpoint. If the endpoint had a bug that made it always report `balanced: true`, the
first check would pass while lying — the second check, computed by a completely different route,
would catch it.

**Why the minus signs?** Because of how double-entry represents different account types. Assets and
expenses increase with debits, so their natural balance is debit-positive. Liabilities, equity, and
revenue increase with credits, so `debit − credit` comes out negative for them; negating gives the
positive figure. `?? 0` is the **nullish coalescing operator**: use `0` if the left side is `null`
or `undefined` — needed because an account type with no postings yet is simply absent from the
results.

#### Running the property

```js
await fc.assert(
  fc.asyncProperty(fc.array(opArbitrary, { minLength: 40, maxLength: 40 }), async (ops) => {
    for (const op of ops) {
      await applyOp(op);
      await assertInvariants();
    }
  }),
  { numRuns: 3 }
);
```

`fc.array(opArbitrary, { minLength: 40, maxLength: 40 })` asks for arrays of exactly 40 random
operations. `numRuns: 3` runs three such sequences. So each execution performs 120 real accounting
operations, checking three invariants after every single one — 360 invariant checks, against
sequences no human chose.

Note `await assertInvariants()` is inside the loop, not after it. Checking only at the end would
miss a bug that unbalanced the books temporarily and then rebalanced them.

---

### 4.7 Concurrency tests — `backend/src/test/concurrency.test.js`

**Status:** Created

**Purpose:** Prove that the database row locks written on Days 3–5 actually work when requests
genuinely arrive at the same time.

#### Why sequential tests cannot prove this

Every earlier test did this:

```js
await request(app).post('/api/v1/receipts')...   // finishes completely
await request(app).post('/api/v1/receipts')...   // then this starts
```

`await` waits. The second request begins only after the first has fully finished. A race condition
**cannot occur**, so a test written this way cannot detect one. To test concurrency you must
actually launch requests in parallel.

#### CONC-1 — parallel over-allocation

```js
const results = await Promise.all(
  Array.from({ length: 5 }, () =>
    request(app).post('/api/v1/receipts').set(owner.headers).send({
      partyId: party.id, docDate: '2025-09-06', depositAccountId: bankAccount.id, amount: 30000,
      allocations: [{ invoiceId, amount: 30000 }],
    })
  )
);

const succeeded = results.filter((r) => r.status === 201);
const refused = results.filter((r) => r.status === 422);
expect(succeeded).toHaveLength(3);
expect(refused).toHaveLength(2);
expect(refused.every((r) => r.body.error.code === 'over_allocation')).toBe(true);
```

**What is `Promise.all`?** It takes an array of promises, starts them all, and waits for all to
finish. This is the crucial difference from `await` in a loop: all five requests are genuinely in
flight simultaneously.

**What is `Array.from({ length: 5 }, () => ...)`?** A way to build an array of 5 elements by
calling a function 5 times. Each call fires one request.

**The scenario:** an invoice with 100,000 outstanding, and five simultaneous receipts of 30,000
each — 150,000 of attempted payment against 100,000 of debt.

**The correct outcome is exactly 3 succeed and exactly 2 fail.** Three receipts of 30,000 = 90,000,
which fits. A fourth would reach 120,000, exceeding the debt.

**The bug this catches** is the classic race condition. Without locking, all five requests would
read "outstanding = 100,000" at nearly the same instant, all five would conclude "30,000 fits," and
all five would write. The invoice would end up over-allocated — the company's books would show a
customer having paid more than they owed, which in accounting terms is a fabricated liability.

The protection is `SELECT ... FOR UPDATE` in the receipt service, which locks the invoice row.
Postgres then forces the five transactions to take turns. Each subsequent one re-reads the
*updated* outstanding amount, so numbers four and five correctly see insufficient room and are
rejected with 422 `over_allocation`.

The test then verifies the aftermath from three angles:

```js
const invoice = await prisma.document.findUniqueOrThrow({ where: { id: invoiceId } });
expect(invoice.outstandingAmount.toFixed(2)).toBe('10000.00');

const allocations = await prisma.paymentAllocation.findMany({ where: { targetDocumentId: invoiceId } });
const allocatedTotal = allocations.reduce((t, a) => t + Number(a.amount), 0);
expect(allocatedTotal).toBe(90000);

const [arRow] = await prisma.$queryRaw`...`;
expect((Number(arRow.total_debit) - Number(arRow.total_credit)).toFixed(4)).toBe('0.0000');
```

Outstanding is 10,000 (100,000 − 90,000); exactly 90,000 of allocation rows exist; and the ledger
is still balanced. The last check matters because a partial failure could have left journal lines
written for a rejected receipt.

#### CONC-2 — parallel document numbering

```js
const results = await Promise.all(
  drafts.map((id) => request(app).post(`/api/v1/invoices/${id}/post`).set(owner.headers).send())
);

expect(results.every((r) => r.status === 200)).toBe(true);
const docNumbers = results.map((r) => r.body.invoice.docNo);
expect(new Set(docNumbers).size).toBe(10); // no duplicates

const suffixes = docNumbers.map((n) => Number(n.match(/-(\d+)$/)[1])).sort((a, b) => a - b);
const min = suffixes[0];
expect(suffixes).toEqual(Array.from({ length: 10 }, (_, i) => min + i)); // no gaps, contiguous
```

Ten invoices posted simultaneously, each needing a unique sequential number.

**What is a `Set`?** A collection that automatically discards duplicates. So
`new Set(docNumbers).size` is the count of *distinct* numbers. If it equals 10, all ten were
different. This is a neat, cheap duplicate check.

**The no-gaps check.** `n.match(/-(\d+)$/)[1]` extracts the trailing digits — the parentheses form a
**capture group**, and `[1]` retrieves what it captured. Sorted numerically, ten contiguous numbers
starting at `min` must equal `[min, min+1, ..., min+9]`.

**Why gaps matter.** Invoice numbering in most tax jurisdictions must be sequential and unbroken. A
missing number looks like a deleted invoice to an auditor — a classic fraud signature. This is why
Day 3 used a locked counter row (`SELECT ... FOR UPDATE` on `DocumentSeries`) rather than the naive
`MAX(doc_no) + 1`, which under concurrency produces duplicates.

---

### 4.8 File: `.github/workflows/ci.yml`

**Status:** Created

**Purpose:** Automatically install dependencies, run migrations, lint, and run the full test suite
on a clean machine, every time code is pushed or a pull request is opened.

**Why does this file exist?**

"It works on my machine" is not evidence. A local machine has a database with accumulated state,
manually installed tools, and environment variables set months ago and forgotten. CI runs on a
fresh virtual machine that has none of that. If the suite passes there, it passes for real — and
critically, it proves a *new developer could actually run this project*.

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

env:
  NODE_VERSION: '22'

jobs:
  backend:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: ledgerline
          POSTGRES_PASSWORD: ledgerline
          POSTGRES_DB: ledgerline
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U ledgerline"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
      redis:
        image: redis:7
        ports: ['6379:6379']
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    env:
      DATABASE_URL: postgresql://ledgerline:ledgerline@localhost:5432/ledgerline
      JWT_SECRET: ci-only-secret-not-used-anywhere-real-0123456789
      REDIS_URL: redis://localhost:6379
      NODE_ENV: test
    defaults:
      run:
        working-directory: backend
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: npm
          cache-dependency-path: backend/package-lock.json

      - run: npm ci
      - run: npx prisma migrate deploy
      - run: npm run lint
      - run: npm run test:coverage
```

#### Concepts, from zero

**What is CI?** *Continuous Integration* — running your checks automatically on a server whenever
code changes, so problems are caught within minutes rather than discovered by a user.

**What is YAML?** A configuration file format where **indentation defines structure**. Nesting is
expressed purely by how far a line is indented, which makes it readable but also means a
misplaced space is a syntax error.

**What is GitHub Actions?** GitHub's built-in CI. Put a YAML file in `.github/workflows/` and
GitHub runs it on their machines according to the triggers you specify.

**Reading the structure:**

- `on:` — the triggers. Here: any push to `main`, and any pull request targeting `main`.
- `jobs:` — independent units of work. `backend` and `frontend` run **in parallel** on separate
  machines, so a slow backend suite does not delay frontend feedback.
- `runs-on: ubuntu-latest` — GitHub provisions a fresh Ubuntu virtual machine.

**What are `services`?** Extra containers started alongside the job. The tests need a real Postgres
(not a fake — the project tests database triggers, `NUMERIC` arithmetic, and `FOR UPDATE` locks,
none of which a fake provides) and a real Redis for the rate-limit test.

**What is a health check?** A repeated command testing whether a container is actually ready.
`pg_isready` asks Postgres "are you accepting connections?" every 5 seconds, up to 10 times. This
prevents a real and very common CI flake: containers take a few seconds to become ready, and
without a health check the test step starts immediately and fails with "connection refused."

**Why is the CI `JWT_SECRET` visible in a public file?** Because it is deliberately fake. It signs
tokens only inside a throwaway container that is destroyed minutes later. Naming it
`ci-only-secret-not-used-anywhere-real-0123456789` documents that intent to any reader. Note it is
also over 32 characters — it has to satisfy `env.js`, which is a small demonstration that the
validation applies everywhere.

**The four steps:**

- **`npm ci`** — *not* `npm install`. `ci` installs exactly the versions pinned in
  `package-lock.json` and fails if the lockfile disagrees with `package.json`. It is reproducible;
  `npm install` may quietly upgrade things.
- **`npx prisma migrate deploy`** — applies all migrations to the empty CI database. `deploy` (as
  opposed to `dev`) never generates new migrations or prompts — it only applies what exists, which
  is the correct behaviour for an automated environment.
- **`npm run lint`** — ESLint, catching unused variables and other slips.
- **`npm run test:coverage`** — the suite plus a coverage report.

**What is code coverage?** The percentage of your source lines actually executed during the tests.
It shows what is *untested* — it does not prove what is tested is correct. The config lives in
`backend/vitest.config.js`:

```js
coverage: {
  provider: 'v8',
  reporter: ['text', 'lcov'],
  exclude: ['src/generated/**', 'src/test/**', '**/*.test.js', 'prisma/**'],
},
```

The exclusions matter: `src/generated/**` is Prisma's machine-generated client (not our code), and
test files themselves should not count toward coverage of the application.

Measured at the end of the session: **85.58% of statements, 88.36% of lines**.

---

### 4.9 File: `backend/src/openapi.js`

**Status:** Created

**Purpose:** Describe every API endpoint — its path, method, required headers, request body, and
possible responses — and generate a standard OpenAPI document from those descriptions.

**Why does this file exist?**

An API that only its author understands is not finished. OpenAPI produces a machine-readable
description that renders into interactive browser documentation, so anybody can see what exists and
try it out without reading the source.

```js
import { z } from 'zod';
import { extendZodWithOpenApi, OpenAPIRegistry, OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';

// Patches `.openapi()` onto every Zod schema in this module. Zod is a single
// cached module instance across the app, so this only needs to run once —
// but this file deliberately does NOT touch the route files' own schemas
// (that would mean annotating ~40 endpoints' worth of zod.object() calls in
// place); it re-describes each route's shape here instead, in one file, at
// the cost of the two copies drifting if a route's contract changes without
// updating this file too.
extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();

registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http', scheme: 'bearer', bearerFormat: 'JWT',
});
const orgHeader = registry.registerParameter(
  'OrganizationId',
  z.string().uuid().openapi({ param: { name: 'X-Organization-Id', in: 'header' }, description: 'Active organization — required on every tenant-scoped route' })
);
const AUTH = [{ bearerAuth: [] }];
```

#### Concepts, from zero

**What is OpenAPI?** A standard format (a large JSON/YAML document) for describing HTTP APIs.
Because it is standardised, tools can consume it: render documentation, generate client code, or
run automated contract tests.

**What is Swagger UI?** A ready-made web page that reads an OpenAPI document and renders it as
browsable, interactive documentation with a "Try it out" button on every endpoint.

**Why generate it from Zod instead of writing the YAML by hand?** Because the project already
describes every request shape in Zod for validation. Hand-written documentation drifts from reality
the moment somebody changes a route and forgets to update the docs. Deriving it from schemas keeps
them closer together.

**An honest caveat, recorded in the file's own comment.** This file does *not* import the route
files' actual Zod schemas — it re-declares equivalent ones. Doing it properly would mean annotating
about forty `z.object()` definitions across every route file with `.openapi()` metadata. The
tradeoff was taken deliberately: all the description lives in one readable file, at the cost that
the two copies can drift if a route contract changes and this file is not updated. The comment
exists so the next reader knows this is a known limitation, not an oversight. **This distinction —
what the code does, versus what it would ideally do — is worth internalising: good code records its
own compromises.**

**What is a security scheme?** A named description of how authentication works.
`type: 'http', scheme: 'bearer'` means "send an `Authorization: Bearer <token>` header." Registering
it once lets every endpoint reference it by name, and it makes Swagger UI display an "Authorize"
button.

**Registering a reusable parameter.** `X-Organization-Id` is required by nearly every route in this
API (it selects which company's books you are working in — see Day 2's multi-tenancy). Registering
it once and referencing it avoids repeating the definition forty times.

#### A representative endpoint registration

```js
registry.registerPath({
  method: 'post', path: '/api/v1/invoices', tags: ['Invoices'], summary: 'Create a draft invoice',
  security: AUTH, request: { headers: tenantParams, body: { content: { 'application/json': { schema: z.object({ partyId: uuid(), docDate: dateStr(), lines: z.array(invoiceLineInput).min(1) }) } } } },
  responses: { 201: { description: 'Created', ...json(invoice) }, 400: errorResponse },
});
```

Everything a consumer needs: the method and path, a grouping tag, a human summary, that
authentication is required, which headers, the exact body shape, and the possible responses.

Small helpers keep this readable:

```js
const money = () => z.string().openapi({ example: '1250.00', description: 'Decimal string, 2dp on the wire' });
const dateStr = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/).openapi({ example: '2025-08-20' });
const uuid = () => z.string().uuid();
const json = (schema) => ({ content: { 'application/json': { schema } } });
```

The `money` helper deserves a note. It documents that monetary values travel as **strings**, not
JavaScript numbers. This is a deliberate architectural decision from Day 1: JavaScript's `number`
type cannot represent decimal fractions exactly (`0.1 + 0.2 === 0.30000000000000004`), which is
unacceptable for money. Values are strings on the wire and `Decimal` objects in the code.

#### Generating the document

```js
const generator = new OpenApiGeneratorV3(registry.definitions);

export const openApiDocument = generator.generateDocument({
  openapi: '3.0.0',
  info: {
    title: 'Ledgerline API',
    version: '1.0.0',
    description: 'Multi-tenant double-entry accounting API. Every write goes through a posting engine that only ever produces balanced journal entries — see the invariant test suite for the proof.',
  },
  servers: [{ url: '/' }],
});
```

#### Serving it — in `backend/src/app.js`

```js
// helmet's default CSP blocks Swagger UI's inline bootstrap script and
// styles — relaxed only on this one docs path, not globally.
app.use('/api/v1/docs', (req, res, next) => {
  res.removeHeader('Content-Security-Policy');
  next();
}, swaggerUi.serve, swaggerUi.setup(openApiDocument));
```

**What is helmet?** Middleware that sets a collection of protective HTTP headers. One of them is
the **Content Security Policy (CSP)** — a header telling the browser which sources of scripts and
styles are permitted, which is a strong defence against cross-site scripting.

**Why remove it here?** Swagger UI bootstraps itself with an inline `<script>` block, and helmet's
default CSP forbids inline scripts. Without this, the docs page loads as a blank screen.

**Why this is an acceptable tradeoff.** The relaxation applies **only** to the `/api/v1/docs` path —
the first argument to `app.use`. Every other route keeps the full CSP. The docs page displays only
static generated content, so the XSS risk that CSP defends against is minimal there. Note also the
ordering: this small middleware runs *before* `swaggerUi.serve`, because the header must be removed
before the response is sent.

---

## 5. Complete request and runtime flows

### 5.1 Server startup

```
npm run dev
  │
  ▼
node --watch src/index.js
  │
  ▼
index.js: import { env } from './env.js'
  │
  ▼
env.js runs
  ├─ import 'dotenv/config'  →  reads backend/.env into process.env
  ├─ builds the Zod schema
  └─ schema.parse(process.env)
        │
        ├─ INVALID  →  throws  →  process exits, error printed  →  STOP
        │
        └─ VALID    →  exports `env`
  │
  ▼
index.js: import app from './app.js'
  │
  ▼
app.js imports lib/rate-limit.js
  └─ await redisClient.connect()   ← startup pauses until Redis is ready
  │
  ▼
app.js imports openapi.js  →  OpenAPI document generated once, in memory
  │
  ▼
app.js builds the middleware chain
  │
  ▼
index.js: app.listen(env.PORT)  →  server now accepting requests
```

The key property: **every possible configuration failure happens before `app.listen`**. A server
that is accepting requests is a server whose configuration is known-good and whose Redis connection
is established.

### 5.2 A successful login, end to end

```
Browser: user submits the login form at http://localhost:5173
  │
  ▼
POST /api/v1/auth/login   { email, password }
  │
  ▼
Vite dev server proxy  →  forwards to http://localhost:3000
  │
  ▼
Express receives the request
  │
  ▼  [1] request-id middleware
      req.id = randomUUID()          ← so every log line for this request is traceable
      res.setHeader('X-Request-Id', req.id)
  │
  ▼  [2] auditLog middleware
      registers a 'finish' listener  ← runs later, after the response is sent
  │
  ▼  [3] helmet()
      sets protective security headers
  │
  ▼  [4] cors(...)
      Origin is http://localhost:5173 → in allowlist → allowed
  │
  ▼  [5] globalLimiter
      Redis: INCR rl:global:<ip>
      count ≤ 300 → continue
  │
  ▼  [6] express.json({ limit: '1mb' })
      parses the JSON body into req.body
  │
  ▼  [7] router: /api/v1/auth  →  POST /login
  │
  ▼  [8] authLimiter          ← route-specific, stricter
      key = "<ip>:<email>"
      Redis: INCR rl:auth:<ip>:<email>
      count ≤ 5 → continue
      count > 5 → 429 Too Many Requests, STOP HERE
  │
  ▼  [9] the route handler
      loginSchema.parse(req.body)      ← Zod validates shape
      loginUser(email, password)
        ├─ find the user by email
        ├─ verify the password with Argon2id  (deliberately slow)
        ├─ sign a short-lived access token    (env.JWT_SECRET)
        └─ create a refresh token, store its SHA-256 hash in Postgres
  │
  ▼  [10] the response
      Set-Cookie: refreshToken=...; HttpOnly; SameSite=Strict; Path=/api/v1/auth
      200 OK  { user: { id, email }, accessToken }
  │
  ▼  [11] 'finish' fires  →  auditLog writes its row (after the response, never before)
  │
  ▼
Browser: access token kept in memory only; refresh cookie stored by the browser
```

Note where the two rate limiters sit. The global one is early, before any real work — it is the
cheap, broad defence. The auth one is inside the route, after routing has determined this is
specifically a login attempt.

Note also step 11. The audit row is written on `finish`, i.e. *after* the response has been sent.
This is Day 2's design and it matters: an operation that was rolled back must never leave a log
entry claiming it succeeded.

### 5.3 A request that exceeds the rate limit

```
POST /api/v1/auth/login  (the 6th attempt within 15 minutes for this IP+email)
  │
  ▼
[1]…[7] as above
  │
  ▼  [8] authLimiter
      Redis: INCR rl:auth:<ip>:<email>  →  6
      6 > 5
      │
      ▼
      429 Too Many Requests
      RateLimit-Limit: 5
      RateLimit-Remaining: 0
      RateLimit-Reset: <seconds>
      │
      ▼
      next() is NEVER called
      the route handler never runs
      no database query happens
      no password is ever checked
```

This is worth dwelling on, because it explains a real incident from this session (section 7.10).
**The rejection happens before the credentials are examined.** A correct password and an incorrect
one are treated identically once the limit is hit. That is the entire point — an attacker learns
nothing, because the endpoint stops answering questions at all.

### 5.4 An error being logged safely

```
Some route throws an error (or a service rejects)
  │
  ▼
next(err) propagates to the last middleware in app.js
  │
  ▼
app.use((err, req, res, _next) => { ... })
      ← Express identifies this as an error handler because it takes FOUR arguments
  │
  ▼
console.error(`[${req.id}]`, safeErrorLog(err))
  │
  └─ safeErrorLog:
       const { message, stack, ...rest } = err
         ├─ message and stack pulled out by name (non-enumerable, so spread alone would lose them)
         └─ every other own property collected into `rest`
       redact(rest)
         └─ for each key: does the NAME match /password|secret|token|.../i ?
              yes → value becomes '[REDACTED]'
              no  → recurse into it (objects and arrays walked to any depth)
  │
  ▼
Is it a ZodError?
  ├─ yes → 400 validation_error, with per-field details
  └─ no  → err.status || 500, with err.code || 'INTERNAL_ERROR'
  │
  ▼
the response always includes requestId, so a user-reported error can be found in the logs
```

---

## 6. New concepts introduced

**Environment variable** — A configuration value passed to a program from outside its source code.
Used for secrets (which must not be committed) and for values that differ between development and
production.

**Schema validation** — Describing the shape data must have, then checking real data against that
description. Zod does this for both request bodies (since Day 1) and configuration (new today).

**Fail fast** — Design principle: when something is wrong, stop immediately and loudly rather than
continuing in a degraded state. `env.js` is a pure example — it crashes at boot rather than serving
a broken server.

**Fail closed / fail open** — When a security control cannot make a decision, failing *closed*
means deny, failing *open* means allow. `CORS_ORIGINS` defaults to empty (deny everything), which
is failing closed.

**Origin** — The scheme + host + port of a URL. `http://localhost:5173` and `http://localhost:3000`
are different origins despite both being localhost, because the ports differ.

**Same-origin policy** — The browser rule that JavaScript on one origin may not read responses from
another. The foundation of web security.

**CORS (Cross-Origin Resource Sharing)** — The controlled exception to the same-origin policy: a
server declares which other origins may read its responses. Enforced by the browser, not the server.

**Allowlist** — An explicit list of what is permitted, with everything else denied. Safer than a
*denylist* (listing what is forbidden), because a denylist fails open on anything you forgot.

**Rate limiting** — Capping how many requests a given caller may make in a time window.

**Redis** — An in-memory key-value store. Used here so rate-limit counters are shared across
multiple server instances rather than isolated per-process.

**Key generator** — The function deciding what a rate limit is counted *per*: per IP, per user, per
organization, or a combination.

**Sliding/fixed window** — The time period over which a rate limit counts (`windowMs`).

**429 Too Many Requests** — The HTTP status code for a rate-limited request.

**Log redaction** — Removing sensitive values from data before it is written to a log.

**Enumerable property** — A property that loops and spread syntax can see. `Error.message` and
`Error.stack` are deliberately *non*-enumerable, which is why `safeErrorLog` extracts them by name.

**Regular expression** — A text-matching pattern. `/password|token/i` matches either word, in any
letter case.

**Recursion** — A function calling itself, with a base case that stops it. Used to walk nested
objects.

**Property-based testing** — Stating a rule that must hold for *all* valid inputs, then generating
random inputs to try to break it. Contrasts with example-based testing.

**Shrinking** — A property-testing library's ability to reduce a failing random input to the
simplest input that still fails, making debugging tractable.

**Invariant** — Something that must always be true. Here: debits equal credits (INV-2), and the
accounting equation holds (INV-4).

**Race condition** — A bug where the result depends on the unpredictable relative timing of
concurrent operations.

**`Promise.all`** — Runs many promises simultaneously and waits for all of them. The only way to
write a genuine concurrency test.

**Row-level lock (`SELECT ... FOR UPDATE`)** — A database instruction to lock specific rows so
other transactions must wait. What makes CONC-1 pass.

**Continuous integration (CI)** — Automatically running checks on a server whenever code changes.

**Service container** — An extra container (Postgres, Redis) started alongside a CI job so tests
have real dependencies.

**Health check** — A repeated probe that determines when a container is genuinely ready, preventing
"connection refused" flakes.

**`npm ci` vs `npm install`** — `ci` installs exactly what the lockfile pins and fails on
mismatch — reproducible. `install` may update the lockfile.

**Code coverage** — The share of source lines executed by the tests. Shows what is untested; does
not prove correctness.

**OpenAPI** — A standard, machine-readable format for describing an HTTP API.

**Swagger UI** — A web interface that renders an OpenAPI document as interactive documentation.

**Content Security Policy (CSP)** — A response header restricting which scripts and styles a page
may load. Relaxed only on the docs route, because Swagger UI needs inline scripts.

**Row-Level Security (RLS)** — A Postgres feature where the database itself filters which rows a
query may see, based on a session variable. Attempted this session; see section 7.9.

**`SET LOCAL` / `set_config(..., true)`** — Sets a Postgres session variable that automatically
resets when the surrounding transaction ends. Necessary with connection pooling, where a plain
`SET` would leak into the next request that reuses the connection.

**Connection pool** — A set of reusable open database connections. Opening one is expensive, so
they are shared. Central to why RLS proved hard here.

**Least privilege** — Granting an account only the permissions it actually needs. The
`ledgerline_app` role has data permissions but not schema-modification permissions.

---

## 7. Errors and debugging

Nine real problems occurred during this session. All are documented, including the one that ended
in a rollback.

### 7.1 npm installed packages into the wrong directory

**Problem.** After running an install, importing the new package failed — the package was nowhere to
be found in `backend/node_modules`.

**How we diagnosed it.** Searching the repository for the package located it:

```
/c/Projects/Ledgerline/node_modules/@asteasolutions/zod-to-openapi
```

It had installed at the **repository root**, not inside `backend/`. Checking further, npm had also
created a stray root-level `package.json` and `package-lock.json`.

**Why it happened.** The shell's working directory had reset to the repository root between
commands. `npm install` uses the current directory, and when it finds no `package.json` there, it
creates one rather than complaining.

**Fix.** Delete the three stray artifacts, then re-run the install with the working directory
explicitly set:

```bash
rm -f package.json package-lock.json && rm -rf node_modules
cd backend && npm install @asteasolutions/zod-to-openapi swagger-ui-express
```

**Lesson.** In a repository with more than one `package.json` (this one has `backend/` and
`frontend/`), always confirm the working directory before installing. If a package "cannot be
found" right after installing it, check *where* it landed before assuming the install failed.

### 7.2 Vitest 4 changed its test-options API

**Error message.**

```
TypeError: Signature "test(name, fn, { ... })" was deprecated in Vitest 3 and removed in Vitest 4.
Please, provide options as a second argument instead.
```

**Why it happened.** The property test needs a longer timeout than the default. The old API accepted
options as a **third** argument, after the function. Vitest 4 moved them to the **second** position,
before the function.

**Fix.**

```js
// before — options third (removed in Vitest 4)
it('...', async () => { ... }, { timeout: 120000 });

// after — options second
it('...', { timeout: 120000 }, async () => { ... });
```

**Lesson.** Error messages from well-maintained libraries frequently tell you the exact fix. This
one names the old signature, the version that removed it, and what to do instead. Read the whole
message before searching the internet.

### 7.3 The golden E2E test could not upload its CSV

**Error message.**

```
{ message: 'A CSV file is required (multipart field "file")', status: 422, code: 'missing_file' }
```

**Why it happened.** The supertest `.attach()` call was malformed. The correct signature is
`.attach(field, buffer, options)` — three separate arguments. The options object had been placed
*inside* the `Buffer.from(...)` call instead of alongside it, so supertest received a file with no
filename or content type, and multer discarded it.

**How we diagnosed it.** The server's own error message was precise: it said the field was missing,
not that the file was malformed. That pointed at how the request was constructed rather than at the
parsing code.

**Fix.**

```js
// before — the options object ended up inside Buffer.from(...)
.attach('file', Buffer.from(csvText([...]), { filename: '...', contentType: 'text/csv' }));

// after — buffer and options as separate arguments
.attach('file', Buffer.from(csvText([...]), 'utf8'), { filename: '...', contentType: 'text/csv' });
```

**Lesson.** When a test fails with a message the *server* produced, trust that message. It described
the request accurately; the bug was in the test, not the application.

### 7.4 The property test picked a date outside every fiscal year

**Error message.**

```
{ message: 'No fiscal year covers 2026-08-17', status: 422, code: 'no_fiscal_year' }
```

**Why it happened.** The reversal operation called the reverse endpoint without a `reversalDate`.
The service then defaults to `new Date()` — today. The test fixture creates one fiscal year running
2025-07-16 to 2026-07-15, and today's date fell outside it, so the reversal was correctly rejected.

Note that the application behaved **correctly**. Posting into a date with no fiscal year *should*
fail. The test was wrong, not the code.

**Fix.** Pass the same fixed date every other operation uses:

```js
.send({ reason: 'property test reversal', reversalDate: DOC_DATE });
```

**Lesson.** Tests that depend on the current date are a classic source of flakiness — they can pass
for months and then fail on a specific day. Pin dates explicitly in fixtures. Also: when a test
fails, first ask whether the application is right and the test is wrong.

### 7.5 `TRUNCATE` is a separate privilege from `DELETE`

**Error message.**

```
Raw query failed. Code: `42501`. Message: `permission denied for table DocumentLine`
```

**Why it happened.** During the RLS work, the app connected as the new least-privilege role, which
had been granted `SELECT, INSERT, UPDATE, DELETE`. But the test helpers reset the database with
`TRUNCATE`, and in Postgres `TRUNCATE` is its own distinct privilege — having `DELETE` does not
imply it. (They differ mechanically too: `DELETE` removes rows one at a time and fires row-level
triggers; `TRUNCATE` discards the whole table at once and does not.)

**Fix.** A follow-up migration granting it:

```sql
GRANT TRUNCATE ON ALL TABLES IN SCHEMA public TO ledgerline_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT TRUNCATE ON TABLES TO ledgerline_app;
```

**Lesson.** Postgres privileges are fine-grained and do not nest the way intuition suggests. When a
`42501` permission error names an operation, check whether that specific operation has its own
privilege rather than assuming a broader grant covers it.

### 7.6 Editing an already-applied migration does nothing

**Problem.** After fixing the migration file from 7.5, re-running `prisma migrate deploy` reported
"No pending migrations to apply." The fix never reached the database.

**Why it happened.** Prisma records every applied migration in a `_prisma_migrations` table and
identifies them by name. A migration already recorded as applied is **never re-run**, no matter how
the file changes. This is correct and important behaviour — in production, silently re-running an
edited migration could destroy data.

**How we diagnosed it.** Querying the tracking table directly, then confirming the missing grant:

```sql
SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations WHERE ...;
SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
  WHERE grantee='ledgerline_app' AND table_name='DocumentLine';
```

The grants query returned only INSERT, SELECT, UPDATE, DELETE — no TRUNCATE. Proof the edit had not
been applied.

**Fix.** Revert the already-applied file to match what actually ran, and put the change in a **new**
migration (`20260817120500_grant_truncate_to_app_role`).

**Lesson.** Migrations are an append-only history, not editable source files. Once a migration has
been applied anywhere, fix it forward with a new migration. `prisma migrate status` and the
`_prisma_migrations` table are how you check what really happened.

### 7.7 Connection pool exhaustion

**Error message.**

```
PrismaClientKnownRequestError: Transaction API error: Unable to start a transaction in the given time.
code: 'P2028'
```

**How we diagnosed it.** The test run hung rather than failing fast. Inspecting Postgres directly
showed the smoking gun:

```
 count |        state
-------+---------------------
    10 | idle in transaction
```

Ten connections — the pool's entire default size — all sitting open inside transactions, each
having just run `set_config` and then waiting on the client. Nothing left to allocate.

**Why it happened.** Two compounding causes. First, RLS requires a transaction per query (see 7.9),
so every standalone read now held a connection where it previously used none. Second, and worse, a
recursion: code inside a transaction triggered logic that tried to open a *second* transaction,
which waited for a connection that could only be freed by the first transaction finishing — a
deadlock by starvation.

**Fix (partial).** Raising the pool size relieved the symptom:

```js
const adapter = new PrismaPg({ connectionString: env.APP_DATABASE_URL, max: 30 });
```

But raising a limit to hide a recursion is treating a symptom. The real fix was preventing the
nested transaction, which is where the deeper problem lived.

**Lesson.** "Unable to start a transaction" almost always means connections are held, not that the
database is slow. `pg_stat_activity` tells you the truth immediately — `idle in transaction` means
your application opened transactions and did not close them. And when a fix is "increase the
limit," ask whether you have found the cause or merely postponed it.

### 7.8 A Proxy broke Prisma's internal `this` binding

**Why it happened.** Part of the RLS work wrapped the transaction object in a JavaScript `Proxy`
(an object that intercepts property access). The first version forwarded the `receiver` argument:

```js
get(target, prop, receiver) {
  const value = Reflect.get(target, prop, receiver);
```

Prisma's model accessors (`tx.invoice`, `tx.account`) are **getters** — functions that run on
property access — and they close over the client's internal state via `this`. Passing the proxy as
`receiver` rebinds `this` to the proxy instead of the real object. The returned delegate silently
stopped being tied to that transaction's connection.

**Fix.** Omit the receiver so `this` stays bound to the real target:

```js
get(target, prop) {
  const value = Reflect.get(target, prop);
```

**Lesson.** Proxies are powerful and treacherous around code that relies on `this`. The failure mode
is silent — no error, just wrong behaviour — which makes it far more dangerous than a crash. Be very
cautious proxying objects you did not write.

### 7.9 The Row-Level Security attempt — the full post-mortem

This is the most instructive part of the session.

#### What we were trying to build, and why

LedgerLine's tenant isolation is enforced by a Prisma client extension
(`backend/src/db/tenant-extension.js`) that automatically injects `organizationId` into every query.
It works, and every route depends on it.

But it is **application code**. If a future developer writes raw SQL, or adds a service that
bypasses the extension, the isolation is simply gone — and the failure is silent. One company would
see another company's ledger.

**Postgres RLS** would add a second, independent layer inside the database: policies stating that a
row is visible only when its `organizationId` matches a session variable. Then even a raw SQL
mistake cannot cross tenants, because Postgres itself refuses the rows.

The migration that does this was written and applied successfully:

```sql
EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
EXECUTE format(
  'CREATE POLICY tenant_isolation ON %I USING ("organizationId" = current_setting(''app.current_org_id'', true)) WITH CHECK ("organizationId" = current_setting(''app.current_org_id'', true))',
  t
);
```

Applied to 17 tenant-scoped tables. Verified present in the database.

Note `current_setting('app.current_org_id', true)` — the `true` is `missing_ok`, meaning "return
NULL instead of raising an error if this is unset." With NULL, no row matches, so an unscoped
connection sees **zero rows**. It fails closed.

#### The three constraints that made it hard

**1. Table owners bypass RLS.** By default, whoever owns a table ignores its policies entirely. So
the app cannot connect as the owner — a separate, least-privilege role is required
(`ledgerline_app`), while migrations continue as the owner.

**2. `SET LOCAL` requires a transaction.** RLS reads `app.current_org_id` from the session. With a
connection pool, connections are reused across requests — so a plain session-level `SET` would leak
one tenant's ID into the next request that happened to reuse that connection. That is a
catastrophic bug: worse than no RLS, because it would actively serve the wrong tenant's data. The
safe form is `set_config(..., true)`, which resets when the transaction ends — meaning **every
query, including every simple read, now needs its own transaction**.

**3. The org ID must reach the code that opens the transaction.** The project carries the current
organization in an `AsyncLocalStorage` request context (Day 2). That works for top-level calls.

#### The wall

Constraint 3 is where it broke. The finding, established empirically rather than assumed:

> A request-context value set immediately before dispatching a nested `tx.model.operation()` call is
> **not visible** inside the `$allOperations` hook that same call triggers.

We verified this directly with tracing — printing the context immediately before the call and again
inside the hook:

```
[wot] after enterWith, getStore= { organizationId: '8df77844-...', inTransaction: true }
[trace] Membership findFirst org= undefined inTx= undefined
```

Set immediately before. `undefined` immediately after, inside the hook. Both `AsyncLocalStorage.run()`
and `.enterWith()` behaved the same way. The async-context continuity does not survive Prisma's
interactive-transaction dispatch in this version.

The consequence was severe: the hook could not tell "already inside a scoped transaction" from
"standalone query needing one," so it opened a *second* transaction for every query already inside
one — the recursion that caused 7.7's pool exhaustion.

#### The workaround, and why we still stopped

We built a workaround that did address it: mark the `args` object itself with a symbol (an object
reference threaded through the call, immune to async-context loss), plus a `Proxy` wrapping `tx` so
nested calls picked up the marker automatically. That fixed the recursion — after also fixing 7.8's
`receiver` bug.

Then a **second, different failure surfaced** under the full suite: `resolveTenant` firing twice for
a single request in some flows, traced but not explained:

```
[resolveTenant] POST /api/v1/journal-entries reqId= 55e43d08-... calling withOrgTransaction
[resolveTenant] POST /api/v1/journal-entries reqId= 55e43d08-... calling withOrgTransaction
```

Same request ID. Two invocations. At that point the decision was made to stop.

#### Why stopping was the right call

The reasoning matters more than the code:

1. **This is a security feature.** A half-working security control is worse than none, because it
   creates false confidence. If RLS silently returned empty results in some flow, that could look
   like "no data" rather than "broken isolation."
2. **The failure was not understood.** Fixing something you cannot explain produces code that
   *appears* to work until it does not.
3. **The plan makes it conditional.** Line 1526: "*if the suite is green by 15:00*." The plan
   anticipated exactly this and pre-authorised skipping it.
4. **The suite was green before, and had to be green after.** A working 130-test suite is worth more
   than a partially-working extra security layer.

#### What was reverted, what was kept

**Reverted** — all application wiring, via `git checkout --` on the touched files: `db/client.js`,
`db/tenant-extension.js`, `env.js`, `middleware/resolve-tenant.js`, `routes/orgs.js`, seven service
files, and eleven test files. Also deleted: `db/with-org-transaction.js`, `test/admin-client.js`,
and `test/rls-isolation.test.js`.

**Kept** — both migrations. They are real, tested SQL. They are harmless because the app connects as
the table owner, which bypasses RLS, so the policies are present but inert. Keeping them means the
next attempt starts with the database work already done.

**Verified after reverting:** 24 files, 130 tests, all passing. Lint clean.

**Documented** — a permanent section in `README.md` explaining the tradeoff, the constraint, and the
exact technical wall, so nobody re-walks this dead end from scratch.

**Lesson.** Three, and they are the most valuable things in this document:

- **Verify assumptions about libraries empirically.** "AsyncLocalStorage propagates through async
  calls" is true in general and false in this specific case. A five-minute trace produced certainty
  that hours of reasoning would not have.
- **Knowing when to stop is an engineering skill.** Shipping a security feature you cannot fully
  explain is worse than shipping without it.
- **A documented failure has real value.** The README section means the next attempt starts with
  knowledge instead of optimism.

### 7.10 Login failing with the correct password

**Problem.** Signing in with the demo credentials shown on the login page failed with "Request
failed" — repeatedly, even though the password was right.

**How we diagnosed it.** Two steps, in order.

First, check whether the user exists at all:

```sql
SELECT email FROM "User" WHERE email='sunita@annapurnatrading.com.np';
-- (0 rows)
```

Empty. The database had been truncated repeatedly by the day's test runs, wiping the seed data.
Running `npm run seed` restored it.

But login **still failed**. So the second step: reproduce it in a real browser and read the actual
network response rather than the UI's generic message.

```
POST http://localhost:5173/api/v1/auth/login → 429 Too Many Requests
```

**Why it happened.** Two independent causes stacked, which is what made it confusing:

1. The database was empty, so the early attempts genuinely failed.
2. Those failed attempts consumed the auth limiter's budget — 5 attempts per 15 minutes per
   IP+email. Once exhausted, **every** subsequent attempt is rejected before the password is ever
   checked (see flow 5.3). Seeding fixed cause 1, but the limiter was still blocking.

The rate limiter was working exactly as designed. It cannot distinguish "user who forgot their
password" from "attacker guessing," and that is precisely the point.

**Fix.** Clear that one counter:

```bash
docker exec ledgerline-redis-1 redis-cli KEYS "rl:auth:*"
# rl:auth:::/56:sunita@annapurnatrading.com.np
docker exec ledgerline-redis-1 redis-cli DEL "rl:auth:::/56:sunita@annapurnatrading.com.np"
```

Login then returned `200 OK` and the dashboard loaded.

Note the key's shape: `rl:auth:` (the prefix) + `::/56` (the IPv6 network prefix from
`ipKeyGenerator` — the `/56` subnet discussed in 4.3) + the email. That is the composite key from
section 4.3, visible in production.

**Lesson.** Three things:

- **A generic UI error message is not diagnostic information.** "Request failed" hid a 429. Always
  read the actual status code.
- **Fixing one cause does not mean you found the only cause.** The empty database was real and
  fixing it was necessary — but insufficient.
- **Security features affect development too.** Now that rate limiting exists, repeatedly testing
  login will lock you out. Knowing how to inspect and clear the counter is part of operating the
  system.

---

## 8. Final understanding check

Answer these in your own words. Every answer is derivable from this document and the repository.

### On what we built

1. Before Day 6, a missing `JWT_SECRET` produced a server that started successfully and failed
   later. Explain precisely *when* it failed and why that timing is worse than failing at startup.
2. `env.js` has no `try`/`catch` around `schema.parse()`. Explain why adding one would defeat the
   file's purpose.
3. `PORT` uses `z.coerce.number()` rather than `z.number()`. What would break without `coerce`, and
   why is that specific to environment variables?
4. The application had `helmet()` before Day 6 but not rate limiting. What class of attack does
   helmet not address that rate limiting does?

### On security reasoning

5. Why is `credentials: true` combined with a wildcard CORS origin not merely insecure but actually
   non-functional? What in LedgerLine's design forces `credentials: true`?
6. CORS is enforced by the browser, not the server. Given that, explain why CORS is still worth
   configuring — and why it can never replace authentication.
7. The auth rate limiter keys on IP **and** email combined. Describe an attack that the combined
   key defeats but an email-only key would miss, and one that an IP-only key would miss.
8. Why does `csvImportLimiter` key on `req.organizationId` rather than IP? What must have already
   run in the middleware chain for that value to exist, and what would happen if the limiter ran
   before it?
9. `log-redact.js` matches on property *names*, not values. What kind of secret would this approach
   fail to catch? Is that an acceptable limitation, and why?
10. Explain why `safeErrorLog` cannot be written as simply `return redact(err)`. What would silently
    disappear from the logs, and what property of `Error` causes it?

### On testing

11. Explain the difference between example-based and property-based testing, using INV-2 as your
    example. What class of bug can the property test find that no example test could?
12. INV-4 is checked twice — once via the Balance Sheet endpoint and once via raw SQL. Why is
    checking it twice more valuable than checking it once, given both check the same equation?
13. In the property test, `opReceipt` returns early when `outstanding <= 0`. Why is this guard
    necessary, and what would happen to the test without it? Would the resulting failure indicate a
    real bug?
14. Why does `assertInvariants()` run inside the loop rather than once after all 40 operations?
15. CONC-1 uses `Promise.all` rather than a loop with `await`. Explain why a loop with `await` could
    never detect the bug CONC-1 is designed to catch.
16. CONC-1 expects exactly 3 successes and 2 failures. Derive those numbers from the scenario.
17. In CONC-2, why do gaps in invoice numbers matter as much as duplicates? What real-world
    consequence does a gap have?
18. All four rate limiters are disabled under test. What is the cost of that decision, and how does
    `rate-limit.test.js` partially compensate? What remains uncovered?

### On architecture

19. `env.js` is imported by six files. Explain the mechanism by which validation runs exactly once
    despite six imports.
20. `lib/rate-limit.js` uses top-level `await` for the Redis connection. What guarantee does that
    provide, and what could go wrong without it?
21. Why does the rate limiter use Redis rather than an in-memory counter? Describe the specific
    failure at production scale.
22. `openapi.js` re-declares route schemas rather than importing them. State the benefit taken, the
    cost accepted, and how the code records that decision.
23. Why is the CSP header removed only for `/api/v1/docs` rather than globally? What would the
    security consequence of a global removal be?

### On the request lifecycle

24. Trace a login request through every middleware in `app.js`, in order, naming what each does.
25. The `globalLimiter` runs before `express.json()`. What is the benefit of that ordering?
26. The audit log is written on the response's `finish` event rather than during the request. What
    specific incorrect behaviour does that prevent?
27. When a request is rejected with 429, does the password get checked? Explain why, and why that is
    the correct security design.

### On debugging

28. Section 7.6: editing an applied migration had no effect. Explain the mechanism, and why Prisma's
    behaviour here is correct rather than a limitation.
29. Section 7.7: `idle in transaction` connections indicated what specific problem? Why is raising
    the pool size a symptom fix rather than a cause fix?
30. Section 7.4: the property test failed with `no_fiscal_year`. Was the application wrong or the
    test wrong? What general principle does this illustrate?
31. Section 7.10: seeding the database did not fix login. What was the second cause, and what does
    it teach about diagnosing from UI error messages?
32. Section 7.8: what makes a `Proxy` bug that breaks `this` binding more dangerous than one that
    throws an error?

### On the RLS decision

33. Explain in your own words why RLS requires the application to connect as a role that does *not*
    own the tables.
34. Why can't `SET app.current_org_id` be used at session level with a connection pool? Describe
    concretely what would go wrong for a user.
35. RLS requires a transaction per query. Explain why, and what performance cost that imposes on a
    simple `GET`.
36. The database migrations were kept while the application code was reverted. Explain why that is
    safe — what makes the policies inert?
37. Give three reasons stopping was the right call. Which do you find most persuasive, and why?
38. What is the value of the README's RLS section to a future developer, given the feature does not
    work?

### On the development plan

39. The plan gates RLS on "if the suite is green by 15:00" and the AI feature on "only if both devs
    are ahead at 12:00." What does this pattern of conditional scope tell you about how the plan was
    designed?
40. Day 6 adds no user-visible features at all. Argue why it is nonetheless one of the most important
    days in the plan.
41. Name three things Day 6 built that make Day 7's deployment safer, and explain the mechanism for
    each.
