# Day 2 — Authentication, Multi-Tenancy, RBAC, and Master Data

This document explains everything built in the Day 2 session, from zero. It uses the actual
LedgerLine codebase as the source of truth. Every code block below is copied from a real file in
this repository, and every file path is exact.

Commit: `dbceb3e — Day 2: auth, multi-tenancy, RBAC, and master data`
(44 files changed, 2472 insertions, 89 deletions)

---

## Table of contents

1. [What we built in this session](#1-what-we-built-in-this-session)
2. [How it relates to the 7-day plan](#2-how-it-relates-to-the-7-day-plan)
3. [Files created and modified](#3-files-created-and-modified)
4. [The code explained from zero](#4-the-code-explained-from-zero)
5. [The complete request flow](#5-the-complete-request-flow)
6. [New concepts introduced](#6-new-concepts-introduced)
7. [Errors and debugging](#7-errors-and-debugging)
8. [Final understanding check](#8-final-understanding-check)

---

## 1. What we built in this session

Before this session, the backend was a single file that could answer one request: `/healthz`,
which returned `{ "status": "ok" }`. There was a database schema and a seed script, but no way to
log in, no concept of "which company am I looking at", and no permissions.

After this session, the backend is a real multi-tenant API. Here is the plain-language version of
what that means and why each piece was needed.

### The five problems we solved

**Problem 1 — Nobody could log in.**

There was no way to create a user, prove who you are, or stay logged in. We built registration,
login, logout, and a token system. Passwords are hashed with Argon2id so that a database leak does
not hand an attacker everybody's password.

**Problem 2 — Staying logged in is harder than it looks.**

A login has to survive the user closing a tab and coming back, but a stolen login must be
revocable. We solved this with two different tokens that do two different jobs (explained in depth
in section 6), plus *refresh token rotation with reuse detection* — if somebody steals a token and
uses it, the system notices and logs everybody out of that session chain.

**Problem 3 — One database holds many companies' books.**

LedgerLine is multi-tenant: Annapurna Trading and Sherpa Ventures both live in the same Postgres
database. If a single query forgets to filter by company, one customer sees another customer's
ledger. The plan calls this the single most dangerous bug in the system. We solved it structurally
with a Prisma client extension that injects the company filter into *every* query automatically, so
a developer cannot forget it.

**Problem 4 — Not every user should be able to do everything.**

An Owner can add members; a Viewer can only read. We built an `authorize()` middleware that checks
permissions in the database on every single request, rather than baking them into the login token.

**Problem 5 — Accounting systems must record who did what.**

We built an audit log that records every state change, written *after* the database transaction
commits, so a rolled-back operation never leaves a log entry claiming it happened.

### Everything created

**Authentication logic** (`backend/src/lib/auth/`)
- `password.js` — hashing and verifying passwords
- `tokens.js` — creating and verifying the two token types
- `refresh-tokens.js` — issuing, rotating, and revoking refresh tokens
- `register.js` — the "create an account" business logic
- `login.js` — the "check credentials" business logic

**Middleware** (`backend/src/middleware/`)
- `authenticate.js` — "who is this user?"
- `resolve-tenant.js` — "which company are they working in, and are they allowed in it?"
- `authorize.js` — "do they have permission for this specific action?"
- `audit-log.js` — records what happened, after the response is sent

**Multi-tenancy machinery**
- `backend/src/lib/request-context.js` — carries the current company ID through the request
- `backend/src/db/tenant-extension.js` — injects the company filter into every database query

**HTTP routes** (`backend/src/routes/`)
- `auth.js` — `/register`, `/login`, `/refresh`, `/logout`
- `orgs.js` — organizations and their members
- `masters.js` — accounts, customers, fiscal years, periods

**Support**
- `backend/src/lib/idempotency/run-idempotent.js` — prevents duplicate payments (built now, first
  used on Day 3)
- `backend/src/lib/audit/audit-log.js` — writes audit rows
- `backend/src/app.js` — the Express application, separated from the server startup

**Tests**
- `backend/src/routes/auth.test.js` — 11 tests
- `backend/src/routes/isolation.test.js` — 5 tests (ISO-1 to ISO-4)
- `backend/src/routes/permissions.test.js` — 5 tests (PERM-1 to PERM-5)
- `backend/src/test/helpers.js` — shared test setup
- `backend/vitest.config.js` — test runner configuration

**Frontend screens**
- `frontend/src/pages/AccountsPage.jsx` — chart of accounts
- `frontend/src/pages/CustomersPage.jsx` — customer list with search, pagination, create drawer

### Everything modified

- `backend/prisma/schema.prisma` — added `RefreshToken` and `Party` models, plus `requestHash` on
  `IdempotencyKey`
- `backend/prisma/seed.js` — rewritten to create two organizations and four demo users
- `backend/src/db/client.js` — wrapped the Prisma client in the tenant extension
- `backend/src/index.js` — reduced to just starting the server
- `backend/eslint.config.js` — stopped linting Prisma's generated code
- `backend/package.json` — added `@node-rs/argon2` and `jsonwebtoken`
- `docs/openapi.yaml` — `/auth/refresh` now returns the user as well as the token
- `frontend/vite.config.js` — proxy to the backend
- `frontend/src/auth/AuthContext.jsx` — silent refresh when the app boots
- `frontend/src/components/ProtectedRoute.jsx` — wait during boot instead of redirecting
- `frontend/src/components/AppShell.jsx` — real navigation links, show user email
- `frontend/src/pages/RegisterPage.jsx` — removed the "Full name" field
- `frontend/src/mocks/handlers.js` — mock now models session state
- `frontend/src/main.jsx` — mocks behind a flag
- `frontend/src/App.jsx` — routes for the new pages
- `frontend/src/index.css` — styles for tables, badges, drawer, pagination

### Everything configured

- `JWT_SECRET` added to `backend/.env` (not committed — verified with `git ls-files backend/.env`,
  which returned nothing)
- Two database migrations applied
- Vitest configured to run test files one at a time
- Vite dev-server proxy so the browser and API share an origin

---

## 2. How it relates to the 7-day plan

This session is **Day 2 — Identity, tenancy, masters** (`ledgerline-7-day-plan_1.md`, line 1430).

### The plan's Day 2 goals for Developer A (backend)

> - Register / login / refresh / logout. Argon2id. Refresh rotation + reuse detection + family revocation.
> - `authenticate` → `resolveTenant` (membership-verified) → `authorize(permissionCode)` middleware chain.
> - **Prisma client extension** injecting `organizationId` on every model query. This is the highest-leverage hour of the week.
> - `audit_log` service + middleware, written post-commit.
> - `idempotency` middleware backed by the Postgres table.
> - Endpoints: `/auth/*`, `/orgs`, `/orgs/:id/members`, `/accounts`, `/parties`, `/fiscal-years`, `/periods`.
> - Tests: auth flow, rotation reuse detection, ISO-1..4, PERM-1..5.

### The plan's Day 2 goals for Developer B (frontend)

> - Auth wired to the real API; token-in-memory + refresh cookie; silent refresh on 401.
> - Org switcher (list memberships → set active org → invalidate all queries).
> - Chart of Accounts screen: tree by type, badges for control/bank accounts.
> - Customers: list with search + pagination, create/edit drawer with Zod validation shared from the server package.
> - Empty / loading / error states as a reusable pattern **now**, not on Day 7.

### Plan → Objective → What We Built → Why It Matters

| Plan objective | What we built | Why it matters |
|---|---|---|
| Argon2id auth with rotation + reuse detection | `lib/auth/password.js`, `tokens.js`, `refresh-tokens.js`, `routes/auth.js` | The plan (line 77) says every reviewer checks auth first. Rotation with reuse detection is what separates this from tutorial auth. |
| `authenticate → resolveTenant → authorize` chain | `middleware/authenticate.js`, `resolve-tenant.js`, `authorize.js` | Three separate questions — who are you, which company, may you do this — answered in order. Each is independently testable. |
| Prisma extension injecting `organizationId` | `db/tenant-extension.js`, `lib/request-context.js` | The plan calls this "the highest-leverage hour of the week". It makes the worst possible bug structurally impossible. |
| Audit log written post-commit | `lib/audit/audit-log.js`, `middleware/audit-log.js` | Mistake #10 on the plan's danger list: a rolled-back invoice must never fire a "posted" event. |
| Idempotency backed by Postgres | `lib/idempotency/run-idempotent.js` | Mistake #5: a retried payment POST must not become two payments. |
| The seven endpoint groups | `routes/auth.js`, `routes/orgs.js`, `routes/masters.js` | These are what the frontend needs to stop using mocks. |
| Tests: auth, rotation, ISO-1..4, PERM-1..5 | Three test files, 32 tests total | The plan (line 92) says this is what converts "nice demo" into "this person is careful". |
| Frontend wired to real API | `vite.config.js` proxy, `AuthContext.jsx`, `main.jsx` | Ends the mock-only phase. |
| Chart of Accounts screen | `pages/AccountsPage.jsx` | Grouped by type, with control/bank badges as the plan specifies. |
| Customers screen | `pages/CustomersPage.jsx` | Search, pagination, create drawer with validation. |

### What is completed

Everything in the Day 2 list above is done and verified. The 20:00 checkpoint from the plan is:

> log in as a real user → switch between two seeded orgs → see different customers and accounts in each

This was verified live. Logging in as `sunita@annapurnatrading.com.np` returns two organizations;
each shows its own customers, 27 accounts, and 12 accounting periods. The external auditor account
sees only Sherpa Ventures and receives a 403 when requesting Annapurna data.

Test counts: 32 backend tests, 18 frontend tests, all passing. Both projects lint clean.

### What is incomplete, and deliberately so

These are **not** Day 2 items — the plan schedules them later. Listing them so you know they are
absent by design, not by oversight:

- **Rate limiting** — needs Redis. Plan schedules it Day 6 (line 1525).
- **`.env.example` and environment validation at boot** — Day 6 (line 1525).
- **Postgres RLS as a second isolation layer** — Day 6, and only "if the suite is green by 15:00"
  (line 1526).
- **Swagger UI at `/api/v1/docs`** — Day 6 (line 1527).
- **`POST /accounts` audit "before" state** — we log creates; updates come later.
- **The `runIdempotent` helper has no caller yet.** It is built and correct, but nothing uses it
  until Day 3's payment routes exist. Its tests (IDEM-1..3) are assigned to Day 4 in the plan
  (line 1485).

### How this prepares the next days

**Day 3 (the posting engine)** needs three things this session provides: a way to know which
company a request belongs to (`resolveTenant` + the extension), a way to check `invoice.post`
permission (`authorize`), and an audit trail. The posting engine will call `postDocument()` inside
a Prisma transaction, and the idempotency helper is already shaped to wrap it.

**One constraint to carry into Day 3:** the tenant extension only protects models that have their
own `organizationId` column. Looking at `backend/prisma/schema.prisma`, `JournalLine` and
`AccountingPeriod` do not have one — they are scoped through their parent (`journalEntryId` and
`fiscalYearId`). The posting engine must filter through the parent explicitly. The `/periods` route
in `backend/src/routes/masters.js` already demonstrates the pattern.

**Day 4 (receipts)** will use `runIdempotent` for real and write the IDEM-1..3 tests.

**Days 3–5 frontend** now have a working API client, an org switcher, and a page pattern
(loading / error / empty states) to copy.

---

## 3. Files created and modified

### 3.1 Authentication library

---

**File:** `backend/src/lib/auth/password.js`

**Status:** Created

**Purpose:** Turns a plain-text password into a scrambled string that cannot be turned back, and
later checks whether a submitted password matches that scrambled string.

**Why does this file exist?** We must never store the actual password. If someone steals the
database, they should get useless scrambled text, not everyone's passwords. This file is the single
place where the hashing settings live — if we ever change them, we change them here and nowhere
else.

**How does it connect to other files?** It is called by `backend/src/lib/auth/register.js` (to
hash a new password), `backend/src/lib/auth/login.js` (to check a submitted password), and
`backend/prisma/seed.js` (to hash the demo password). It calls the `@node-rs/argon2` package.

```js
import { hash, verify } from '@node-rs/argon2';

const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export function hashPassword(plain) {
  return hash(plain, OPTIONS);
}

export function verifyPassword(plain, hashed) {
  return verify(hashed, plain);
}
```

#### Reading this code from zero

**Generic syntax — importing named things from a package**

```js
import { thingA, thingB } from 'package-name';
```

`import` pulls code written elsewhere into this file. The curly braces mean "give me these
specific named exports", not the whole package. `'package-name'` with no `./` in front means it
comes from `node_modules` (installed with `npm install`), not from your own files. A path starting
with `./` or `../` means one of your own files.

**In this project:**

```js
import { hash, verify } from '@node-rs/argon2';
```

We ask the `@node-rs/argon2` package for exactly two functions: `hash` and `verify`. The `@node-rs/`
prefix is a *scope* — a namespace so different publishers can use the same short name.

---

**Generic syntax — a module-level constant**

```js
const SETTINGS = { optionOne: 1, optionTwo: 2 };
```

`const` declares a value that cannot be reassigned. `{ ... }` is an object literal — a bag of
named values. Declared outside any function, it is created once when the file first loads, and
every function in the file can read it.

**In this project:**

```js
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
```

These are the three Argon2 difficulty settings. `memoryCost: 19456` means each hash needs about
19MB of memory. Putting them in one constant means both functions below use identical settings, and
changing them later is a one-line change. Uppercase naming is a convention meaning "this is a fixed
configuration value", not a rule the language enforces.

---

**Generic syntax — exporting a function**

```js
export function doSomething(input) {
  return transform(input);
}
```

`export` makes the function importable by other files. Without it the function exists only inside
this file. `function name(parameters) { ... }` declares it; `return` sends a value back to whoever
called it.

**In this project:**

```js
export function hashPassword(plain) {
  return hash(plain, OPTIONS);
}
```

- **Data in:** `plain` — a password as typed by the user, e.g. `"Demo@2026"`.
- **What happens:** calls the library's `hash` with the password and our fixed settings.
- **Data out:** a promise that resolves to a string like
  `$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$hashedvalue`. That string embeds the algorithm, the
  settings, and a random salt, which is why verification later needs nothing else.
- **Who calls it:** `register.js`, `login.js` (for the dummy hash), and `seed.js`.

---

**Generic syntax — argument order matters**

```js
libraryFunction(argumentA, argumentB);   // order is defined by the library, not by you
```

**In this project — the detail most people get wrong:**

```js
export function verifyPassword(plain, hashed) {
  return verify(hashed, plain);
}
```

Look carefully: our function takes `(plain, hashed)` but calls `verify(hashed, plain)` — the
arguments are **swapped**. That is not a bug. The `@node-rs/argon2` library defines `verify` as
`verify(storedHash, candidatePassword)`. We chose the opposite order for our own function because
`(plain, hashed)` reads more naturally at the call site.

This is exactly the kind of thing a wrapper file is *for*: the library's awkward ordering is
absorbed here once, so no caller ever has to remember it.

- **Data in:** the password someone just typed, and the hash stored in the database.
- **Data out:** a promise resolving to `true` or `false`.
- **Where the comparison happens:** inside the library, in constant time — meaning it always takes
  the same duration regardless of how much of the hash matches. A naive `===` comparison would
  return faster on an early mismatch, leaking information one character at a time.

**What happens at runtime:** when someone logs in, `login.js` calls `verifyPassword`, which calls
the library, which re-runs the same Argon2 computation on the submitted password using the salt and
settings read out of the stored hash, then compares the results. This takes roughly 50 milliseconds
— deliberately slow, as explained in section 4.3.

---

**File:** `backend/src/lib/auth/tokens.js`

**Status:** Created

**Purpose:** Creates and checks the two kinds of tokens the system uses — a short-lived access
token (a JWT) and a long-lived refresh token (a random string).

**Why does this file exist?** Token creation has security-critical details (which algorithm, how
long they last, how much randomness). Keeping them in one file means those decisions are made once.

**How does it connect to other files?** Called by `register.js`, `login.js`, `refresh-tokens.js`,
`routes/auth.js`, and `middleware/authenticate.js`. It calls the `jsonwebtoken` package and Node's
built-in `crypto`.

```js
import jwt from 'jsonwebtoken';
import { randomBytes, randomUUID, createHash } from 'node:crypto';

const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function signAccessToken(userId) {
  return jwt.sign({ sub: userId, jti: randomUUID() }, process.env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: ACCESS_TOKEN_TTL,
  });
}

export function verifyAccessToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
}

export function generateRefreshToken() {
  const raw = randomBytes(32).toString('base64url');
  return {
    raw,
    tokenHash: hashRefreshToken(raw),
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  };
}

export function hashRefreshToken(raw) {
  return createHash('sha256').update(raw).digest('hex');
}
```

#### Reading this code from zero

**Generic syntax — default vs named imports**

```js
import wholeThing from 'package';        // default export — you choose the name
import { partA, partB } from 'package';  // named exports — names must match
```

A package can export one "default" thing plus any number of named things. With a default import
you pick the local name; with named imports you must use the exact names the package published.

**In this project:**

```js
import jwt from 'jsonwebtoken';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
```

`jwt` is our chosen name for the whole `jsonwebtoken` library, so we call `jwt.sign(...)` and
`jwt.verify(...)`. From `crypto` we take three specific functions.

The `node:` prefix means this module is **built into Node itself** — nothing was installed for it.
The prefix makes that explicit, so a reader never has to wonder whether `crypto` is ours, a
dependency, or Node's.

---

**Generic syntax — computing a constant from readable parts**

```js
const DURATION_MS = days * hours * minutes * seconds * milliseconds;
```

**In this project:**

```js
const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
```

TTL means "time to live" — how long something stays valid.

The second line evaluates to `604800000`, but nobody can read that number and see "seven days".
Written as `7 * 24 * 60 * 60 * 1000` it says *7 days × 24 hours × 60 minutes × 60 seconds × 1000
milliseconds*. JavaScript computes it once at load time, so there is no performance cost — the
multiplication exists purely for the human reading it.

The two formats differ because they go to different places: `'15m'` is handed to the `jsonwebtoken`
library, which understands that shorthand; the millisecond number is used with JavaScript's `Date`,
which works in milliseconds.

---

**Generic syntax — passing an options object**

```js
library.doThing(data, secret, { setting: 'value', another: 123 });
```

Many libraries take required arguments first and a single object of optional settings last. This
keeps call sites readable — you see setting names, not a row of anonymous values.

**In this project:**

```js
export function signAccessToken(userId) {
  return jwt.sign({ sub: userId, jti: randomUUID() }, process.env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: ACCESS_TOKEN_TTL,
  });
}
```

Three arguments to `jwt.sign`:

1. **The payload** — `{ sub: userId, jti: randomUUID() }`. This is the data stored inside the
   token. `sub` ("subject") is standard JWT vocabulary for *who the token is about*. `jti`
   ("JWT ID") is a unique ID for this individual token. `randomUUID()` generates something like
   `f47ac10b-58cc-4372-a567-0e02b2c3d479`.
2. **The secret** — `process.env.JWT_SECRET`.
3. **The options** — which algorithm, and how long it lives.

**What is `process.env`?** `process` is a global object Node provides, describing the running
program. `process.env` holds *environment variables* — configuration passed in from outside the
code. `JWT_SECRET` lives in `backend/.env`, which is git-ignored.

**Why not just write the secret in the file?** Because the file is committed to git. Anyone with
repository access could forge tokens for any user. Environment variables keep secrets out of source
control, and let production use a different secret from development.

- **Data in:** a user's ID string.
- **Data out:** a long string of three dot-separated chunks, e.g.
  `eyJhbGciOiJIUzI1NiIs...eyJzdWIiOiJlMmZk...ONgypUyZ5I65u003`.
- **Who calls it:** `register.js`, `login.js`, and `routes/auth.js` (the refresh route).

---

**Generic syntax — restricting what a verifier accepts**

```js
library.verify(input, secret, { allowed: ['safeOption'] });
```

**In this project:**

```js
export function verifyAccessToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
}
```

`jwt.verify` recomputes the signature from the token's contents plus the secret and compares it to
the signature the token carries. Match → returns the payload. Mismatch, tampering, or expiry →
**throws** an error rather than returning `false`. That is why the caller in
`backend/src/middleware/authenticate.js` wraps it in `try` / `catch`.

`algorithms: ['HS256']` is a whitelist, and it is genuinely load-bearing. A JWT states its own
algorithm in its header. Without a whitelist, an attacker can craft a token whose header says
`"alg": "none"` — meaning "no signature" — and some libraries will happily accept it as valid.
Naming the one algorithm we accept makes that attack impossible.

---

**Generic syntax — method chaining**

```js
const result = start(x).then(y).finish(z);
```

Each call returns an object that has the next method on it, so calls can be strung together left to
right. It reads as a pipeline: do this, then this, then this.

**In this project:**

```js
export function hashRefreshToken(raw) {
  return createHash('sha256').update(raw).digest('hex');
}
```

Read left to right:

- `createHash('sha256')` — create an empty hashing machine using the SHA-256 algorithm.
- `.update(raw)` — feed our token string into it.
- `.digest('hex')` — finish, and give the result as hexadecimal text (characters `0`–`9` and
  `a`–`f`), which is safe to store in a normal text database column.

**Data in / data out:** in goes a random token like `f0hxyF04MOlKH3Dvjh...`; out comes a fixed
64-character hex string. Same input always gives the same output — which is exactly what makes
lookup possible. We store the hash, and when a token arrives we hash it the same way and search for
a matching row.

---

**Generic syntax — returning multiple values as an object**

```js
function makeThing() {
  const a = compute();
  return { a, b: derive(a), c: somethingElse() };
}
```

A function can only return one value, so when you need several you return an object holding them.
`{ a }` is shorthand for `{ a: a }` when the property name matches the variable name.

**In this project:**

```js
export function generateRefreshToken() {
  const raw = randomBytes(32).toString('base64url');
  return {
    raw,
    tokenHash: hashRefreshToken(raw),
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  };
}
```

- `randomBytes(32)` — 32 bytes (256 bits) of cryptographically secure randomness. Not
  `Math.random()`, which is predictable and must never be used for security.
- `.toString('base64url')` — converts raw bytes into text safe to put in a cookie (no `+`, `/`, or
  `=` characters that would need escaping).
- `Date.now()` — the current time as a number of milliseconds since 1 January 1970. Adding
  `REFRESH_TOKEN_TTL_MS` gives a moment seven days in the future; `new Date(...)` turns that number
  into a date object the database can store.

**Why return all three together?** The caller needs each for a different destination, and they must
be consistent with each other:

- `raw` goes into the cookie sent to the browser — this is the only place it ever exists in
  readable form.
- `tokenHash` goes into the database — so a database leak yields hashes, not usable tokens.
- `expiresAt` goes into the database — so the token can be rejected after seven days.

**Who calls it:** `issueRefreshToken` in `backend/src/lib/auth/refresh-tokens.js`.

---

**File:** `backend/src/lib/auth/refresh-tokens.js`

**Status:** Created

**Purpose:** Manages the lifecycle of refresh tokens in the database: creating them, swapping an
old one for a new one, detecting theft, and revoking them.

**Why does this file exist?** Three different routes (`register`, `login`, `refresh`) all need to
create a refresh token the same way. Duplicating "hash it, set a 7-day expiry, insert a row" in
three places is how one of them eventually forgets the reuse-detection check.

**How does it connect to other files?** Called by `register.js`, `login.js`, and `routes/auth.js`.
It calls `tokens.js` (for hashing and generating) and `db/client.js` (for database access).

```js
export async function rotateRefreshToken(rawToken) {
  const tokenHash = hashRefreshToken(rawToken);
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });

  if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
    return { error: 'invalid' };
  }

  if (stored.usedAt) {
    await prisma.refreshToken.updateMany({
      where: { familyId: stored.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { error: 'reused' };
  }

  await prisma.refreshToken.update({
    where: { id: stored.id },
    data: { usedAt: new Date() },
  });

  const { raw, familyId } = await issueRefreshToken(stored.userId, stored.familyId);
  return { raw, familyId, userId: stored.userId };
}
```

#### Reading this code from zero

**Generic syntax — `async` and `await`**

```js
async function doWork() {
  const result = await slowOperation();
  return result;
}
```

Some operations take real time — reading a database, calling another server. JavaScript does not
freeze while waiting; it goes off and does other work, then comes back.

`async` marks a function as one that contains waiting. `await` means "pause *this function* here
until that finishes, then continue with the result". Other requests keep being served meanwhile.

Without `await`, you get a *promise* — an IOU for a future value — instead of the value itself. A
very common beginner bug is forgetting `await` and then wondering why a variable holds
`Promise { <pending> }` instead of data.

An `async` function always returns a promise, which is why callers must `await` it too.

**In this project:**

```js
export async function rotateRefreshToken(rawToken) {
  const tokenHash = hashRefreshToken(rawToken);
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });
```

Line 1 has no `await` — hashing is pure computation, instant. Line 2 has `await` because it goes to
PostgreSQL over a network connection.

---

**Generic syntax — a database read with Prisma**

```js
const row = await prisma.modelName.findUnique({ where: { uniqueColumn: value } });
```

`prisma` is the database client. `.modelName` is one model from `schema.prisma`, lowercased.
`findUnique` fetches at most one row and requires the `where` to name a column marked unique.

**In this project:**

```js
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });
```

`refreshToken` corresponds to `model RefreshToken` in `backend/prisma/schema.prisma`, where
`tokenHash String @unique` makes this lookup legal.

`{ where: { tokenHash } }` is shorthand for `{ where: { tokenHash: tokenHash } }`.

**Data out:** either the matching row as an object (`{ id, userId, familyId, usedAt, ... }`) or
`null` if nothing matched. `findUnique` returns `null` rather than throwing, which is why the next
line can simply test for it.

---

**Generic syntax — an early-exit guard**

```js
if (badCondition1 || badCondition2 || badCondition3) {
  return { error: 'reason' };
}
```

`||` is logical OR — true if *any* condition is true. Checking failure cases first and returning
immediately is called a *guard clause*. It keeps the successful path unindented at the bottom
instead of buried inside nested `if` blocks.

**In this project:**

```js
  if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
    return { error: 'invalid' };
  }
```

Three ways a token can be unusable:

- `!stored` — `!` means NOT. No such token exists. Note this must be checked **first**: if `stored`
  is `null`, then `stored.revokedAt` would crash. JavaScript's `||` stops evaluating as soon as
  something is true, so the later checks never run when the first one fires. This is called
  *short-circuit evaluation*, and here it is what prevents a crash.
- `stored.revokedAt` — this column is `DateTime?` in the schema; the `?` means it can be null. Null
  means "not revoked". Any date in it means revoked. In JavaScript a date object is *truthy* and
  `null` is *falsy*, so the bare property works as a test.
- `stored.expiresAt < new Date()` — `new Date()` is right now. If the expiry moment is earlier than
  now, it has passed.

Notice all three failures return the same `{ error: 'invalid' }`. The route turns that into one
generic 401. Telling a caller *why* their token failed would help an attacker probe the system.

---

**Generic syntax — updating many rows at once**

```js
await prisma.model.updateMany({
  where: { matchColumn: value },
  data: { columnToSet: newValue },
});
```

`updateMany` changes every row matching `where`. Contrast `update`, which targets exactly one row
by unique key and throws if it does not exist.

**In this project — the reuse-detection branch:**

```js
  if (stored.usedAt) {
    await prisma.refreshToken.updateMany({
      where: { familyId: stored.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { error: 'reused' };
  }
```

`stored.usedAt` being set means this token was already swapped for a newer one. A legitimate client
never does that — it always holds the newest token. So its reappearance means someone has a copy.

The `where` has two conditions, combined with AND (listing two properties in one object means both
must match):

- `familyId: stored.familyId` — every token descended from the same original login.
- `revokedAt: null` — only ones not already revoked, so we do not overwrite earlier revocation
  timestamps.

`data: { revokedAt: new Date() }` stamps them all as revoked right now.

**Why `updateMany` and not `delete`?** Deleting destroys the evidence. A revoked row with a
timestamp is a record that a theft was detected, which matters for an audit trail.

---

**Generic syntax — default parameter values**

```js
function doThing(required, optional = makeDefault()) { ... }
```

If the caller omits the second argument, the default expression runs. If they pass one, theirs is
used.

**In this project** (from the same file, just above `rotateRefreshToken`):

```js
export async function issueRefreshToken(userId, familyId = randomUUID()) {
```

This one default is what makes families work:

- **Logging in fresh** — `issueRefreshToken(user.id)` with no second argument. A brand-new
  `familyId` is generated: a new session, unrelated to any previous one.
- **Rotating** — `issueRefreshToken(stored.userId, stored.familyId)` passes the existing family, so
  the new token joins the chain.

One default parameter is the entire mechanism linking a token to its ancestors.

---

**Putting the whole function together — what happens at runtime**

A browser POSTs to `/api/v1/auth/refresh` carrying its cookie:

1. `routes/auth.js` extracts the raw token from the cookie header and calls `rotateRefreshToken`.
2. The raw token is hashed and looked up.
3. **Not found / revoked / expired?** → `{ error: 'invalid' }` → the route responds 401 and clears
   the cookie.
4. **Already used?** → every live token in the family is revoked → `{ error: 'reused' }` → 401. The
   attacker *and* the real user are now logged out; the real user simply logs in again.
5. **Valid and unused?** → mark it used → issue a successor in the same family → return
   `{ raw, familyId, userId }`.
6. The route puts the new `raw` into a fresh cookie and returns a new access token.

**What calls this file:** `backend/src/routes/auth.js`.
**What this file calls:** `tokens.js` (hashing and generating) and `db/client.js` (the database).

---

**File:** `backend/src/lib/auth/register.js`

**Status:** Created

**Purpose:** The business logic for creating an account: reject duplicate emails, hash the
password, save the user, issue tokens.

**Why does this file exist?** Separating this from the HTTP route means the logic can be tested and
reused without pretending to be a web request. The route deals with HTTP; this file deals with
"what does registering mean".

**How does it connect to other files?** Called by `backend/src/routes/auth.js`. It calls
`password.js`, `refresh-tokens.js`, `tokens.js`, and `db/client.js`.

```js
export async function registerUser(email, password) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    const err = new Error('Email already registered');
    err.status = 400;
    err.code = 'email_taken';
    throw err;
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({ data: { email, passwordHash } });

  const accessToken = signAccessToken(user.id);
  const { raw: refreshToken } = await issueRefreshToken(user.id);

  return { user, accessToken, refreshToken };
}
```

#### Reading this code from zero

**Generic syntax — throwing an error with extra information attached**

```js
const err = new Error('Human readable message');
err.status = 400;
err.code = 'machine_readable_code';
throw err;
```

`new Error(...)` creates an error object. `throw` stops the function immediately and hands the
error up to whoever called it — and up again, until something catches it.

JavaScript errors only carry a `message` by default. But an HTTP API needs a status code too. Since
JavaScript objects are open, we simply attach extra properties.

**In this project:**

```js
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    const err = new Error('Email already registered');
    err.status = 400;
    err.code = 'email_taken';
    throw err;
  }
```

Two audiences, two fields:

- `message` — for a human reading a screen.
- `code` — for the frontend to branch on. Code should never match on message text, because
  rewording the message would silently break it.

**Where does the thrown error end up?** Trace it:

1. Thrown here in `register.js`.
2. `routes/auth.js` called this inside a `try` block, so its `catch (err)` runs.
3. That catch calls `next(err)`.
4. Express jumps to the error handler in `app.js`, which reads `err.status` and `err.code`.

Result: `HTTP 400` with `{"error":{"code":"email_taken","message":"Email already registered",...}}`.

**Why check for an existing email at all,** when the schema already has `email String @unique`?
Because the database would reject the insert with a cryptic Prisma error (`P2002`) producing a 500.
Checking first produces a clear 400. The unique constraint stays as the real guarantee — if two
registrations race, the database still wins.

---

**Generic syntax — renaming while destructuring**

```js
const { originalName: newName } = someObject;
```

Normally `const { a } = obj` creates a variable called `a`. With a colon you rename it: the value of
`obj.originalName` lands in a variable called `newName`.

**In this project:**

```js
  const { raw: refreshToken } = await issueRefreshToken(user.id);
```

`issueRefreshToken` returns `{ raw, familyId }`. We want only `raw`, and inside this file a variable
called `raw` would be vague — raw *what*? Renaming it to `refreshToken` at the point of extraction
makes the next line self-explanatory. `familyId` is simply not extracted, because this function has
no use for it.

---

**Generic syntax — building the return value**

```js
return { a, b, c };
```

**In this project:**

```js
  return { user, accessToken, refreshToken };
}
```

Three values, each with a different destination once the route gets them:

- `user` — becomes JSON in the response body (but only `id` and `email`; the route strips the rest,
  because `user` here is the full database row *including `passwordHash`*, which must never leave
  the server).
- `accessToken` — also JSON, and the browser keeps it in memory.
- `refreshToken` — **not** JSON. The route puts it in an httpOnly cookie so JavaScript can never
  read it.

This is why the service returns plain data instead of sending the response itself: the same three
values need three different treatments, and deciding that is the route's job, not this file's.

---

**What happens at runtime — the full registration path**

Someone submits the sign-up form:

1. `routes/auth.js` validates the body with Zod (`.strict()`, minimum 8-character password).
2. It calls `registerUser(email, password)`.
3. **Check** — is this email taken? If yes, throw, and the user sees a 400.
4. **Hash** — `hashPassword(password)` runs Argon2, taking about 50ms of deliberate slowness.
5. **Insert** — `prisma.user.create` writes the row. Note it stores `passwordHash`, never
   `password`; the plain text exists only in memory during this request and is never written
   anywhere.
6. **Access token** — signed immediately, valid 15 minutes.
7. **Refresh token** — a new row with a brand-new `familyId` (no second argument passed).
8. Return all three; the route sets the cookie and responds `201 Created`.

**What calls this file:** `backend/src/routes/auth.js`.
**What this file calls:** `password.js`, `tokens.js`, `refresh-tokens.js`, `db/client.js`.

**Why is this separate from the route?** The route deals in HTTP — headers, cookies, status codes.
This file deals in *meaning* — what it is to register. Keeping them apart means this logic could be
called from a CLI script or a test without inventing a fake HTTP request.

---

**File:** `backend/src/lib/auth/login.js`

**Status:** Created

**Purpose:** Checks an email and password, and issues tokens if they are correct.

**Why does this file exist?** Same reason as `register.js` — business logic separate from HTTP. It
also contains a subtle security measure explained in section 4.

**How does it connect to other files?** Called by `backend/src/routes/auth.js`. It calls
`password.js`, `refresh-tokens.js`, `tokens.js`, and `db/client.js`.

```js
let dummyHashPromise;
function getDummyHash() {
  if (!dummyHashPromise) dummyHashPromise = hashPassword('not-a-real-password-000');
  return dummyHashPromise;
}

export async function loginUser(email, password) {
  const user = await prisma.user.findUnique({ where: { email } });
  const hashToCheck = user ? user.passwordHash : await getDummyHash();
  const valid = await verifyPassword(password, hashToCheck);

  if (!user || !valid) {
    const err = new Error('Invalid email or password');
    err.status = 401;
    err.code = 'invalid_credentials';
    throw err;
  }

  const accessToken = signAccessToken(user.id);
  const { raw: refreshToken } = await issueRefreshToken(user.id);

  return { user, accessToken, refreshToken };
}
```

#### Reading this code from zero

**Generic syntax — a lazily computed, cached value**

```js
let cached;
function getCached() {
  if (!cached) cached = expensiveComputation();
  return cached;
}
```

`let` (unlike `const`) allows reassignment. Declared with no value, `cached` starts as `undefined`,
which is falsy — so `!cached` is true the first time. The expensive work runs once; every later
call returns the stored result.

This pattern is called *memoisation* or *lazy initialisation*. "Lazy" because the work is deferred
until first needed, rather than done when the file loads.

**In this project:**

```js
let dummyHashPromise;
function getDummyHash() {
  if (!dummyHashPromise) dummyHashPromise = hashPassword('not-a-real-password-000');
  return dummyHashPromise;
}
```

Note what is cached: the **promise**, not the resolved string. `hashPassword` is async, so it
returns a promise immediately. Storing the promise means that even if ten logins arrive
simultaneously on a cold server, Argon2 runs once — all ten `await` the same promise.

Caching this is safe because the value never changes. It is a fixed throwaway string hashed with
fixed settings.

---

**Generic syntax — the ternary (conditional) operator**

```js
const value = condition ? valueIfTrue : valueIfFalse;
```

A compact `if`/`else` that produces a value. Read it as: *if condition, then this, otherwise that.*

**In this project — the line that prevents a timing attack:**

```js
export async function loginUser(email, password) {
  const user = await prisma.user.findUnique({ where: { email } });
  const hashToCheck = user ? user.passwordHash : await getDummyHash();
  const valid = await verifyPassword(password, hashToCheck);
```

If a user was found, check against their real hash. If not, check against the dummy hash.

**Why not just stop when no user is found?** Because Argon2 takes ~50ms. Returning early would make
"unknown email" answer in ~2ms while "wrong password" takes ~52ms. An attacker measuring response
times could then discover which email addresses are registered — without ever guessing a password.
This is a **timing attack**, and it is defeated by making both paths do the same work. Section 4.3
covers it in full.

Note `await` appears *inside* the ternary, on the branch that needs it. That is legal, and it means
the dummy hash is only awaited when actually used.

---

**Generic syntax — combining conditions to produce one outcome**

```js
if (!thingA || !thingB) {
  throw sameErrorForBoth;
}
```

**In this project:**

```js
  if (!user || !valid) {
    const err = new Error('Invalid email or password');
    err.status = 401;
    err.code = 'invalid_credentials';
    throw err;
  }
```

Two genuinely different failures — no such account, and wrong password — produce **one identical
error**. Deliberately.

If the API said "no account with that email", anyone could submit a list of addresses and learn
which ones are registered. That is called *user enumeration*. For a financial system it also leaks
who your customers are.

`401` means "not authenticated" (we do not know who you are), distinct from `403`, which means
"authenticated, but not allowed". Getting these two confused is one of the most common API
mistakes.

There is a test in `backend/src/routes/auth.test.js` asserting both paths return the same `code`
*and* the same `message`, so a future edit cannot reintroduce the leak.

---

**What happens at runtime — the full login path**

1. `routes/auth.js` validates the body. Note its `loginSchema` uses `z.string()` for the password
   with **no** `.min(8)` — a too-short password must fail as *wrong credentials*, not as a
   validation error, or the different response shape would itself leak information.
2. `loginUser(email, password)` runs.
3. Look up the user by email.
4. Pick the real hash or the dummy hash.
5. Run Argon2 verification (~50ms either way).
6. Wrong on either count → identical 401.
7. Correct → sign a 15-minute access token, insert a new refresh token row with a fresh family.
8. The route sets the cookie and responds 200.

**What calls this file:** `backend/src/routes/auth.js`.
**What this file calls:** `password.js`, `tokens.js`, `refresh-tokens.js`, `db/client.js`.

---

### 3.2 Middleware

---

**File:** `backend/src/middleware/authenticate.js`

**Status:** Created

**Purpose:** Reads the access token from the request header, verifies it, and attaches the user's
ID to the request object. Rejects the request with 401 if the token is missing or invalid.

**Why does this file exist?** Every protected route needs to know who is calling. Doing this check
in each route would be repeated 20 times and eventually one route would forget.

**How does it connect to other files?** Used by `routes/orgs.js` and `routes/masters.js`. It calls
`lib/auth/tokens.js`.

```js
export function authenticate(req, res, next) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    const err = new Error('Missing access token');
    err.status = 401;
    err.code = 'unauthenticated';
    return next(err);
  }

  try {
    req.userId = verifyAccessToken(token).sub;
    next();
  } catch {
    const err = new Error('Invalid or expired access token');
    err.status = 401;
    err.code = 'unauthenticated';
    next(err);
  }
}
```

#### Reading this code from zero

**Generic syntax — the shape of Express middleware**

```js
export function myMiddleware(req, res, next) {
  // inspect or modify req
  next();          // continue to the next middleware
}
```

Express calls this function for matching requests and passes three things:

- `req` — the incoming request. Read headers from it; attach your own properties to it.
- `res` — the outgoing response. Use it to send data.
- `next` — a function meaning "I am finished, continue".

Exactly one of three things must happen, or the request hangs forever with the browser spinning:
send a response, call `next()`, or call `next(err)`.

**In this project:**

```js
export function authenticate(req, res, next) {
```

Note it is **not** `async`, even though most of our code is. Verifying a JWT is pure computation
using a secret already in memory — no database, no network. So there is nothing to await.

`res` is never used here. It is still declared because Express identifies middleware by its
argument count, and skipping the third parameter would shift `next` into the wrong position.

---

**Generic syntax — optional chaining and the conditional operator together**

```js
const value = maybeMissing?.method() ? extractFrom(maybeMissing) : null;
```

`?.` is *optional chaining*: if the thing on the left is `null` or `undefined`, the whole expression
becomes `undefined` instead of throwing "cannot read property of undefined".

**In this project:**

```js
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
```

`req.headers` is an object of every header the browser sent. Express lowercases the names, which is
why it is `authorization`, not `Authorization`.

If the header is absent, `req.headers.authorization` is `undefined`. Calling `.startsWith()` on
`undefined` would crash the whole server, so `?.` guards it.

**What is `'Bearer '`?** An HTTP convention. The header looks like:

```
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

The word `Bearer` declares the credential type — "whoever bears this token is authorised". The
token itself starts after it.

**Why `slice(7)`?** `'Bearer '` is exactly 7 characters including the trailing space. `slice(7)`
returns everything from index 7 onward — the token with the prefix removed. Counting characters by
hand is fragile, but it is the conventional way this is written.

---

**Generic syntax — `return next(err)` as an early exit**

```js
if (problem) {
  return next(err);
}
```

`next(err)` does not stop execution by itself — the function keeps running after it. `return` is
what stops it. Forgetting the `return` here is a classic bug: the error handler runs *and* the
normal path continues, often producing "Cannot set headers after they are sent to the client".

**In this project:**

```js
  if (!token) {
    const err = new Error('Missing access token');
    err.status = 401;
    err.code = 'unauthenticated';
    return next(err);
  }
```

**The critical distinction:** `next()` with no argument means "carry on normally". `next(err)` with
an argument means "something failed — skip every remaining normal middleware and jump straight to
the error handler". That one argument is the entire difference.

---

**Generic syntax — try / catch**

```js
try {
  riskyThing();
} catch {
  handleFailure();
}
```

Code in `try` runs normally. If anything inside throws, execution jumps immediately to `catch`.

Modern JavaScript allows `catch` with no parameter when you do not need the error object. Older
code writes `catch (err)` even when `err` is unused.

**In this project:**

```js
  try {
    req.userId = verifyAccessToken(token).sub;
    next();
  } catch {
    const err = new Error('Invalid or expired access token');
    err.status = 401;
    err.code = 'unauthenticated';
    next(err);
  }
```

**Why `try`/`catch` is required here:** `jwt.verify` signals failure by **throwing**, not by
returning `false`. Without a catch, an expired token would crash out as an unhandled error and
produce a 500 — telling the user "server broken" when the truth is "your session expired".

**Why we discard the original error:** the library's message might be `jwt expired` or
`invalid signature`. Both are replaced with one generic message, because telling an attacker
*which* part of their forged token was wrong helps them iterate.

**What `.sub` is:** `verifyAccessToken` returns the decoded payload — the object we signed in
`tokens.js`, which was `{ sub: userId, jti: ... }`. So `.sub` is the user's ID.

**What `req.userId = ...` does:** attaches the ID to the request object. This is how middleware
passes information forward. Everything later in the chain — `resolveTenant`, `authorize`, the route
handler, the audit log — reads `req.userId`. Nothing is returned; the request object *is* the
shared workspace.

---

**What happens at runtime**

For `GET /api/v1/parties` with a valid token:

1. Express reaches `router.use(authenticate, resolveTenant)` in `masters.js`.
2. `authenticate` reads the header, strips `Bearer `, verifies the signature against `JWT_SECRET`,
   and checks the expiry timestamp.
3. Valid → `req.userId` is set → `next()` → `resolveTenant` runs.
4. Missing, malformed, tampered, or expired → 401, and **no database query ever happens**.

**What calls this file:** `backend/src/routes/orgs.js` and `backend/src/routes/masters.js`.
**What this file calls:** `backend/src/lib/auth/tokens.js`.

---

**File:** `backend/src/middleware/resolve-tenant.js`

**Status:** Created

**Purpose:** Figures out which organization this request is about, checks that the user is actually
a member of it, and puts that organization ID into a context that the database layer can read.

**Why does this file exist?** This is the gate that makes multi-tenancy safe. The browser sends a
header saying "I want to work in company X", but a header is just a claim — anyone can type
anything. This file verifies the claim against the `Membership` table.

**How does it connect to other files?** Used by `routes/orgs.js` and `routes/masters.js`. It calls
`lib/request-context.js` and `db/client.js`. Everything downstream (the tenant extension,
`authorize`) depends on what it sets.

```js
export function resolveTenantFrom(getOrgId) {
  return async (req, res, next) => {
    const parsed = orgIdSchema.safeParse(getOrgId(req));
    if (!parsed.success) {
      const err = new Error('Organization id missing or malformed');
      err.status = 400;
      err.code = 'org_header_invalid';
      return next(err);
    }
    const organizationId = parsed.data;

    // Runs BEFORE requestContext.run — there is no tenant context to filter by
    // yet, which is exactly why the tenant extension must leave this query alone.
    const membership = await prisma.membership.findFirst({
      where: { userId: req.userId, organizationId, isActive: true },
    });

    if (!membership) {
      const err = new Error('Not a member of this organization');
      err.status = 403;
      err.code = 'forbidden';
      return next(err);
    }

    req.organizationId = organizationId;
    req.roleId = membership.roleId;

    requestContext.run({ organizationId }, next);
  };
}

export const resolveTenant = resolveTenantFrom((req) => req.headers['x-organization-id']);
```

#### Reading this code from zero

**Generic syntax — a function that returns a function (a factory)**

```js
function makeHandler(setting) {
  return function actualHandler(req, res, next) {
    useThe(setting);
    next();
  };
}

const handlerA = makeHandler('one');
const handlerB = makeHandler('two');
```

The outer function is a *factory*: it does not do the work, it manufactures a worker with a setting
baked in. The inner function keeps access to `setting` even after the outer one has returned. That
retained access is called a **closure**.

**Why bother?** Express requires middleware to have exactly the shape `(req, res, next)`. There is
no slot for "and also use this setting". A factory smuggles the setting in via closure.

**In this project:**

```js
export function resolveTenantFrom(getOrgId) {
  return async (req, res, next) => {
    const parsed = orgIdSchema.safeParse(getOrgId(req));
```

`getOrgId` is not a value — it is *a function describing where to look*. Two routes need tenancy
from two different places, so we manufacture two middlewares from one recipe:

```js
export const resolveTenant = resolveTenantFrom((req) => req.headers['x-organization-id']);
```

and in `backend/src/routes/orgs.js`:

```js
const resolveTenantFromPath = resolveTenantFrom((req) => req.params.id);
```

Most routes carry the organization in a header. But `/orgs/:id/members` has it in the URL, because
the OpenAPI contract defines it that way. Without the factory we would have two near-identical
copies of this security-critical middleware — and eventually a fix applied to only one of them.

**Reading `(req) => req.headers['x-organization-id']`:** an *arrow function*, shorthand for
`function (req) { return req.headers['x-organization-id']; }`. With no braces, the body is the
return value automatically.

**Why bracket notation?** `req.headers.x-organization-id` is invalid JavaScript — the hyphens would
be read as subtraction. Any property name containing hyphens needs `['...']`.

Header lookups are lowercase because Express normalises them. The browser sends
`X-Organization-Id`; Express stores it as `x-organization-id`.

---

**Generic syntax — validating without throwing**

```js
const result = schema.safeParse(value);
if (!result.success) { /* invalid */ }
const clean = result.data;
```

Zod offers two validators. `.parse()` throws on invalid input. `.safeParse()` never throws — it
returns `{ success: true, data }` or `{ success: false, error }`.

**In this project:**

```js
const orgIdSchema = z.string().uuid();

    const parsed = orgIdSchema.safeParse(getOrgId(req));
    if (!parsed.success) {
      const err = new Error('Organization id missing or malformed');
      err.status = 400;
      err.code = 'org_header_invalid';
      return next(err);
    }
    const organizationId = parsed.data;
```

`.safeParse` is chosen over `.parse` because we want a specific `org_header_invalid` code, not the
generic `validation_error` the error handler produces for thrown Zod errors.

`z.string().uuid()` checks the value is a string in UUID format. This catches a missing header
(`undefined` is not a string) and a malformed one in a single check — and, importantly, it means a
junk value never reaches the database query below.

---

**Generic syntax — a database query that answers "does a relationship exist?"**

```js
const match = await prisma.model.findFirst({ where: { colA: x, colB: y } });
if (!match) { /* no such relationship */ }
```

`findFirst` returns the first matching row or `null`. Multiple properties inside one `where` are
combined with **AND** — every one must match.

**In this project — the single most security-critical query in the codebase:**

```js
    // Runs BEFORE requestContext.run — there is no tenant context to filter by
    // yet, which is exactly why the tenant extension must leave this query alone.
    const membership = await prisma.membership.findFirst({
      where: { userId: req.userId, organizationId, isActive: true },
    });

    if (!membership) {
      const err = new Error('Not a member of this organization');
      err.status = 403;
      err.code = 'forbidden';
      return next(err);
    }
```

Three conditions, all required:

- `userId: req.userId` — the user proven by `authenticate`. **Not** anything the browser claimed.
- `organizationId` — the organization the browser asked for.
- `isActive: true` — a revoked membership row remains for audit purposes but must not grant access.

**Why this query is the whole point.** `X-Organization-Id` is just a header, and a header is only a
*claim* — anyone can type any UUID. This query is where the claim is checked against reality. Test
ISO-2 in `backend/src/routes/isolation.test.js` proves it: user Bob sending Alice's organization ID
gets 403.

**Why `403` and not `401`:** we know exactly who you are (401 would mean we do not). You are simply
not a member.

**The ordering detail the comment flags:** this query runs *before* `requestContext.run(...)`. So
at this moment there is no organization in context, and the tenant extension in
`db/tenant-extension.js` sees `undefined` and leaves the query untouched. That is necessary — you
cannot tenant-filter the very query that decides which tenant you may enter. It would be circular.

---

**Generic syntax — running the rest of the work inside a context**

```js
storage.run(value, callbackToRunInside);
```

**In this project — the last three lines:**

```js
    req.organizationId = organizationId;
    req.roleId = membership.roleId;

    requestContext.run({ organizationId }, next);
```

The first two lines attach data to the request for later middleware to read directly:

- `req.organizationId` — used by `/periods` in `masters.js`, which must filter manually.
- `req.roleId` — used by `authorize()` to look up permissions.

The third line is the important one. Instead of the usual bare `next()`, we pass `next` **into**
`requestContext.run`. Read it as: *"establish a context containing this organization ID, and run
the remainder of the request inside it."*

Everything that happens from here — `authorize`, the route handler, every Prisma query, even code
several `await`s deep — can call `requestContext.getStore()` and see `{ organizationId }`. Two
requests being handled at the same time each get their own isolated context; they cannot see each
other's.

This is what lets `backend/src/routes/masters.js` write:

```js
const accounts = await prisma.account.findMany({ where: {} });
```

with no organization filter, and still have the correct filter applied. Section 4.7 covers
`AsyncLocalStorage` in depth.

---

**What happens at runtime**

For `GET /api/v1/parties` with `X-Organization-Id: f000a3d8-...`:

1. `authenticate` has already set `req.userId`.
2. `resolveTenant` extracts the header and validates it is a UUID. Junk → 400.
3. It queries `Membership` for an active row joining this user to this organization.
4. No row → 403, and no business data is ever read.
5. Row found → `req.organizationId` and `req.roleId` are set.
6. `requestContext.run({ organizationId }, next)` — the rest of the request proceeds inside the
   tenant context.

**What calls this file:** `backend/src/routes/orgs.js` and `backend/src/routes/masters.js`.
**What this file calls:** `lib/request-context.js`, `db/client.js`, and Zod.

---

**File:** `backend/src/middleware/authorize.js`

**Status:** Created

**Purpose:** Checks whether the user's role has a specific permission, such as `org.manage`.

**Why does this file exist?** Reading is not the same as writing. A Viewer can see the chart of
accounts but must not create accounts. This is where that rule is enforced.

**How does it connect to other files?** Used by `routes/orgs.js` and `routes/masters.js`. It reads
`req.roleId`, which `resolve-tenant.js` set. It calls `db/client.js`.

```js
export function authorize(permissionCode) {
  return async (req, res, next) => {
    const rolePermission = await prisma.rolePermission.findFirst({
      where: { roleId: req.roleId, permission: { code: permissionCode } },
    });

    if (!rolePermission) {
      const err = new Error('Missing required permission');
      err.status = 403;
      err.code = 'forbidden';
      return next(err);
    }

    next();
  };
}
```

#### Reading this code from zero

**Generic syntax — a factory capturing a simple value**

```js
function requireSetting(setting) {
  return async (req, res, next) => {
    if (!allowed(setting)) return next(error);
    next();
  };
}

router.get('/path', requireSetting('some.value'), handler);
```

Same factory pattern as `resolveTenantFrom`, but capturing a plain string instead of a function.

**In this project:**

```js
export function authorize(permissionCode) {
  return async (req, res, next) => {
```

Each route names the permission it needs, and gets a middleware with that requirement baked in:

```js
router.post('/accounts', authorize('org.manage'), ...)
router.get('/accounts', authorize('report.view'), ...)
```

Note what is being called at route-definition time versus request time. `authorize('org.manage')`
runs **once**, when the file first loads, and produces a middleware function. That produced function
runs **on every request**. Writing `authorize` without the parentheses would hand Express the
factory itself, and every request would break.

---

**Generic syntax — querying across a relationship**

```js
await prisma.joinTable.findFirst({
  where: { directColumn: value, relatedModel: { itsColumn: otherValue } },
});
```

A nested object inside `where` means "follow the relationship, and match this on the related row".
Prisma turns it into a SQL `JOIN`.

**In this project:**

```js
    const rolePermission = await prisma.rolePermission.findFirst({
      where: { roleId: req.roleId, permission: { code: permissionCode } },
    });
```

To understand this, you need the three tables from `backend/prisma/schema.prisma`:

- `Role` — Owner, Accountant, Clerk, Viewer.
- `Permission` — `invoice.create`, `org.manage`, `report.view`, and five more.
- `RolePermission` — the *join table*: each row links one role to one permission.

**Why a join table?** A role has many permissions and a permission belongs to many roles — a
many-to-many relationship. Relational databases cannot express that in one column, so a third table
holds the pairs. Owner having all eight permissions means eight rows in `RolePermission`.

The query reads: *find a row in `RolePermission` where the role is this user's role, and the linked
permission's code is the one required.*

- `roleId: req.roleId` — a direct column on `RolePermission`. `req.roleId` was set by
  `resolveTenant`, which means **this middleware only works after it**. Chain order is not
  cosmetic.
- `permission: { code: permissionCode }` — follows the relation to `Permission` and matches its
  `code`.

**Data out:** the joining row, or `null`. We never use the row's contents — only whether it exists.

---

**Generic syntax — existence as a boolean test**

```js
if (!found) return next(forbiddenError);
next();
```

**In this project:**

```js
    if (!rolePermission) {
      const err = new Error('Missing required permission');
      err.status = 403;
      err.code = 'forbidden';
      return next(err);
    }

    next();
```

No row → the role lacks the permission → 403. A row exists → `next()` and the route handler runs.

Note the error message says *"Missing required permission"* without naming which one. That is
deliberate: telling a caller exactly which permission they lack maps out your authorisation system
for them.

---

**The design decision worth understanding: why a database query on every request?**

The alternative is tempting. When signing the access token in `tokens.js`, we could have written:

```js
// NOT what we do
jwt.sign({ sub: userId, permissions: ['invoice.post', 'report.view'] }, secret)
```

Then `authorize` would read the token's list — no database query, faster.

The problem is that a JWT cannot be changed after it is issued, and ours live 15 minutes. So if you
fire an employee and revoke their role, **they keep full posting rights for up to 15 minutes**. In
an accounting system that is a real, concrete risk.

The plan lists this as mistake #8 (line 1147):

> **Permissions embedded in the JWT** — Revoking a role does nothing until the token expires. A dismissed employee keeps posting rights for 15 minutes.

Our version costs one small indexed query per request and takes effect instantly. Test PERM-5 in
`backend/src/routes/permissions.test.js` proves it: it changes a role in the database and shows the
**same, already-issued token** immediately gains the new permission.

**A note on `RolePermission` and tenancy:** it is deliberately absent from `TENANT_SCOPED_MODELS` in
`db/tenant-extension.js`, because roles and permissions are global reference data — "Owner" means
the same thing in every organization. The tenant-specific part is *which role a user holds in which
organization*, and that lives in `Membership`, which `resolveTenant` already checked.

---

**What happens at runtime**

For `POST /api/v1/accounts` as a Viewer:

1. `authenticate` sets `req.userId`.
2. `resolveTenant` confirms membership and sets `req.roleId` to the Viewer role.
3. `authorize('org.manage')` queries for a Viewer + `org.manage` pairing.
4. Viewer only has `report.view`, so no row exists → 403.
5. The route handler never runs; no account is created.

Change the same user to Owner and the identical request succeeds — with no new login.

**What calls this file:** `backend/src/routes/orgs.js` and `backend/src/routes/masters.js`.
**What this file calls:** `db/client.js`.

---

**File:** `backend/src/middleware/audit-log.js`

**Status:** Created

**Purpose:** After a response has been sent, if the route recorded something worth auditing, write
it to the audit log.

**Why does this file exist?** Accounting systems need to prove who changed what. But writing the
log must not slow down the response, and must not happen if the operation failed.

**How does it connect to other files?** Registered globally in `backend/src/app.js`. It reads
`req.auditEntry`, which route handlers in `routes/orgs.js` and `routes/masters.js` set. It calls
`lib/audit/audit-log.js`.

```js
export function auditLog(req, res, next) {
  res.on('finish', () => {
    if (!req.auditEntry) return;
    if (res.statusCode < 200 || res.statusCode >= 300) return;

    writeAuditLog({
      ...req.auditEntry,
      userId: req.userId,
      requestId: req.id,
      ipAddress: req.ip,
    }).catch((err) => {
      console.error(`[${req.id}] audit log write failed`, err);
    });
  });
  next();
}
```

#### Reading this code from zero

**Generic syntax — registering an event listener**

```js
emitter.on('eventName', () => {
  // runs later, when the event happens
});
doSomethingElse();   // runs immediately
```

`.on(name, callback)` says "when this event happens, run this function". Registration is instant;
the callback runs later, possibly much later. Execution does **not** pause at `.on(...)`.

**In this project:**

```js
export function auditLog(req, res, next) {
  res.on('finish', () => {
    // ... runs after the response has been sent
  });
  next();
}
```

`res` is not just a bag of data — it is an *event emitter*, an object that announces things that
happen to it. `'finish'` fires once the response has been completely written to the network.

The order at runtime is:

1. `auditLog` registers the listener — instant.
2. `next()` — the rest of the request proceeds normally.
3. The route handler does its work and calls `res.json(...)`.
4. The response reaches the browser.
5. **Now** `'finish'` fires and the callback runs.

**Why this ordering is the entire point.** The audit write happens after the user already has their
answer, so the ~5ms database insert adds nothing to their wait.

**Why this middleware must be registered early** — in `backend/src/app.js` it sits near the top:

```js
app.use(auditLog);
```

The listener must be attached *before* the route handler calls `res.json()`. Registering after the
routes would mean the response finishes before anyone is listening.

---

**Generic syntax — guard clauses inside a callback**

```js
callback = () => {
  if (!shouldRun) return;
  doWork();
};
```

A bare `return` exits the function early with no value.

**In this project:**

```js
    if (!req.auditEntry) return;
    if (res.statusCode < 200 || res.statusCode >= 300) return;
```

**First guard — was anything worth auditing?** `req.auditEntry` is a property routes set when they
change something. Read-only routes never set it, so the listener does nothing. This is why
`GET /parties` produces no audit row.

**Second guard — did it actually succeed?** HTTP status codes are grouped: 2xx success, 4xx client
error, 5xx server error. This condition means "anything outside 200–299". A 403 or 500 changed
nothing, so recording it would make the audit trail claim something happened that did not.

---

**Generic syntax — merging objects with spread**

```js
const merged = { ...baseObject, extra: 'value' };
```

`...` copies every property out of `baseObject` into the new object, then adds more. Later
properties win if a name repeats.

**In this project:**

```js
    writeAuditLog({
      ...req.auditEntry,
      userId: req.userId,
      requestId: req.id,
      ipAddress: req.ip,
    })
```

The route supplies the *business* facts — what happened, to which entity, and the before/after
state. The middleware adds the *request* facts, which every audited action needs and no route
should have to remember:

- `req.userId` — who did it, set by `authenticate`.
- `req.id` — the unique request ID from the first middleware in `app.js`. It also went out as the
  `X-Request-Id` header and appears in any error response, so a single ID connects the user's error
  message, the server log, and the audit row.
- `req.ip` — the client's IP address, which Express derives from the connection.

Routes therefore write only what they alone know:

```js
    req.auditEntry = {
      action: 'account.create',
      entityType: 'Account',
      entityId: account.id,
      before: null,
      after: serializeAccount(account),
    };
```

`before: null` because a creation has no prior state. An update would carry both, giving the audit
screen a before/after diff.

---

**Generic syntax — handling a promise rejection without await**

```js
doAsyncThing().catch((err) => {
  console.error(err);
});
```

`.catch()` attaches a failure handler to a promise. Used without `await`, it means "start this, and
if it fails, handle it — but do not wait around".

**In this project:**

```js
    writeAuditLog({ ... }).catch((err) => {
      console.error(`[${req.id}] audit log write failed`, err);
    });
```

Two things to notice.

**There is no `await`.** The listener is not an `async` function, and the response has already been
sent — there is nothing left to wait for.

**The `.catch` is mandatory, not optional.** An unhandled promise rejection in Node can crash the
process. More importantly, this expresses a deliberate decision: *an audit failure must never turn
a successful business operation into a failure*. The invoice was created; the response said 201; a
logging problem afterwards cannot retroactively undo that.

**Reading `` `[${req.id}] ...` ``:** a *template literal*. Backticks allow embedded expressions via
`${...}`. This produces something like `[dd2edabb-df25-427d] audit log write failed`, so a console
error can be traced back to one specific request.

**The cost of this safety — and a real bug it hid.** Section 7.3 covers how this exact `.catch`
silently swallowed every `org.create` audit failure. The handling is correct; what was missing was
any way to notice the swallowed path failing. We found it by querying the audit table directly.

---

**What happens at runtime**

Creating an account:

1. `auditLog` registers its listener and steps aside.
2. `authenticate`, `resolveTenant`, `authorize('org.manage')` all pass.
3. The handler inserts the account, sets `req.auditEntry`, and responds 201.
4. The browser receives the response.
5. `'finish'` fires. Both guards pass (`auditEntry` exists, status is 201).
6. `writeAuditLog` inserts the audit row — with `organizationId` supplied automatically by the
   tenant extension, since we are still inside the request context.

**What calls this file:** registered globally in `backend/src/app.js`.
**What this file calls:** `backend/src/lib/audit/audit-log.js`.

---

### 3.3 Multi-tenancy machinery

---

**File:** `backend/src/lib/request-context.js`

**Status:** Created

**Purpose:** A container that holds data for the duration of one request, readable from anywhere in
that request's code without passing it as a parameter.

**Why does this file exist?** The database layer needs to know the current organization ID. Without
this, every function would need an extra `organizationId` argument passed down through every call —
and any function that forgot to pass it would create a security hole.

**How does it connect to other files?** Written to by `middleware/resolve-tenant.js`. Read by
`db/tenant-extension.js`.

```js
import { AsyncLocalStorage } from 'node:async_hooks';

export const requestContext = new AsyncLocalStorage();
```

Three lines, and it is the reason the rest of the tenancy system is safe.

#### Reading this code from zero

**Generic syntax — creating an instance of a class**

```js
import { SomeClass } from 'library';
export const instance = new SomeClass();
```

A *class* is a blueprint. `new` builds one actual object from that blueprint. Exporting the
instance — rather than the class — means everyone who imports this file shares **the same object**.

**In this project:**

```js
import { AsyncLocalStorage } from 'node:async_hooks';

export const requestContext = new AsyncLocalStorage();
```

**Why sharing one instance matters.** `resolveTenant` writes into it and the tenant extension reads
from it. If each file created its own `new AsyncLocalStorage()`, they would be separate containers,
the reader would always find nothing, and — silently — no tenant filtering would ever be applied.

Node caches modules: no matter how many files import this one, the file body runs exactly once, so
`new AsyncLocalStorage()` executes once. This is the *module singleton* pattern.

`node:async_hooks` is built into Node — nothing was installed.

---

**The concept — what problem does this actually solve?**

The database layer needs the current organization ID. The obvious approach is to pass it down:

```js
// The alternative we rejected
async function listParties(organizationId, search) {
  return findParties(organizationId, search);
}
async function findParties(organizationId, search) {
  return prisma.party.findMany({ where: { organizationId, name: search } });
}
```

Every function grows a parameter. Every new function must remember it. And — the fatal part — **any
function that forgets creates a silent data leak**. There is no error, no crash. One tenant simply
starts seeing another tenant's data.

That is precisely the bug the plan calls "company-ending" (mistake #1, line 1140). Relying on
developers to never forget is not a defence.

`AsyncLocalStorage` removes the parameter entirely. Think of it as a room with a label. `run(value,
callback)` puts a value in the room and executes the callback inside it. Any code the callback
triggers — however deeply nested, and even after `await` pauses and resumes — can ask "what is in
the room?" and get the answer.

Crucially, two requests handled simultaneously each get **their own room**. Request A never sees
request B's organization ID. That is what makes it safe under concurrency, and what distinguishes
it from a plain global variable, which would be shared and would leak between users.

---

**The two halves, and how they connect**

**Writing** — `backend/src/middleware/resolve-tenant.js`:

```js
requestContext.run({ organizationId }, next);
```

**Reading** — `backend/src/db/tenant-extension.js`:

```js
const organizationId = requestContext.getStore()?.organizationId;
```

`getStore()` returns whatever was passed to `run()`, or `undefined` if there is no active context.

**The `?.` matters.** During login there is no organization yet — no `resolveTenant` has run — so
`getStore()` returns `undefined`. Without `?.`, reading `.organizationId` off `undefined` would
crash. With it, the expression evaluates to `undefined`, and the extension correctly leaves that
query unfiltered.

---

**What happens at runtime**

```
Request A (Annapurna)          Request B (Sherpa)
      |                              |
resolveTenant                  resolveTenant
      |                              |
run({organizationId: 'f000...'})  run({organizationId: '2dfe...'})
      |                              |
   [context A]                   [context B]
      |                              |
prisma.party.findMany()        prisma.party.findMany()
      |                              |
getStore() -> 'f000...'        getStore() -> '2dfe...'
      |                              |
WHERE organizationId='f000'    WHERE organizationId='2dfe'
```

Both run at the same time, in the same process, calling the same function — and each gets the
correct filter, with neither route handler mentioning organizations at all.

**What calls this file:** `middleware/resolve-tenant.js` (writes) and `db/tenant-extension.js`
(reads).
**What this file calls:** Node's built-in `async_hooks`.

---

**File:** `backend/src/db/tenant-extension.js`

**Status:** Created

**Purpose:** Intercepts every database query and adds `organizationId` to it automatically.

**Why does this file exist?** This is the most important file created in this session. The plan
(line 1140) lists "a query missing the tenant filter" as mistake #1: *"One customer sees another's
ledger. Unrecoverable trust failure; in this domain, company-ending."* This file makes that mistake
impossible to make.

**How does it connect to other files?** Applied in `backend/src/db/client.js`, which wraps the
Prisma client. It reads from `lib/request-context.js`. Every file that imports `prisma` gets this
behaviour for free.

```js
const TENANT_SCOPED_MODELS = new Set([
  'Membership', 'FiscalYear', 'Account', 'TaxCode',
  'JournalEntry', 'AuditLog', 'IdempotencyKey', 'Party',
]);

const SINGLE_RECORD_READS = ['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'update', 'delete'];
const MULTI_RECORD_READS = ['findMany', 'count', 'updateMany', 'deleteMany'];

export function withTenantScope(client) {
  return client.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const organizationId = requestContext.getStore()?.organizationId;
          if (!organizationId || !TENANT_SCOPED_MODELS.has(model)) {
            return query(args);
          }

          if (SINGLE_RECORD_READS.includes(operation) || MULTI_RECORD_READS.includes(operation)) {
            args.where = { ...args.where, organizationId };
          }

          if (operation === 'create') {
            args.data = { ...args.data, organizationId };
          }

          return query(args);
        },
      },
    },
  });
}
```

#### Reading this code from zero

This is the most important file created in this session, so it is worth going slowly.

**Generic syntax — a Set**

```js
const allowed = new Set(['a', 'b', 'c']);
allowed.has('a');   // true
```

A `Set` is a collection of unique values with a fast `.has()` check. An array would also work via
`.includes()`, but `Set` states the intent — membership testing — and stays fast as it grows.

**In this project:**

```js
const TENANT_SCOPED_MODELS = new Set([
  'Membership', 'FiscalYear', 'Account', 'TaxCode',
  'JournalEntry', 'AuditLog', 'IdempotencyKey', 'Party',
]);
```

This is the list of models that belong to one organization. Every name here corresponds to a model
in `backend/prisma/schema.prisma` that has an `organizationId` column.

**What is deliberately absent, and why:**

- `User` — a person can belong to several organizations, so a user is not owned by one.
- `RefreshToken` — belongs to a user, not an organization.
- `Role`, `Permission`, `RolePermission` — global reference data; "Owner" means the same
  everywhere.
- `Organization` — it *is* the tenant; filtering it by itself is meaningless.
- `JournalLine`, `AccountingPeriod` — these belong to an organization conceptually but **have no
  `organizationId` column**. They are reached through a parent. This is the extension's real
  limitation, covered below.

---

**Generic syntax — arrays used as categories**

```js
const groupA = ['one', 'two'];
if (groupA.includes(value)) { ... }
```

**In this project:**

```js
const SINGLE_RECORD_READS = ['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'update', 'delete'];
const MULTI_RECORD_READS = ['findMany', 'count', 'updateMany', 'deleteMany'];
```

These name every Prisma operation that uses a `where` clause. They are split into two lists for
readability; the code treats them identically.

`create` is absent from both because it has no `where` — it has `data`, and is handled separately.

---

**Generic syntax — a wrapper function**

```js
export function enhance(thing) {
  return thing.extendedSomehow(...);
}
```

Take something, return an upgraded version. The original is unchanged; callers use what comes back.

**In this project:**

```js
export function withTenantScope(client) {
  return client.$extends({ ... });
}
```

Applied once, in `backend/src/db/client.js`:

```js
export const prisma = withTenantScope(new PrismaClient({ adapter }));
```

Every file importing `prisma` therefore gets the protected client automatically. There is no
opt-in step to forget.

---

**Generic syntax — Prisma's query interception**

```js
client.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        // inspect, modify, then run
        return query(args);
      },
    },
  },
});
```

`$extends` wraps the client with extra behaviour. `$allModels` means "every model"; `$allOperations`
means "every operation". Together: intercept everything.

The four values handed to the interceptor:

| Name | What it is | Example |
|---|---|---|
| `model` | Which model | `'Party'` |
| `operation` | What is being done | `'findMany'` |
| `args` | The arguments passed | `{ where: { code: 'CUS-001' } }` |
| `query` | A function that actually runs it | — |

**The key idea: `query` is a function, not a result.** Nothing touches the database until you call
`query(args)`. So the interceptor gets to modify `args` first — and whatever it passes is what
actually executes.

---

**The guard clause — deciding when to do nothing**

```js
          const organizationId = requestContext.getStore()?.organizationId;
          if (!organizationId || !TENANT_SCOPED_MODELS.has(model)) {
            return query(args);
          }
```

Two situations where the query runs completely untouched:

**No organization in context.** This is not an edge case — it is normal for several real paths:

- `prisma.user.findUnique` during login (nobody has chosen an organization yet).
- The `Membership` lookup inside `resolveTenant` itself. Filtering *that* by organization would be
  circular: it is the query deciding which organization you may use.
- The seed script and tests, which run with no request at all.

**The model is not tenant-scoped.** `Role`, `User`, `RefreshToken` and friends pass straight
through.

---

**Modifying the arguments**

```js
          if (SINGLE_RECORD_READS.includes(operation) || MULTI_RECORD_READS.includes(operation)) {
            args.where = { ...args.where, organizationId };
          }

          if (operation === 'create') {
            args.data = { ...args.data, organizationId };
          }

          return query(args);
```

**For reads, updates and deletes** — add the filter to `where`:

```js
{ code: 'CUS-001' }   becomes   { code: 'CUS-001', organizationId: 'f000a3d8-...' }
```

`{ ...args.where, organizationId }` spreads the existing conditions into a new object and adds ours.
Because `organizationId` is written **last**, it wins over any value already there — so even a route
that tried to pass a different organization would be overruled. Test ISO-3 checks exactly this.

`args.where` may be `undefined` (as in `findMany()` with no arguments). Spreading `undefined` is
legal and contributes nothing, so the result is simply `{ organizationId }`.

**For creates** — stamp the organization onto the new row instead:

```js
{ code: 'C001', name: 'Acme' }   becomes   { code: 'C001', name: 'Acme', organizationId: 'f000...' }
```

This is why `backend/src/routes/masters.js` can write `prisma.party.create({ data })` with no
organization anywhere, and the row still lands in the right tenant.

---

**Seeing it work end to end**

The handler in `backend/src/routes/masters.js` writes:

```js
    const accounts = await prisma.account.findMany({
      where: type ? { type } : {},
      orderBy: { code: 'asc' },
    });
```

No organization is mentioned. The SQL that reaches PostgreSQL is approximately:

```sql
SELECT * FROM "Account"
WHERE "organizationId" = 'f000a3d8-3cad-45be-8662-d055dc2e4dba'
ORDER BY code ASC
```

**Why this beats "just remember to filter".** Manual filtering means security depends on every
developer getting it right every time, forever, including at 2am on Day 5. Here, forgetting is not
possible — the filter is added by infrastructure, below the level where mistakes are made.

---

**The 404-not-403 property, for free**

The plan (line 1109) requires that fetching another tenant's record by ID returns **404, not 403**,
because a 403 confirms the record exists — an enumeration oracle.

Watch how that falls out with no special code. A route writes:

```js
prisma.party.findUnique({ where: { id: someUuid } })
```

The extension rewrites it to `{ id: someUuid, organizationId: 'yours' }`. For another tenant's
record, no row matches, so Prisma returns `null`. The route sees "not found" and returns 404.

There is no branch anywhere saying "if cross-tenant, pretend it does not exist". The behaviour is a
consequence of the design.

**A syntax note:** `findUnique` normally requires `where` to contain only unique fields, and
`organizationId` is not unique. Prisma permits extra non-unique filters alongside the unique one —
the row is still located by `id`, with the extra condition ANDed on.

---

**The limitation you must carry into Day 3**

Only models in `TENANT_SCOPED_MODELS` are protected, and membership requires an `organizationId`
column. `JournalLine` and `AccountingPeriod` have none.

This is why `/periods` in `backend/src/routes/masters.js` filters by hand:

```js
      where: {
        fiscalYear: { organizationId: req.organizationId },
        ...(fiscalYearId ? { fiscalYearId } : {}),
      },
```

It reaches through the parent `FiscalYear`, which does have the column.

**Day 3's posting engine must do the same for `JournalLine`**, going through its parent
`JournalEntry`. The extension cannot help there, and assuming it does would be a security hole.

Being able to state this limitation precisely is worth more in an interview than claiming the
extension covers everything.

---

**What happens at runtime**

For `GET /api/v1/parties`:

1. `resolveTenant` established the context.
2. The handler calls `prisma.party.findMany({ where: {} })`.
3. The extension intercepts: model `Party`, operation `findMany`.
4. `getStore()` returns `{ organizationId: 'f000...' }`.
5. `Party` is in `TENANT_SCOPED_MODELS`; `findMany` is in `MULTI_RECORD_READS`.
6. `args.where` becomes `{ organizationId: 'f000...' }`.
7. `query(args)` runs the modified query.
8. Only that organization's customers come back.

**What calls this file:** `backend/src/db/client.js`, once.
**What this file calls:** `backend/src/lib/request-context.js`.

**How we know it works:** section 6's mutation test. Disabling the context lookup made tests ISO-1
and ISO-3 fail immediately — proving those tests genuinely depend on this file.

---

**File:** `backend/src/db/client.js`

**Status:** Modified

**Purpose:** Creates the single Prisma client that the whole application shares.

**Why the change?** So that every part of the app automatically gets tenant filtering. The change
was two lines: import the extension and wrap the client in it.

**How does it connect to other files?** Imported by every file that touches the database. It calls
`db/tenant-extension.js`.

```js
import 'dotenv/config';
import { PrismaClient } from '../generated/prisma/index.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { withTenantScope } from './tenant-extension.js';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });

export const prisma = withTenantScope(new PrismaClient({ adapter }));
```

#### Reading this code from zero

**Generic syntax — a side-effect import**

```js
import 'some-package';
```

No braces, no name. This runs the package's code for its side effects rather than importing a
value.

**In this project:**

```js
import 'dotenv/config';
```

This reads `backend/.env` and copies each line into `process.env`. Without it,
`process.env.DATABASE_URL` and `process.env.JWT_SECRET` would be `undefined`.

It appears **first** on purpose: the very next lines read those variables, and imports run in
order.

---

**Generic syntax — importing from generated code**

```js
import { Thing } from '../generated/path/index.js';
```

A relative path (`../`) means one of your own files rather than a package.

**In this project:**

```js
import { PrismaClient } from '../generated/prisma/index.js';
```

`backend/src/generated/prisma/` is **not hand-written**. It is produced by `npx prisma generate`,
which reads `schema.prisma` and writes a client that knows your exact models. That is why
`prisma.party` exists with the right fields and autocompletes.

**This matters practically.** Adding a model to the schema is not enough — you must regenerate, or
the client will not have it. That caused a real failure this session (section 7): `prisma.refreshToken`
was `undefined` because the client predated the model, producing
`Cannot read properties of undefined (reading 'create')`.

---

**Generic syntax — the adapter pattern**

```js
const adapter = new SomeAdapter({ config });
const client = new Client({ adapter });
```

An *adapter* translates between two interfaces. The client speaks a generic language; the adapter
turns it into what one specific database driver expects.

**In this project:**

```js
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
```

`PrismaPg` connects Prisma to PostgreSQL through the `pg` driver. `DATABASE_URL` looks like:

```
postgresql://ledgerline:ledgerline@localhost:5432/ledgerline?schema=public
```

Reading it left to right: protocol, username, password, host, port, database name, schema.

**When this fails,** you get `ECONNREFUSED` — nothing is listening at that address. That happened
this session when the Docker container had stopped; the fix was `docker compose up -d`, not a code
change. The error surfaced as `Invalid prisma.user.findUnique() invocation`, which is Prisma
reporting *where* it failed, not *why*.

---

**Generic syntax — wrapping at the point of creation**

```js
export const thing = enhance(new Thing(config));
```

The inner call builds it; the outer call upgrades it; the export publishes the upgraded version.

**In this project — the two-line change that makes tenancy work:**

```js
export const prisma = withTenantScope(new PrismaClient({ adapter }));
```

Before this session the line was simply `new PrismaClient({ adapter })`.

**Why wrapping here is the whole trick.** Every file in the backend gets its database access from
this one export:

```js
import { prisma } from '../db/client.js';
```

Because the wrapping happens at the single point of creation, there is no way to obtain an
unprotected client. A developer cannot accidentally bypass tenant filtering, because there is no
unfiltered `prisma` to reach for.

`export const` also creates a *singleton*: Node runs a module's body once and caches it, so the
whole application shares one client and therefore one connection pool. Creating a new
`PrismaClient` per request would exhaust the database's connection limit.

---

**Why nothing else had to change**

Files written before the extension existed — `register.js`, `login.js`, `refresh-tokens.js` —
continue to work untouched, because `User` and `RefreshToken` are not in `TENANT_SCOPED_MODELS`.
The extension checks, finds them absent, and passes the query through unchanged.

That is the mark of a good seam: it was inserted beneath existing code without any of that code
knowing.

**What calls this file:** every backend file that touches the database — the auth services, all
three route files, the middleware, the seed script, and the tests.
**What this file calls:** `db/tenant-extension.js`, the generated Prisma client, and `@prisma/adapter-pg`.

---

### 3.4 Routes

---

**File:** `backend/src/routes/auth.js`

**Status:** Created

**Purpose:** The four HTTP endpoints for authentication: register, login, refresh, logout.

**Why does this file exist?** It translates between HTTP (headers, cookies, status codes) and the
business logic in `lib/auth/`. It validates incoming data and sets the refresh cookie.

**How does it connect to other files?** Mounted in `backend/src/app.js` at `/api/v1/auth`. It calls
`lib/auth/register.js`, `lib/auth/login.js`, `lib/auth/refresh-tokens.js`, `lib/auth/tokens.js`,
and `db/client.js`.

The cookie settings and the cookie reader:

```js
function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return undefined;
  const match = header.split('; ').find((entry) => entry.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : undefined;
}

const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  path: '/api/v1/auth',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};
```

The refresh route:

```js
router.post('/refresh', async (req, res, next) => {
  try {
    const rawToken = getCookie(req, 'refreshToken');
    if (!rawToken) {
      const err = new Error('Refresh token missing');
      err.status = 401;
      err.code = 'refresh_invalid';
      throw err;
    }

    const result = await rotateRefreshToken(rawToken);
    if (result.error) {
      res.clearCookie('refreshToken', { path: '/api/v1/auth' });
      const err = new Error('Refresh token invalid, reused, or expired');
      err.status = 401;
      err.code = 'refresh_invalid';
      throw err;
    }

    // The client keeps its access token in memory only, so after a page reload
    // it needs the user back too — otherwise it holds a valid session it cannot
    // render. One round trip instead of a second /auth/me call.
    const user = await prisma.user.findUnique({ where: { id: result.userId } });

    res.cookie('refreshToken', result.raw, REFRESH_COOKIE_OPTIONS);
    res.json({
      user: { id: user.id, email: user.email },
      accessToken: signAccessToken(result.userId),
    });
  } catch (err) {
    next(err);
  }
});
```

#### Reading this code from zero

**Generic syntax — creating a router**

```js
import { Router } from 'express';
const router = Router();
router.post('/some-path', handler);
export default router;
```

A *router* is a mini-application holding related routes. It is mounted onto the main app elsewhere,
under a prefix.

**In this project:**

```js
const router = Router();

router.post('/register', ...);
router.post('/login', ...);
router.post('/refresh', ...);
router.post('/logout', ...);

export default router;
```

The paths are `/register`, not `/api/v1/auth/register`. The router does not know where it will
live. `backend/src/app.js` decides:

```js
app.use('/api/v1/auth', authRouter);
```

Express strips the matched prefix before handing over, so the router sees `/register`. Moving the
whole auth module to a different URL is a one-line change.

`export default` means "this is the file's main export" — the importer picks the name
(`authRouter`).

**Why `.post` and not `.get`?** HTTP methods carry meaning. `GET` retrieves and should change
nothing; `POST` creates or performs an action. All four auth endpoints change server state — even
logout, which revokes tokens — so all four are POST. Using GET for login would also put the
password in the URL, where it lands in browser history and server logs.

---

**Generic syntax — parsing a formatted string**

```js
const parts = str.split(separator);
const found = parts.find((p) => p.startsWith(prefix));
```

- `.split(sep)` cuts a string into an array.
- `.find(fn)` returns the first element for which the function returns true, or `undefined`.

**In this project:**

```js
function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return undefined;
  const match = header.split('; ').find((entry) => entry.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : undefined;
}
```

The browser sends every cookie in one header:

```
Cookie: theme=dark; refreshToken=f0hxyF04MOlKH3Dvjh; locale=en
```

Step by step:

1. `if (!header) return undefined` — a request with no cookies at all.
2. `.split('; ')` → `['theme=dark', 'refreshToken=f0hx...', 'locale=en']`.
3. `.find((entry) => entry.startsWith('refreshToken='))` → the matching chunk. Matching on
   `name=` including the equals sign prevents a cookie called `refreshTokenBackup` from matching.
4. `.slice(name.length + 1)` — drop `refreshToken` plus the `=`, leaving just the value.
5. `decodeURIComponent(...)` — reverse any URL-encoding the browser applied (`%3D` back to `=`).

**Why write this at all?** Express can *write* cookies (`res.cookie`) but not read them. The usual
answer is to install `cookie-parser`. Six lines was cheaper than a dependency for one cookie.

---

**Generic syntax — a configuration object reused across calls**

```js
const OPTIONS = { ... };
res.cookie('name', value, OPTIONS);
```

**In this project:**

```js
const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  path: '/api/v1/auth',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};
```

Three routes set this cookie — register, login, refresh. Defining the options once guarantees they
cannot drift apart. If `httpOnly` were accidentally dropped from just one of them, that route would
quietly become the weak link.

Each option blocks a specific attack, covered in section 4.6. The one to understand now is
`httpOnly: true` — it makes the cookie invisible to JavaScript. Even a successful script injection
cannot read the refresh token.

`secure: process.env.NODE_ENV === 'production'` evaluates to a boolean. In production the cookie is
HTTPS-only; locally it is not, because a `Secure` cookie over plain HTTP would simply be discarded
and nothing would work.

---

**Generic syntax — an async route handler with error forwarding**

```js
router.post('/path', async (req, res, next) => {
  try {
    // work
    res.json(result);
  } catch (err) {
    next(err);
  }
});
```

**In this project:**

```js
router.post('/refresh', async (req, res, next) => {
  try {
    const rawToken = getCookie(req, 'refreshToken');
    if (!rawToken) {
      const err = new Error('Refresh token missing');
      err.status = 401;
      err.code = 'refresh_invalid';
      throw err;
    }
```

**Why the `try`/`catch` is not optional.** In Express 4, an error thrown inside an `async` handler
becomes an unhandled promise rejection — the request hangs and the browser waits forever. Wrapping
in `try`/`catch` and calling `next(err)` routes it to the error handler properly. (Express 5, which
this project uses, improves this, but the explicit pattern is clearer and works in both.)

Notice the mix inside the `try`: `throw err` for our own errors, while `catch` also captures
anything thrown by Zod or Prisma. Everything converges on `next(err)` and one error handler.

---

**Generic syntax — checking a result object instead of catching**

```js
const result = await doThing();
if (result.error) { /* handle */ }
```

**In this project:**

```js
    const result = await rotateRefreshToken(rawToken);
    if (result.error) {
      res.clearCookie('refreshToken', { path: '/api/v1/auth' });
      const err = new Error('Refresh token invalid, reused, or expired');
      err.status = 401;
      err.code = 'refresh_invalid';
      throw err;
    }
```

`rotateRefreshToken` returns `{ error: 'invalid' }` or `{ error: 'reused' }` rather than throwing,
because these are *expected* outcomes, not exceptions — tokens expire all the time.

**Both cases produce one identical 401.** Internally the difference is enormous — "reused" means a
theft was detected and an entire family was revoked. But telling the client which one occurred
would tell an attacker whether their stolen token had already been used.

**Why `clearCookie` matters.** The browser is holding a dead token. Without clearing it, it would
keep sending it on every future refresh, failing every time — a stuck loop with no path back to a
login screen.

`{ path: '/api/v1/auth' }` must match the path the cookie was **set** with. A browser identifies a
cookie by name *plus domain plus path*; clearing with a different path targets a different cookie
and leaves the real one in place.

---

**Generic syntax — shaping a response**

```js
res.json({ safe: obj.safe, alsoSafe: obj.alsoSafe });
```

**In this project:**

```js
    const user = await prisma.user.findUnique({ where: { id: result.userId } });

    res.cookie('refreshToken', result.raw, REFRESH_COOKIE_OPTIONS);
    res.json({
      user: { id: user.id, email: user.email },
      accessToken: signAccessToken(result.userId),
    });
```

Three things happen in order.

**The extra lookup.** `rotateRefreshToken` returns only a `userId`, but the frontend needs the email
to render. Section 7.8 explains why this endpoint returns the user at all — it is the one contract
change made this session.

**Setting the cookie before sending the body.** Headers must be written before the body; once
`res.json()` runs, headers are already flushed and a later `res.cookie()` would throw "Cannot set
headers after they are sent".

**Never spreading the user object.** We write `{ id: user.id, email: user.email }` field by field,
not `{ ...user }`, because the row includes `passwordHash`. Spreading would leak every user's
password hash on every refresh. Explicit field selection is the habit that prevents it, and there
is a test asserting `passwordHash` never appears in a response.

---

**What happens at runtime — a page reload**

1. The browser has lost its access token (memory only) but still holds the refresh cookie.
2. `AuthContext.jsx` POSTs to `/api/v1/auth/refresh` on boot.
3. The browser attaches the cookie automatically — because the URL matches its `path`.
4. `getCookie` extracts the raw token from the header.
5. `rotateRefreshToken` validates it, marks it used, and issues a successor.
6. The user row is fetched for the email.
7. A new cookie is set; a new access token and the user go back as JSON.
8. The frontend stores both and shows the dashboard instead of the login page.

**What calls this file:** `backend/src/app.js`, via `app.use('/api/v1/auth', authRouter)`.
**What this file calls:** `lib/auth/register.js`, `lib/auth/login.js`, `lib/auth/refresh-tokens.js`,
`lib/auth/tokens.js`, `db/client.js`, and Zod.

---

**File:** `backend/src/routes/orgs.js`

**Status:** Created

**Purpose:** Endpoints for organizations: list the ones you belong to, create a new one, and manage
members.

**Why does this file exist?** Organizations are the top of the tenancy tree. Creating one is
special because it is the only write that happens *without* an existing organization context.

**How does it connect to other files?** Mounted in `backend/src/app.js` at `/api/v1/orgs`. It calls
`middleware/authenticate.js`, `middleware/resolve-tenant.js`, `middleware/authorize.js`, and
`db/client.js`.

The organization creation, which must create the membership at the same time:

```js
    // Org + first membership must land together: an org with no owner is
    // unreachable, since every other route requires an active membership.
    const org = await prisma.$transaction(async (tx) => {
      const created = await tx.organization.create({ data: { name } });
      await tx.membership.create({
        data: { userId: req.userId, organizationId: created.id, roleId: ownerRole.id },
      });
      return created;
    });

    req.auditEntry = {
      // No tenant context on this route yet — the extension has nothing to inject.
      organizationId: org.id,
      action: 'org.create',
      entityType: 'Organization',
      entityId: org.id,
      before: null,
      after: serializeOrg(org),
    };
```

The member list route, showing the full middleware chain:

```js
router.get('/:id/members', authenticate, resolveTenantFromPath, authorize('org.manage'), async (req, res, next) => {
  try {
    const memberships = await prisma.membership.findMany({
      include: { user: true, role: true },
    });
    res.json(memberships.map(serializeMember));
  } catch (err) {
    next(err);
  }
});
```

Notice `findMany` has no `where` clause at all. The tenant extension adds it.

#### Reading this code from zero

**Generic syntax — a database transaction**

```js
const result = await prisma.$transaction(async (tx) => {
  const a = await tx.modelA.create({ ... });
  await tx.modelB.create({ ... });
  return a;
});
```

A *transaction* groups operations so that either all of them succeed or none do. If anything throws,
the database undoes everything already done inside — called a *rollback*.

**In this project:**

```js
    const org = await prisma.$transaction(async (tx) => {
      const created = await tx.organization.create({ data: { name } });
      await tx.membership.create({
        data: { userId: req.userId, organizationId: created.id, roleId: ownerRole.id },
      });
      return created;
    });
```

**What `tx` is, and why you must use it.** Inside the callback, `tx` is a special client bound to
this transaction. Using the outer `prisma` instead would run *outside* the transaction — and would
therefore **not** be rolled back if the transaction failed. That is a subtle bug: the code looks
right and works in testing, then leaves orphaned rows in production.

**Why this specific pair must be atomic.** Creating an organization takes two inserts: the
organization, and the membership making its creator the Owner. If the first succeeded and the second
failed, you would have an organization **nobody can ever access** — every other route requires an
active membership, so no user could reach it, administer it, or delete it. It would sit in the
database permanently stranded.

The comment in the file states exactly this:

```js
    // Org + first membership must land together: an org with no owner is
    // unreachable, since every other route requires an active membership.
```

**Data in:** the organization name, `req.userId`, and the Owner role's ID.
**Data out:** the created organization (the callback's return value becomes the transaction's).

---

**Generic syntax — looking up required reference data first**

```js
const ref = await prisma.model.findUnique({ where: { name: 'Known' } });
if (!ref) throw configurationError;
```

**In this project:**

```js
    const ownerRole = await prisma.role.findUnique({ where: { name: 'Owner' } });
    if (!ownerRole) {
      const err = new Error('Owner role missing — run the seed script');
      err.status = 500;
      err.code = 'role_missing';
      throw err;
    }
```

Roles come from `backend/prisma/seed.js`, not from user input. If the Owner role is missing, the
database was never seeded.

**Why `500` and not `400`.** This is not the user's mistake — they sent a perfectly valid request.
The server is misconfigured. And the message says what to actually do about it: run the seed. An
error a developer can act on is worth far more than a generic "Internal Server Error".

---

**Generic syntax — a serializer function**

```js
function serialize(row) {
  return { id: row.id, name: row.name };
}
res.json(rows.map(serialize));
```

A small function converting a database row into the shape the API promises. `.map()` applies it to
every element of an array.

**In this project:**

```js
function serializeOrg(org) {
  return { id: org.id, name: org.name, isActive: org.isActive, createdAt: org.createdAt };
}

function serializeMember(membership) {
  return {
    id: membership.id,
    user: { id: membership.user.id, email: membership.user.email },
    role: { id: membership.role.id, name: membership.role.name },
    isActive: membership.isActive,
  };
}
```

**Why not just send the row?** Three reasons, in order of importance:

1. **Security** — `membership.user` is a full `User` row including `passwordHash`. Sending it raw
   would leak every member's hash. `serializeMember` picks `id` and `email` only.
2. **Contract stability** — `docs/openapi.yaml` promises a specific shape. Adding a column to the
   database should not silently change the API.
3. **Consistency** — every route returning an organization sends the same fields.

---

**Generic syntax — loading related rows**

```js
await prisma.model.findMany({ include: { relatedA: true, relatedB: true } });
```

`include` tells Prisma to fetch related rows too, via SQL joins.

**In this project:**

```js
router.get('/', authenticate, async (req, res, next) => {
  try {
    const memberships = await prisma.membership.findMany({
      where: { userId: req.userId, isActive: true },
      include: { organization: true },
    });
    res.json(memberships.map((m) => serializeOrg(m.organization)));
```

Without `include`, each membership row would carry only an `organizationId` string, and we would
need a second query per organization — the classic *N+1 query* problem. `include` gets everything
in one round trip, so `m.organization` is a full object.

**Note this route uses only `authenticate`** — no `resolveTenant`, no `authorize`. That is
deliberate and worth understanding: this is the endpoint that tells the client *which organizations
exist for them*. Requiring an organization header here would be circular — you cannot name an
organization before discovering which ones you belong to.

Security still holds: `where: { userId: req.userId }` restricts results to this user's own
memberships.

---

**Generic syntax — mounting middleware per route**

```js
router.get('/path', middlewareA, middlewareB, handler);
```

Express accepts any number of functions. They run left to right; each must call `next()` for the
next to run.

**In this project — the full three-stage chain:**

```js
router.get('/:id/members', authenticate, resolveTenantFromPath, authorize('org.manage'), async (req, res, next) => {
  try {
    const memberships = await prisma.membership.findMany({
      include: { user: true, role: true },
    });
    res.json(memberships.map(serializeMember));
```

Three questions answered in a fixed order, each depending on the one before:

1. `authenticate` — *who are you?* Sets `req.userId`.
2. `resolveTenantFromPath` — *which organization, and are you in it?* Needs `req.userId`. Sets
   `req.roleId` and enters the tenant context.
3. `authorize('org.manage')` — *may you do this?* Needs `req.roleId`.

Reordering them breaks everything: `authorize` before `resolveTenant` would read `req.roleId` as
`undefined` and reject every request.

**`:id` is a route parameter.** A colon marks a placeholder. A request to `/orgs/abc-123/members`
makes `req.params.id` equal to `'abc-123'`. That is what
`resolveTenantFrom((req) => req.params.id)` reads.

**The line worth staring at:**

```js
    const memberships = await prisma.membership.findMany({
      include: { user: true, role: true },
    });
```

There is **no `where` clause at all**. Read literally, this says "fetch every membership row in the
entire database" — across all organizations. It is only safe because the tenant extension adds
`where: { organizationId }` before the query runs.

This is the payoff of the whole design: the handler expresses intent ("the members here") and the
infrastructure supplies the boundary. It is also why the mutation test in section 6 matters — if the
extension silently broke, this line would leak every organization's membership list, so we verified
the tests actually catch that.

---

**Generic syntax — recording an audit entry**

```js
req.auditEntry = { action, entityType, entityId, before, after };
res.status(201).json(payload);
```

**In this project:**

```js
    req.auditEntry = {
      // No tenant context on this route yet — the extension has nothing to inject.
      organizationId: org.id,
      action: 'org.create',
      entityType: 'Organization',
      entityId: org.id,
      before: null,
      after: serializeOrg(org),
    };

    res.status(201).json(serializeOrg(org));
```

The route records *what* happened; `middleware/audit-log.js` writes it after the response is sent.

**The `organizationId` line is the fix from section 7.3.** Every other audited route omits it,
because the tenant extension injects it. But `POST /orgs` runs *before* any organization exists, so
there is no context to inject from — and `AuditLog.organizationId` is `NOT NULL`. Without this
explicit value the insert failed, and the deliberate `.catch` in the middleware swallowed the
failure silently.

`before: null` because nothing existed beforehand. An update would carry both states, giving the
Day 6 audit screen a before/after diff.

`res.status(201)` — 201 means "Created", more precise than a plain 200.

---

**What happens at runtime — creating an organization**

1. `authenticate` sets `req.userId`. No tenant middleware runs.
2. Zod validates `{ name }`.
3. The Owner role is looked up.
4. A transaction inserts the organization, then the membership.
5. If either insert fails, both are rolled back — no orphaned organization.
6. `req.auditEntry` is set, including the explicit `organizationId`.
7. `201` with the serialized organization.
8. The response finishes; the audit row is written.

**What calls this file:** `backend/src/app.js`, via `app.use('/api/v1/orgs', orgsRouter)`.
**What this file calls:** all three middleware files, `db/client.js`, and Zod.

---

**File:** `backend/src/routes/masters.js`

**Status:** Created

**Purpose:** Endpoints for the reference data an accounting system needs: accounts, customers,
fiscal years, and periods.

**Why does this file exist?** These four things share the same access pattern — all tenant-scoped,
all requiring authentication — so they share one router and one set of middleware.

**How does it connect to other files?** Mounted in `backend/src/app.js` at `/api/v1`. It calls the
three middleware files and `db/client.js`.

Applying middleware to every route at once:

```js
// Every route below is tenant-scoped: the extension injects organizationId
// from request context, so no handler here ever writes a where-clause for it.
router.use(authenticate, resolveTenant);
```

The periods route, which shows the extension's limitation:

```js
router.get('/periods', authorize('report.view'), async (req, res, next) => {
  try {
    const fiscalYearId = z.string().uuid().optional().parse(req.query.fiscalYearId);

    // AccountingPeriod has no organizationId column, so the tenant extension
    // cannot scope it — the filter goes through its parent fiscal year instead.
    const periods = await prisma.accountingPeriod.findMany({
      where: {
        fiscalYear: { organizationId: req.organizationId },
        ...(fiscalYearId ? { fiscalYearId } : {}),
      },
      orderBy: { startDate: 'asc' },
    });
```

#### Reading this code from zero

**Generic syntax — applying middleware to every route in a file**

```js
router.use(middlewareA, middlewareB);
router.get('/one', handler);
router.get('/two', handler);
```

`router.use(...)` with no path applies to **every** route defined below it, so shared middleware is
written once instead of repeated on each line.

**In this project:**

```js
// Every route below is tenant-scoped: the extension injects organizationId
// from request context, so no handler here ever writes a where-clause for it.
router.use(authenticate, resolveTenant);
```

All six routes here — accounts, parties, fiscal years, periods — require a logged-in user working
inside a specific organization. Writing `authenticate, resolveTenant` on every route would be six
chances to forget one.

`authorize(...)` is **not** here, because it differs per route: reading needs `report.view`, writing
needs `org.manage`.

**Position matters.** `router.use` only affects routes defined *after* it. A route above that line
would silently have no authentication at all.

---

**Generic syntax — mapping between internal and external vocabularies**

```js
function serialize(row) {
  return { type: row.type.toLowerCase() };
}
```

**In this project:**

```js
// The contract speaks lowercase (customer/supplier/both); Prisma's enum is
// uppercase. Translate at the boundary, both directions.
function serializeParty(party) {
  return {
    id: party.id,
    type: party.type.toLowerCase(),
    code: party.code,
    ...
  };
}
```

and going the other way, when creating:

```js
    const { type, ...rest } = createPartySchema.parse(req.body);
    const party = await prisma.party.create({
      data: { ...rest, type: type.toUpperCase() },
    });
```

**Why two vocabularies exist.** `docs/openapi.yaml` specifies `[customer, supplier, both]`, while
`schema.prisma` defines `enum PartyType { CUSTOMER SUPPLIER BOTH }` — uppercase is the convention
for database enums. Both are correct in their own world, so the route translates at the boundary.

**Reading `const { type, ...rest }`** — *rest destructuring*. Pull out `type` into its own variable,
and collect **everything else** into an object called `rest`. So `{ type: 'customer', code: 'C001',
name: 'Acme' }` becomes `type = 'customer'` and `rest = { code: 'C001', name: 'Acme' }`. Then
`{ ...rest, type: type.toUpperCase() }` rebuilds the object with only `type` transformed.

**The lesson:** translation belongs at the edge. Doing it deeper would mean the rest of the codebase
never knows which convention it is holding.

---

**Generic syntax — conditional filters**

```js
where: someCondition ? { column: value } : {}
```

The ternary supplies a filter object or an empty one. An empty `where` means "no restriction".

**In this project:**

```js
router.get('/accounts', authorize('report.view'), async (req, res, next) => {
  try {
    const type = z.enum(ACCOUNT_TYPES).optional().parse(req.query.type);
    const accounts = await prisma.account.findMany({
      where: type ? { type } : {},
      orderBy: { code: 'asc' },
    });
```

`req.query` holds URL query-string values: `/accounts?type=ASSET` gives `req.query.type === 'ASSET'`.

`z.enum(ACCOUNT_TYPES)` restricts it to the five valid values; `.optional()` allows it to be absent.

**Why validate a filter at all?** The plan (line 1115) requires report filters to be checked against
an allowlist rather than passed through. Prisma parameterises values so this is not SQL injection —
but validating means a typo returns a clear 400 instead of an empty list the user misreads as "no
data".

Note the empty `{}` is not really empty by the time it executes — the tenant extension turns it into
`{ organizationId: '...' }`.

---

**Generic syntax — pagination**

```js
await prisma.model.findMany({
  skip: (page - 1) * PAGE_SIZE,
  take: PAGE_SIZE,
});
```

`skip` jumps over rows; `take` limits how many come back. Together they produce pages.

**In this project:**

```js
const PAGE_SIZE = 20;

    const { search, page } = listPartiesSchema.parse(req.query);
    const parties = await prisma.party.findMany({
      where: search ? { name: { contains: search, mode: 'insensitive' } } : {},
      orderBy: { code: 'asc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    });
```

Page 1 → `skip: 0`; page 2 → `skip: 20`. The `- 1` exists because humans count pages from 1 while
`skip` counts from 0.

**Why pagination is not optional.** An organization with 50,000 customers would otherwise send all
of them in one response — slow for the database, the network, and the browser.

**`orderBy` is required for pagination to be correct**, not just tidy. Without an explicit order,
SQL may return rows in any order, so page 2 could repeat or skip rows from page 1.

`{ contains: search, mode: 'insensitive' }` is a case-insensitive substring match — searching
`"trek"` finds `"Himalayan Trek Supplies"`.

`z.coerce.number()` in the schema converts the query string `"2"` into the number `2`, since
everything in a URL arrives as text.

---

**Generic syntax — filtering through a relation**

```js
where: { parentRelation: { parentColumn: value } }
```

**In this project — the exception that proves the rule:**

```js
router.get('/periods', authorize('report.view'), async (req, res, next) => {
  try {
    const fiscalYearId = z.string().uuid().optional().parse(req.query.fiscalYearId);

    // AccountingPeriod has no organizationId column, so the tenant extension
    // cannot scope it — the filter goes through its parent fiscal year instead.
    const periods = await prisma.accountingPeriod.findMany({
      where: {
        fiscalYear: { organizationId: req.organizationId },
        ...(fiscalYearId ? { fiscalYearId } : {}),
      },
      orderBy: { startDate: 'asc' },
    });
```

Every other route here relies on automatic filtering. This one cannot.

Looking at `schema.prisma`, `AccountingPeriod` has `fiscalYearId` but **no `organizationId`**. It
belongs to a `FiscalYear`, which belongs to an `Organization`. Since the extension only recognises a
direct `organizationId` column, it leaves this model alone entirely — so the filter must be written
by hand, reaching through the parent.

`req.organizationId` is available because `resolveTenant` set it — that is precisely why it sets a
plain request property in addition to entering the context.

**Reading `...(condition ? { key: value } : {})`** — *conditional spread*. If the condition holds,
spread in `{ fiscalYearId }`; otherwise spread in an empty object, which adds nothing. It is how you
add a property only sometimes, inside an object literal.

**Why this matters for Day 3.** `JournalLine` has the same shape — it belongs to a `JournalEntry`,
with no `organizationId` of its own. The posting engine must filter through the parent exactly like
this. Assuming the extension covers it would be a security hole.

---

**Generic syntax — formatting dates for output**

```js
value.toISOString().slice(0, 10);
```

**In this project:**

```js
function asDate(value) {
  return value.toISOString().slice(0, 10);
}
```

`toISOString()` produces `2025-07-17T00:00:00.000Z`. `.slice(0, 10)` keeps the first ten characters:
`2025-07-17`.

**Why bother?** `docs/openapi.yaml` types these as `format: date`, not `date-time`. A fiscal year
starts on a day, not at a moment — sending a timestamp implies a precision that does not exist, and
invites timezone bugs where a date shifts by one day depending on the reader's location.

---

**What happens at runtime — `GET /api/v1/parties?search=trek&page=1`**

1. `router.use` runs `authenticate`, then `resolveTenant`.
2. `authorize('report.view')` confirms the role may read.
3. Zod parses the query, coercing `page` to a number.
4. `prisma.party.findMany` is called with a search filter and pagination, but no organization.
5. The tenant extension adds `organizationId`.
6. PostgreSQL returns at most 20 matching rows for that organization.
7. `serializeParty` lowercases the type and drops internal fields.
8. JSON goes back. No audit entry — reads are not audited.

**What calls this file:** `backend/src/app.js`, via `app.use('/api/v1', mastersRouter)`.
**What this file calls:** all three middleware files, `db/client.js`, and Zod.

---

**File:** `backend/src/app.js`

**Status:** Created

**Purpose:** Builds the Express application — all the middleware, all the routes, the error handler
— but does not start a server.

**Why does this file exist?** Tests need to send requests to the app without occupying a real
network port. Splitting "build the app" from "start the server" makes both possible.

**How does it connect to other files?** Imported by `backend/src/index.js` (which starts it) and by
all three test files (which send requests to it). It imports the three routers and the audit
middleware.

```js
const app = express();
app.use((req, res, next) => {
  req.id = randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
});
app.use(auditLog);
app.use(helmet());
app.use(cors());
app.use(express.json());

app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.use('/api/v1/auth', authRouter);
app.use('/api/v1/orgs', orgsRouter);
app.use('/api/v1', mastersRouter);
```

#### Reading this code from zero

**Generic syntax — creating the application**

```js
import express from 'express';
const app = express();
```

`express()` builds an application object. Think of `app` as a receptionist: requests arrive and it
decides what happens to each. On its own it knows nothing — you teach it by registering handlers in
order.

**In this project:**

```js
const app = express();
```

Note this file **never calls `app.listen()`**. It builds the app and exports it; starting the server
is `index.js`'s job. Section 3.4's entry for `index.js` explains why.

---

**Generic syntax — registering global middleware**

```js
app.use(someMiddleware);
```

`.use()` adds to an ordered list. Every request walks the list top to bottom. **Order is behaviour,
not style** — this is the single most common source of confusing Express bugs, and it caused one in
this session (section 7.1).

**In this project, in exact order:**

```js
app.use((req, res, next) => {
  req.id = randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
});
app.use(auditLog);
app.use(helmet());
app.use(cors());
app.use(express.json());
```

**1. Request ID — first, because everything after may need it.** Every request gets a unique ID,
attached to `req` and returned as a response header. That same ID appears in error responses, in
console logs, and in the `requestId` column of the audit table. One ID connects the user's error
message to the server log to the audit trail.

**2. `auditLog` — early, because it registers a listener.** It must attach its `'finish'` listener
*before* any route handler sends a response. Registering it after the routes would mean the response
completes with nobody listening.

**3. `helmet()` — sets protective HTTP headers** such as `X-Content-Type-Options: nosniff`, which
stops browsers from guessing a file's type and executing something as a script.

**4. `cors()` — controls which other websites may call this API.** In development the Vite proxy
makes everything same-origin, so this rarely fires. The plan schedules a strict origin allowlist for
Day 6.

**5. `express.json()` — reads the request body and parses it as JSON.** Before this line runs,
`req.body` does not exist.

**The bug this order fixes.** Originally `app.use('/api/v1/auth', authRouter)` sat *above*
`express.json()`. Registration order is execution order, so the route handler ran before the body
was parsed, and `req.body` was `undefined`. `registerSchema.parse(undefined)` then threw, producing
a 500 with a JSON parse error. Those requests also skipped helmet, cors, and the request-ID
middleware entirely. Moving one line below the stack fixed all of it.

---

**Generic syntax — a route handler**

```js
app.get('/path', (req, res) => {
  res.status(200).json({ key: 'value' });
});
```

`app.get(path, handler)` responds to `GET` requests at that exact path. `res.status(n)` sets the
code; `.json(obj)` serialises an object and sends it, setting `Content-Type` automatically.

**In this project:**

```js
app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok' });
});
```

A *health check* — a trivial endpoint monitoring tools poll to ask "is this process alive?".
Deployment platforms use it to decide whether to route traffic to an instance.

It sits deliberately **outside** `/api/v1` and requires no authentication, because a monitor should
not need credentials.

**It also has a diagnostic use.** During the stale-server incident (section 7.2), `/healthz`
answered fine while `/auth/register` returned 404 — which was itself the clue. The old process
predated the auth router but had always had `/healthz`.

---

**Generic syntax — mounting a router under a prefix**

```js
app.use('/prefix', someRouter);
```

When the first argument is a string, the middleware only runs for paths starting with it. Express
then **strips the prefix** before handing the request to the router.

**In this project — your original question, answered fully:**

```js
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/orgs', orgsRouter);
app.use('/api/v1', mastersRouter);
```

**What `/api/v1` means.** `/api` marks these as machine endpoints rather than web pages. `/v1` is a
version number — a future `/v2` could change shapes without breaking existing clients.

**What `authRouter` is.** The default export of `backend/src/routes/auth.js`: a `Router()` holding
four POST routes. The name is our choice, since it is a default import.

**Why the order of these three lines matters.** Express checks them top to bottom and uses the
first match. `mastersRouter` is mounted at `/api/v1`, which would also match `/api/v1/auth/login`.
Because the auth mount comes first, it wins. If `mastersRouter` were listed first, it would receive
auth requests, find no matching route, and fall through to a 404 — with authentication apparently
broken for no visible reason.

**What happens when a request reaches `/api/v1/auth/login`:**

1. All five global middlewares run.
2. `/healthz` does not match.
3. `'/api/v1/auth'` matches. Express strips it and hands `/login` to `authRouter`.
4. `backend/src/routes/auth.js` matches `router.post('/login', ...)`.
5. That handler validates the body and calls `loginUser` from `lib/auth/login.js`.

**Which file handles it next:** `backend/src/routes/auth.js`.

---

**Generic syntax — the error handler**

```js
app.use((err, req, res, _next) => {
  res.status(err.status || 500).json({ error: { ... } });
});
```

Express identifies an error handler by its **four** parameters. Three parameters means ordinary
middleware; four means "only call this when something failed".

**In this project:**

```js
// Express identifies error handlers by arity — the 4th param must exist even
// though it is unused here.
app.use((err, req, res, _next) => {
  console.error(`[${req.id}]`, err);

  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: 'validation_error',
        message: 'Request validation failed',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        requestId: req.id,
      },
    });
  }

  res.status(err.status || 500).json({
  error: {
      code: err.code || 'INTERNAL_ERROR',
      message: err.message || 'Something went wrong',
      requestId: req.id,
    },
  });
});
```

**Why it is registered last.** Express only reaches it after everything above has passed the error
along. Registering it first would mean it never runs.

**The `_next` parameter.** It is unused, but deleting it would leave three parameters — and Express
would silently treat this as normal middleware, so errors would stop being handled. The underscore
prefix is a convention meaning "intentionally unused", and `backend/eslint.config.js` is configured
to accept that prefix without warning.

**`err instanceof ZodError`** — `instanceof` tests whether an object was built from a particular
class. Every Zod validation failure anywhere in the app lands here and becomes a clean 400 with a
per-field `details` array the frontend can display next to the right input. This was the fix in
section 7.4; before it, validation failures surfaced as 500s with a raw Zod dump.

**`err.status || 500`** — `||` returns the left side if it is truthy, otherwise the right. Our own
thrown errors set `.status`; an unexpected crash has none, so it defaults to 500. Same idea for
`code` and `message`.

**Every error carries `requestId`.** The user can quote the ID from their error message, and it can
be found directly in the server logs.

---

**Why this file exists separately from `index.js`**

Tests need to send requests to the app **without** occupying a real network port. Splitting
construction from startup makes that possible:

```js
// backend/src/routes/isolation.test.js
import app from '../app.js';
const res = await request(app).get('/api/v1/parties').set(alice.headers);
```

`supertest` takes the app object and drives the entire middleware chain in-process. Every test file
can do this simultaneously with no port conflicts, and `npm run dev` can be running at the same
time.

**What calls this file:** `backend/src/index.js` and all three backend test files.
**What this file calls:** the three routers, `middleware/audit-log.js`, and the express, helmet,
cors, and zod packages.

---

**File:** `backend/src/index.js`

**Status:** Modified (reduced from 66 lines to 6)

**Purpose:** Starts the web server.

**Why the change?** Everything except the `listen` call moved to `app.js`.

```js
import app from './app.js';

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
```

#### Reading this code from zero

**Generic syntax — starting a server**

```js
app.listen(port, callback);
```

`listen` binds the application to a network port and begins accepting connections. The callback runs
once the socket is open.

**In this project:**

```js
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
```

**What a port is.** One machine can run many servers, so each claims a numbered channel.
`localhost:3000` means "this machine, channel 3000". Only one process may hold a port at a time — a
second attempt fails with `EADDRINUSE`.

**Why `process.env.PORT || 3000`.** Hosting platforms assign a port and pass it in as an environment
variable; the code must use whatever it is given. Locally that variable is unset, so `||` falls back
to 3000. This one line lets the same code run on a laptop and on Render without modification.

**Why the log line matters more than it looks.** `Server running on port 3000` is the proof that
startup *completed*. During the incident in section 7.2, every `npm run dev` crashed on an import
error before reaching `listen`, so this line never printed — while an older process kept holding the
port and answering requests. The absence of this message was the signal that something was wrong.

---

**Why this file is only six lines**

Before this session it was 66 lines containing all the middleware, routes, and the error handler.
Everything except `listen` moved to `app.js`.

The split follows one rule: **`app.js` describes what the application *is*; `index.js` decides to
*run* it.** Tests want the first without the second.

```
index.js  -> imports app.js -> starts listening on a port     (production, npm run dev)
tests     -> import app.js  -> drive it directly, no port     (npm test)
```

Without the split, importing the app in a test would start a real server as a side effect. Three
test files would fight over port 3000, and none could run while `npm run dev` was active.

**What calls this file:** `npm run dev` and `npm start`, via `node --watch src/index.js`.
**What this file calls:** `backend/src/app.js`.

---

### 3.5 Database schema

**File:** `backend/prisma/schema.prisma`

**Status:** Modified

**Purpose:** Describes every table in the database. Prisma reads this to generate both the
migration SQL and the JavaScript client.

**Why the change?** Three additions were needed: a table to store refresh tokens, a table to store
customers, and an extra column for idempotency.

**How does it connect to other files?** `npx prisma migrate dev` reads it to create SQL in
`backend/prisma/migrations/`; `npx prisma generate` reads it to create `backend/src/generated/prisma/`,
which `db/client.js` imports.

```prisma
model RefreshToken {
  id        String    @id @default(uuid())
  userId    String
  familyId  String
  tokenHash String    @unique
  createdAt DateTime  @default(now())
  expiresAt DateTime
  usedAt    DateTime?
  revokedAt DateTime?

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([familyId])
}
```

```prisma
enum PartyType {
  CUSTOMER
  SUPPLIER
  BOTH
}

model Party {
  id             String    @id @default(uuid())
  organizationId String
  type           PartyType
  code           String
  name           String
  panVatNo       String?
  email          String?
  phone          String?
  address        String?
  creditDays     Int       @default(30)
  creditLimit    Decimal?  @db.Decimal(18, 4)
  isActive       Boolean   @default(true)

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Restrict)

  @@unique([organizationId, code])
}
```

Two details worth noticing:

`onDelete: Cascade` on `RefreshToken` is different from every other relation in this schema, which
use `onDelete: Restrict`. Financial records must never disappear, so deleting a row they depend on
is blocked. Refresh tokens are not financial records — if a user is deleted, their tokens should go
too.

`@@unique([organizationId, code])` on `Party` means customer code `CUS-001` can exist once *per
organization*. Annapurna and Sherpa can both have a `CUS-001`.

#### Reading this code from zero

Prisma's schema is not JavaScript — it is its own small language whose only job is describing
tables. Two commands read it: `npx prisma migrate dev` generates SQL, and `npx prisma generate`
generates the JavaScript client.

**Generic syntax — declaring a model**

```prisma
model ModelName {
  fieldName  FieldType  @attribute
}
```

One `model` becomes one database table. Each line is a column: name, type, then optional
attributes. Single `@` attributes apply to that column; double `@@` attributes apply to the whole
table.

**In this project:**

```prisma
model RefreshToken {
  id        String    @id @default(uuid())
  userId    String
  familyId  String
  tokenHash String    @unique
  createdAt DateTime  @default(now())
  expiresAt DateTime
  usedAt    DateTime?
  revokedAt DateTime?
  ...
}
```

Attribute by attribute:

- **`@id`** — the primary key, the column that uniquely identifies a row.
- **`@default(uuid())`** — if no value is supplied, generate a UUID. This is why application code
  never sets `id`.
- **`@unique`** — the database refuses a second row with the same value. On `tokenHash` this is
  both a correctness guarantee and a performance one: unique columns are indexed, so
  `findUnique({ where: { tokenHash } })` is a fast lookup rather than a full scan.
- **`@default(now())`** — timestamp at insert.

**The `?` is the most important character here.** `DateTime` is required; `DateTime?` is
*nullable* — it may hold no value.

```prisma
  expiresAt DateTime     // must always have a value
  usedAt    DateTime?    // null means "not used yet"
  revokedAt DateTime?    // null means "not revoked"
```

Null is doing real work: it encodes state. `usedAt IS NULL` means the token is still fresh; a
timestamp means it has been rotated. That single column is what makes reuse detection possible, and
it is why `refresh-tokens.js` can write `if (stored.usedAt)` — in JavaScript `null` is falsy and a
date object is truthy.

**Why `familyId` has no `@unique`.** Many tokens share one family — that is the entire point. It
does get `@@index([familyId])`, which speeds up "find every token in this family" without requiring
uniqueness. An index is a lookup structure; without one, revoking a family would scan the whole
table.

---

**Generic syntax — relations**

```prisma
model Child {
  parentId String
  parent   Parent @relation(fields: [parentId], references: [id], onDelete: Restrict)
}

model Parent {
  children Child[]
}
```

A relation needs three pieces: a column holding the other row's ID, a *relation field* describing
the link, and a matching array on the other side.

**In this project:**

```prisma
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
```

Read it as: *the `userId` column on this table points at the `id` column of the `User` table.*

The `user` field is **not a column** — no `user` column exists in the database. It is a convenience
that lets JavaScript write `membership.user.email` after an `include`. The real database artifact is
the `userId` column plus a foreign-key constraint.

`User` gains the other half:

```prisma
  refreshTokens RefreshToken[]
```

The `[]` means "many". Also not a column — it is what lets you fetch a user's tokens through the
relation.

**`onDelete` is the detail worth understanding.** It tells the database what to do when the parent
row is deleted:

- **`Restrict`** — refuse the delete while children exist.
- **`Cascade`** — delete the children too.

Every relation in this schema uses `Restrict` **except** `RefreshToken`, which uses `Cascade`. That
is deliberate. The plan lists "deleting instead of reversing" as mistake #11 (line 1150): financial
records must never silently vanish, so the database physically refuses. Refresh tokens are not
financial records — if a user is deleted, their login sessions should go with them.

---

**Generic syntax — enums**

```prisma
enum TypeName {
  VALUE_ONE
  VALUE_TWO
}
```

An `enum` restricts a column to a fixed set of values, enforced by the database itself.

**In this project:**

```prisma
enum PartyType {
  CUSTOMER
  SUPPLIER
  BOTH
}
```

**Why an enum instead of a plain string?** A `String` column would accept `"custmer"`, `"Customer"`,
or `"banana"`. The enum makes those impossible at the storage layer — not merely discouraged in
application code.

**Why `BOTH` exists.** The plan (line 404) keeps customers and suppliers in one table, because a
real business often buys from the same company it sells to. Two separate tables would duplicate that
company and split its history.

This uppercase convention is the reason `masters.js` translates to lowercase at the API boundary.

---

**Generic syntax — money columns**

```prisma
  amount Decimal? @db.Decimal(18, 4)
```

**In this project:**

```prisma
  creditLimit    Decimal?  @db.Decimal(18, 4)
```

`@db.Decimal(18, 4)` maps to PostgreSQL `NUMERIC(18,4)`: 18 total digits, 4 after the decimal point.

**Why never `Float` for money.** Floating-point numbers cannot represent most decimal fractions
exactly — `0.1 + 0.2` famously gives `0.30000000000000004`. Over thousands of transactions those
errors compound, and a reconciliation fails months later with no traceable cause. `NUMERIC` stores
exact decimal values.

The plan lists this as mistake #2 (line 1141): *"Silent, compounding, undetectable until a
reconciliation fails months later."* Day 3's posting engine will route all money arithmetic through
`backend/src/lib/money.js` for the same reason.

---

**Generic syntax — table-level constraints**

```prisma
  @@unique([columnA, columnB])
  @@index([columnA, columnB])
```

`@@unique` forbids duplicate *combinations*. `@@index` speeds up queries filtering on those columns.

**In this project:**

```prisma
  @@unique([organizationId, code])
```

This is a multi-tenant pattern worth internalising. `@@unique([code])` alone would mean only one
organization in the entire system could ever use `CUS-001`. Combining it with `organizationId`
scopes uniqueness *per tenant*: Annapurna and Sherpa each get their own `CUS-001`, and neither can
create a duplicate within itself.

It also gives Prisma a compound key usable in queries — which is what the seed script uses to stay
idempotent:

```js
    await prisma.party.upsert({
      where: { organizationId_code: { organizationId, code } },
      ...
    });
```

Prisma names the compound key by joining the column names with an underscore.

---

**What happens when you change this file**

```
schema.prisma
     |
     |--- npx prisma migrate dev --name description
     |         reads the schema, compares it to the database,
     |         writes SQL into prisma/migrations/, applies it
     |
     |--- npx prisma generate
               regenerates src/generated/prisma/ so JavaScript
               knows the new models
```

Two migrations were created this session:

- `20260813071010_day2_auth_and_masters` — `RefreshToken`, `Party`, `PartyType`.
- `20260813083444_add_idempotency_request_hash` — `requestHash` on `IdempotencyKey`.

**Migrations are files, not commands.** They are committed to git, so every developer and the
production database apply the identical sequence of changes.

**The failure mode to remember.** `migrate dev` normally regenerates the client automatically, but
if it does not, the schema and the client disagree — the table exists in PostgreSQL while
`prisma.refreshToken` is `undefined` in JavaScript. The symptom is
`Cannot read properties of undefined (reading 'create')`. The fix is `npx prisma generate`. This
happened in this session.

**What reads this file:** the Prisma CLI.
**What it produces:** SQL in `backend/prisma/migrations/` and the client in
`backend/src/generated/prisma/`, which `db/client.js` imports.

---

### 3.6 Support files

**File:** `backend/src/lib/audit/audit-log.js`

**Status:** Created

**Purpose:** Writes one row to the audit log table.

**Why does this file exist?** So the middleware has something to call, and so future code (like
Day 3's posting engine) can write audit entries directly.

```js
// organizationId is normally injected by the tenant extension from request
// context. Routes that run before tenancy exists (org creation) must pass it
// explicitly, since the column is NOT NULL.
export async function writeAuditLog({ organizationId, userId, action, entityType, entityId, before, after, ipAddress, requestId }) {
  await prisma.auditLog.create({
    data: { organizationId, userId, action, entityType, entityId, before, after, ipAddress, requestId },
  });
}
```

#### Reading this code from zero

**Generic syntax — destructuring in the parameter list**

```js
function doThing({ nameA, nameB }) {
  use(nameA, nameB);
}

doThing({ nameA: 1, nameB: 2 });
```

Instead of accepting positional arguments, the function takes **one object** and unpacks named
properties out of it in the parameter list.

**In this project:**

```js
export async function writeAuditLog({ organizationId, userId, action, entityType, entityId, before, after, ipAddress, requestId }) {
```

Nine values. Compare the positional alternative:

```js
// what we avoided
writeAuditLog('org-123', 'user-456', 'account.create', 'Account', 'acc-789', null, {...}, '::1', 'req-abc');
```

Nobody can read that. Was the fifth argument the entity ID or the entity type? Swap two and the
system keeps running while writing wrong audit rows — a silent corruption of the record you would
later rely on in a dispute.

With an object, every value is labelled at the call site, order stops mattering, and adding a tenth
field breaks nothing.

---

**Generic syntax — shorthand property names**

```js
const a = 1;
const obj = { a };        // same as { a: a }
```

**In this project:**

```js
  await prisma.auditLog.create({
    data: { organizationId, userId, action, entityType, entityId, before, after, ipAddress, requestId },
  });
```

Every property uses shorthand, because the parameter names were chosen to match the column names in
`schema.prisma` exactly. The function is a thin, honest pass-through with no renaming to trace.

---

**The `organizationId` parameter — and the bug that put it there**

```js
// organizationId is normally injected by the tenant extension from request
// context. Routes that run before tenancy exists (org creation) must pass it
// explicitly, since the column is NOT NULL.
```

`AuditLog` is in `TENANT_SCOPED_MODELS`, so for nearly every route the extension supplies
`organizationId` automatically and callers omit it.

`POST /orgs` is the exception: it runs before any organization exists, so no context exists to
inject from — while `AuditLog.organizationId` is `NOT NULL`. The insert failed, and
`middleware/audit-log.js` swallowed the failure by design.

Accepting an explicit `organizationId` fixes it without weakening anything, because of how the
extension merges:

```js
args.data = { ...args.data, organizationId };
```

The injected value is written **last**, so when a context exists it still wins. The explicit value
is used only when there is nothing to inject. Section 7.3 has the full story.

---

**Generic syntax — JSON columns**

```prisma
  before Json?
  after  Json?
```

**In this project:** `before` and `after` accept whole JavaScript objects, which PostgreSQL stores
as JSONB. That is what lets one audit table record changes to *any* entity — an account, a party, an
invoice — without a column per entity type.

Callers pass serialized output rather than raw rows:

```js
      before: null,
      after: serializeAccount(account),
```

Storing the serialized shape means the audit screen shows the same fields the API exposed, and no
`passwordHash` can ever leak into the audit table.

---

**Why this file exists separately from the middleware**

The middleware decides *when* to log; this function knows *how*. Day 3's posting engine will call
`writeAuditLog` directly — immediately after a posting transaction commits, rather than waiting for
the response — and reusing this function means both paths write identical rows.

**What calls this file:** `backend/src/middleware/audit-log.js` today; Day 3's posting engine later.
**What this file calls:** `db/client.js`.

---

**File:** `backend/src/lib/idempotency/run-idempotent.js`

**Status:** Created

**Purpose:** Makes a write operation safe to retry. If the same request arrives twice, the second
one replays the first one's response instead of performing the operation again.

**Why does this file exist?** The plan lists non-idempotent payment endpoints as mistake #5: a
network retry or a double-click creates a second payment. Real money, real disputes.

**How does it connect to other files?** Nothing calls it yet — Day 3's payment routes will. It
calls `db/client.js`.

```js
export async function runIdempotent({ key, endpoint, requestBody }, performWrite) {
  const requestHash = hashBody(requestBody);

  return prisma.$transaction(async (tx) => {
    let created;
    try {
      created = await tx.idempotencyKey.create({
        data: { key, endpoint, requestHash, responseStatus: null, responseBody: null },
      });
    } catch (err) {
      if (err.code !== 'P2002') throw err;

      const existing = await tx.idempotencyKey.findFirst({ where: { key } });

      if (!existing || existing.requestHash !== requestHash) {
        const conflictErr = new Error('Idempotency key already used with a different request body');
        conflictErr.status = 422;
        conflictErr.code = 'idempotency_key_reuse';
        throw conflictErr;
      }
      ...
      return { replayed: true, status: existing.responseStatus, body: existing.responseBody };
    }

    const { status, body } = await performWrite(tx);

    await tx.idempotencyKey.update({
      where: { id: created.id },
      data: { responseStatus: status, responseBody: body },
    });

    return { replayed: false, status, body };
  });
}
```

#### Reading this code from zero

Nothing calls this yet — Day 3's payment routes will. It is included because the plan schedules it
for Day 2 and because the reasoning behind it is worth understanding before you need it.

**The problem it solves.** A user clicks "Record payment". The request reaches the server, the
payment is written, and then the network drops before the response arrives. The browser sees a
failure and retries. Without protection, the customer is now recorded as having paid twice.

The plan lists this as mistake #5 (line 1144): *"Network retry or a double-click creates a second
payment. Real money, real disputes."*

**The solution.** The client generates a unique `Idempotency-Key` per user action and sends it with
the request. The server records that key. If the same key arrives again, it replays the original
response instead of doing the work twice.

---

**Generic syntax — hashing a value for comparison**

```js
function hashOf(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
```

**In this project:**

```js
function hashBody(body) {
  return createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex');
}
```

`JSON.stringify` turns an object into text so it can be hashed. `??` is the *nullish coalescing*
operator: use the left side unless it is `null` or `undefined`, in which case use `{}`. It differs
from `||` in that `0` and `''` are kept rather than replaced.

**Why hash the body at all?** To catch key *misuse*. If the same key arrives with a **different**
body, the client has a bug — perhaps reusing a key across two genuinely different payments. Storing
a hash lets the server detect that and refuse, rather than replaying the wrong response.

Hashing rather than storing the body keeps the row small and avoids duplicating payment details.

---

**Generic syntax — a callback parameter**

```js
async function wrapper(config, doTheWork) {
  const result = await doTheWork();
  return result;
}
```

A function taking another function as an argument, so the wrapper controls *when* and *whether* the
inner work runs.

**In this project:**

```js
export async function runIdempotent({ key, endpoint, requestBody }, performWrite) {
```

`performWrite` is the actual business operation — creating the receipt, posting the invoice. This
file knows nothing about payments; it only knows how to run something at most once. Day 3 will use
it roughly like:

```js
await runIdempotent({ key, endpoint, requestBody }, async (tx) => {
  const receipt = await createReceipt(tx, data);
  return { status: 201, body: receipt };
});
```

---

**The key mechanism — insert first, and let the database decide**

```js
  return prisma.$transaction(async (tx) => {
    let created;
    try {
      created = await tx.idempotencyKey.create({
        data: { key, endpoint, requestHash, responseStatus: null, responseBody: null },
      });
    } catch (err) {
      if (err.code !== 'P2002') throw err;
```

**Why insert before checking.** The obvious approach — "look it up, and if absent do the work" — has
a race condition. Two identical requests arriving at the same moment would both find nothing, and
both would proceed.

Instead we attempt the insert immediately. `IdempotencyKey` has `@@unique([organizationId, key])`, so
the **database** decides the winner. Exactly one insert can succeed. This is a general technique:
when two requests race, let a unique constraint arbitrate rather than application logic.

**`P2002`** is Prisma's error code for "unique constraint violated". Checking the code specifically
matters — `if (err.code !== 'P2002') throw err` re-throws anything else, so a connection failure is
not silently treated as a duplicate.

**The null columns.** The row is created with `responseStatus: null` before the work runs, then
filled in afterwards. Null means "in progress". That is why the schema change made those columns
nullable.

---

**The three duplicate outcomes**

```js
      const existing = await tx.idempotencyKey.findFirst({ where: { key } });

      if (!existing || existing.requestHash !== requestHash) {
        const conflictErr = new Error('Idempotency key already used with a different request body');
        conflictErr.status = 422;
        conflictErr.code = 'idempotency_key_reuse';
        throw conflictErr;
      }

      if (existing.responseStatus == null) {
        const conflictErr = new Error('Request with this idempotency key is still in progress');
        conflictErr.status = 409;
        conflictErr.code = 'idempotency_in_progress';
        throw conflictErr;
      }

      return { replayed: true, status: existing.responseStatus, body: existing.responseBody };
```

**Different body → 422.** The client is misusing the key. `422 Unprocessable Entity` means "I
understood the request but will not act on it". This is the plan's IDEM-2 test case.

**Still in progress → 409.** The first request has not finished. `409 Conflict` tells the client to
wait and retry rather than assuming failure.

**Same body, completed → replay.** Return the stored status and body. The client cannot tell the
difference, which is the entire point — and no second payment exists. This is IDEM-1.

`== null` with two equals signs is deliberate here: it matches both `null` and `undefined`, which is
one of the few cases where loose equality is the right tool.

---

**Why the whole thing is inside one transaction**

```js
    const { status, body } = await performWrite(tx);

    await tx.idempotencyKey.update({
      where: { id: created.id },
      data: { responseStatus: status, responseBody: body },
    });
```

`performWrite` receives `tx` — the transaction client — so **the payment and the idempotency key are
written in the same transaction**. If either fails, both roll back.

The plan (line 544) explains why this rules out Redis:

> the key row is inserted **inside the same transaction as the financial write**. If the transaction rolls back, so does the key, and the client's retry correctly re-attempts. With Redis you have two systems that can disagree about whether a payment happened, which is exactly the failure you were trying to prevent.

Picture the Redis version failing: the key is stored in Redis, then the database write fails and
rolls back. The retry now sees the key in Redis, replays a success response — and no payment exists.
The customer believes they paid; the ledger disagrees.

Putting both in one transaction makes that state impossible. This is the plan's "genuinely good
interview answer".

---

**What will happen at runtime, once Day 3 wires it up**

Same request sent twice:

```
Request 1: INSERT key (succeeds) -> create receipt -> UPDATE key with response -> COMMIT -> 201
Request 2: INSERT key -> P2002    -> same hash, response present -> replay stored 201
```

One receipt. Two identical responses. The client never knows.

**What calls this file:** nothing yet. Day 4's tests (IDEM-1..3, plan line 1485) will verify it.
**What this file calls:** `db/client.js` and Node's `crypto`.

---

**File:** `backend/prisma/seed.js`

**Status:** Modified (rewritten)

**Purpose:** Fills an empty database with realistic starting data.

**Why the change?** The old version created one organization and no users, so there was no way to
log in and nothing to demonstrate tenant isolation with. The plan's §14 demo scenario requires two
organizations and four users.

```js
const ORGS = [
  {
    name: 'Annapurna Trading Pvt. Ltd.',
    members: [
      ['sunita@annapurnatrading.com.np', 'Owner'],
      ['rajan@annapurnatrading.com.np', 'Accountant'],
      ['bimala@annapurnatrading.com.np', 'Clerk'],
    ],
    parties: [
      ['CUS-001', 'Himalayan Trek Supplies Pvt. Ltd.', 30],
      ['CUS-002', 'Everest Cafe Pvt. Ltd.', 15],
      ['CUS-003', 'Sagarmatha Hardware Suppliers', 30],
    ],
  },
  {
    name: 'Sherpa Ventures Pvt. Ltd.',
    members: [
      // Sunita belongs to both orgs, so the demo can show the org switcher
      // flipping the whole dataset for one logged-in user.
      ['sunita@annapurnatrading.com.np', 'Owner'],
      ['auditor@external.com.np', 'Viewer'],
    ],
    parties: [
      ['CUS-101', 'Khumbu Expeditions Pvt. Ltd.', 30],
      ['CUS-102', 'Lukla Guesthouse', 15],
    ],
  },
];
```

Every write uses `upsert` (update if exists, insert if not), which makes the script *idempotent* —
running it twice produces the same result as running it once. This was verified by running it
twice.

#### Reading this code from zero

**Generic syntax — data as a nested array of objects**

```js
const THINGS = [
  { name: 'A', children: [['x', 1], ['y', 2]] },
  { name: 'B', children: [['z', 3]] },
];

for (const { name, children } of THINGS) { ... }
```

Describing data as a structure and then looping over it, rather than writing out each case, means
adding a third organization is a data edit rather than a code change.

**In this project:**

```js
const ORGS = [
  {
    name: 'Annapurna Trading Pvt. Ltd.',
    members: [
      ['sunita@annapurnatrading.com.np', 'Owner'],
      ...
    ],
    parties: [
      ['CUS-001', 'Himalayan Trek Supplies Pvt. Ltd.', 30],
      ...
    ],
  },
  { name: 'Sherpa Ventures Pvt. Ltd.', ... },
];
```

Members and parties use compact arrays rather than objects, because the positions are obvious and
consistent: `[email, role]` and `[code, name, creditDays]`. Destructured at the point of use, the
meaning is restored:

```js
    for (const [email, roleName] of members) {
```

**`for...of`** iterates over the values of an array. (`for...in`, easily confused with it, iterates
over keys and is almost never what you want for arrays.)

**Why two organizations exist at all.** The second is not filler. The plan (line 1686):

> A second organisation, **Sherpa Ventures Pvt. Ltd.**, exists with its own customers and ledger, purely so isolation is demonstrable rather than merely claimed.

And note this line, which makes the Day 2 checkpoint possible:

```js
      // Sunita belongs to both orgs, so the demo can show the org switcher
      // flipping the whole dataset for one logged-in user.
      ['sunita@annapurnatrading.com.np', 'Owner'],
```

One user, two organizations. Switching organizations in the UI changes every screen — with the same
login, the same token, and the same session.

---

**Generic syntax — upsert**

```js
await prisma.model.upsert({
  where: { uniqueKey: value },
  update: { },
  create: { field: value },
});
```

`upsert` is "update or insert": if a row matching `where` exists, apply `update`; otherwise apply
`create`.

**In this project:**

```js
async function seedUser(email, passwordHash) {
  return prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, passwordHash },
  });
}
```

**Why `update: {}` is empty.** An empty update means "if it already exists, change nothing". Combined
with `create`, this gives exactly the behaviour a seed needs: create it if missing, leave it alone if
present.

**Why this matters.** The plan (line 1533) requires the seed to be idempotent and re-runnable. A
seed built from plain `create` calls would crash on the second run with unique-constraint errors —
and since `npm test` truncates the database, you re-run the seed constantly.

**The compound-key form** appears where uniqueness is per-tenant:

```js
    await prisma.party.upsert({
      where: { organizationId_code: { organizationId, code } },
      ...
    });
```

`organizationId_code` is the name Prisma generates for `@@unique([organizationId, code])`, joining
the column names with an underscore.

**And where no unique constraint exists**, upsert is not available:

```js
async function seedOrganization(name) {
  const existing = await prisma.organization.findFirst({ where: { name } });
  if (existing) return existing;
  return prisma.organization.create({ data: { name } });
}
```

`Organization.name` is not unique — two real companies could share a name. So idempotency here is
manual: look first, create only if absent.

---

**Generic syntax — hashing once and reusing**

```js
const expensive = await compute();
for (const item of manyItems) { use(expensive); }
```

**In this project:**

```js
  // One hash reused for every demo user — Argon2id is deliberately slow, and
  // this is throwaway demo data, not a credential store.
  const passwordHash = await hashPassword(DEMO_PASSWORD);
```

Argon2 takes ~50ms per call by design. Hashing once and reusing it across five users saves a couple
of hundred milliseconds.

**Would this be acceptable in production?** No — and the comment says so. Argon2 embeds a random
salt per hash, and reusing one hash means all five users share a salt. For real accounts that
weakens the protection. For demo accounts that all share the published password `Demo@2026`, there
is nothing to protect.

Knowing *why* a shortcut is safe here and unsafe elsewhere is the point.

---

**Generic syntax — date arithmetic in a loop**

```js
const cursor = new Date(start);
for (const label of labels) {
  const end = new Date(cursor);
  end.setMonth(end.getMonth() + 1);
  end.setDate(end.getDate() - 1);
  cursor.setMonth(cursor.getMonth() + 1);
}
```

**In this project:**

```js
  const cursor = new Date(fiscalYear.startDate);
  for (const label of PERIOD_LABELS) {
    const start = new Date(cursor);
    const end = new Date(cursor);
    end.setMonth(end.getMonth() + 1);
    end.setDate(end.getDate() - 1);
    ...
    cursor.setMonth(cursor.getMonth() + 1);
  }
```

This generates twelve consecutive accounting periods from the Nepali calendar
(`Shrawan`, `Bhadra`, ... in `PERIOD_LABELS`).

**The critical detail: `new Date(cursor)` makes a copy.** Dates are mutable objects, and `.setMonth()`
modifies in place. Writing `const start = cursor` would store a *reference*, so when `cursor` advanced
at the end of the loop, every stored period would shift with it — and all twelve rows would end up
with identical dates. Copying is what keeps each period independent.

`end.setMonth(+1)` then `end.setDate(-1)` produces "the day before the same date next month" — the
standard way to get a period's last day without hard-coding month lengths or leap years.

---

**What happens at runtime**

```
npm run seed
   |
   |-- seedRolesAndPermissions()   4 roles, 8 permissions, and the pairings
   |                               (global reference data, not tenant data)
   |-- hashPassword('Demo@2026')   once
   |
   |-- for each of 2 organizations:
   |       seedOrganization()      find-or-create
   |       seedUser() x N          upsert each member
   |       seedMembership()        link user + org + role
   |       seedFiscalYearAndPeriods()   1 fiscal year, 12 periods
   |       seedAccounts()          27 accounts
   |       seedParties()           customers
   |
   `-- prisma.$disconnect()
```

Output on both the first and second run:

```
Seeded 4 roles, 8 permissions
Seeded Annapurna Trading Pvt. Ltd.: 3 members, 27 accounts, 3 customers
Seeded Sherpa Ventures Pvt. Ltd.: 2 members, 27 accounts, 2 customers
Seed complete. Demo users share the password: Demo@2026
```

Identical output, and no duplicate rows — that is idempotency demonstrated rather than asserted.

**One subtlety about the tenant extension.** The seed imports the *wrapped* `prisma` from
`db/client.js`, but runs with no HTTP request and therefore no context. `getStore()` returns
`undefined`, the extension passes every query through untouched, and the seed's explicit
`organizationId` values are used. That is exactly the intended behaviour — and the reason the
extension's guard clause checks for a missing context first.

**What calls this file:** `npm run seed`, defined in `backend/package.json`.
**What this file calls:** `db/client.js` and `lib/auth/password.js`.

---

### 3.7 Tests

**File:** `backend/src/test/helpers.js`

**Status:** Created

**Purpose:** Shared setup code for tests: wiping the database, seeding roles, and creating a user
with an organization.

**Why does this file exist?** All three test files need the same setup. Writing it once means the
tests stay readable.

```js
// TRUNCATE, not DELETE: the immutability trigger blocks row-level DELETE on
// JournalEntry/JournalLine, but TRUNCATE doesn't fire row-level triggers.
export async function resetDb() {
  await prisma.$executeRawUnsafe(`
    TRUNCATE
      "JournalLine", "JournalEntry", "Account", "TaxCode", "Party",
      "AccountingPeriod", "FiscalYear", "Membership", "RolePermission",
      "Role", "Permission", "Organization", "RefreshToken", "User",
      "AuditLog", "IdempotencyKey"
    CASCADE
  `);
}
```

#### Reading this code from zero

**Generic syntax — raw SQL through an ORM**

```js
await prisma.$executeRawUnsafe(`SQL STATEMENT`);
```

Prisma normally generates SQL for you. `$executeRawUnsafe` runs SQL you wrote yourself, for
operations Prisma has no method for.

**In this project:**

```js
export async function resetDb() {
  await prisma.$executeRawUnsafe(`
    TRUNCATE
      "JournalLine", "JournalEntry", "Account", "TaxCode", "Party",
      "AccountingPeriod", "FiscalYear", "Membership", "RolePermission",
      "Role", "Permission", "Organization", "RefreshToken", "User",
      "AuditLog", "IdempotencyKey"
    CASCADE
  `);
}
```

**The word "Unsafe" deserves attention.** It is unsafe because the string is sent to the database as
written — if user input were concatenated into it, that would be SQL injection. Here the string is a
hard-coded constant with no input of any kind, so there is nothing to inject.

The plan (line 1114) is strict about this:

> Every `$queryRaw` uses tagged-template interpolation — **never** string concatenation. Grep the repo for `$queryRawUnsafe` before submitting and make sure the count is zero.

This file uses `$executeRawUnsafe`, which is a related but distinct method (`execute` for statements
returning no rows, `query` for statements returning data). It is confined to test setup and touches
no user input.

**Why `TRUNCATE` and not `deleteMany`,** as the comment explains:

```js
// TRUNCATE, not DELETE: the immutability trigger blocks row-level DELETE on
// JournalEntry/JournalLine, but TRUNCATE doesn't fire row-level triggers.
```

Day 1 installed database triggers making posted journal entries immutable — an attempted `DELETE`
raises an error. That is correct and important: the plan lists deleting instead of reversing as
mistake #11.

But tests must reset the database. `TRUNCATE` empties a table wholesale rather than row by row, and
row-level triggers do not fire, so it succeeds where `DELETE` is refused.

**Why `CASCADE`.** Foreign keys use `ON DELETE RESTRICT`, so emptying `Organization` while
`Account` still references it would be blocked. `CASCADE` empties all listed tables together as one
operation.

**Why the table names are quoted.** PostgreSQL folds unquoted identifiers to lowercase, so
`JournalLine` would become `journalline` and not be found. Prisma creates tables with the model's
exact casing, so the names must be double-quoted to preserve it.

---

**Generic syntax — a reusable test fixture**

```js
export async function makeThing(app, name) {
  const created = await request(app).post('/things').send({ name });
  return { id: created.body.id, headers: { ... } };
}
```

A helper that performs setup and returns everything a test needs.

**In this project:**

```js
export async function makeUserWithOrg(app, email, orgName) {
  const registered = await request(app)
    .post('/api/v1/auth/register')
    .send({ email, password: 'password123' });

  const accessToken = registered.body.accessToken;

  const org = await request(app)
    .post('/api/v1/orgs')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ name: orgName });

  return {
    userId: registered.body.user.id,
    accessToken,
    orgId: org.body.id,
    authOnly: { Authorization: `Bearer ${accessToken}` },
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'X-Organization-Id': org.body.id,
    },
  };
}
```

**`request(app)` is supertest.** It drives the Express app directly, in-process, with no network
port. `.post(path)`, `.set(header)`, and `.send(body)` build the request; awaiting it returns the
response.

**Why the setup goes through the real API** rather than inserting rows with Prisma: it exercises the
same code path a browser would. If registration broke, these tests would fail too — which is
correct. Inserting fixtures directly would let tests pass against a broken API.

**Why two header sets are returned:**

- `headers` — token plus organization, for normal tenant-scoped requests.
- `authOnly` — token only, for `/orgs` (which has no organization yet) and for the ISO-4 case that
  checks a missing organization header returns 400.

Returning both means individual tests never assemble headers by hand, so a typo cannot make a test
pass for the wrong reason.

---

**Why roles are seeded separately**

```js
/** Roles and permissions are global reference data, not tenant data. */
export async function seedRoles() {
```

`resetDb` truncates `Role`, `Permission`, and `RolePermission` along with everything else, so they
must be recreated. They are not tenant data — "Owner" means the same thing in every organization —
which is why they live in their own helper and why `RolePermission` is absent from
`TENANT_SCOPED_MODELS`.

`seedRoles` returns the created roles so tests can reference IDs directly:

```js
      data: { roleId: roles.Owner.id },
```

---

**What happens at runtime**

```
npm test
  |
  |-- vitest reads vitest.config.js -> fileParallelism: false
  |
  |-- auth.test.js         beforeAll -> resetDb() -> seedRoles()
  |-- isolation.test.js     beforeAll -> resetDb() -> seedRoles() -> two users with orgs
  |-- permissions.test.js   beforeAll -> resetDb() -> seedRoles() -> owner + three members
  |-- triggers.test.js      beforeAll -> its own reset
  |-- money.test.js         no database
```

Each file starts from a known-empty database. **This is your real development database**, which is
why `npm run seed` must follow `npm test`.

**Why a real database instead of mocks.** The plan (line 1157) is explicit that these tests exist to
prove correctness against PostgreSQL itself. Faking the database would mean the triggers, the
constraints, and the `NOT NULL` on `AuditLog.organizationId` all go untested — and it was exactly a
`NOT NULL` violation that produced the bug in section 7.3.

**What calls this file:** all three route test files.
**What this file calls:** `db/client.js` and supertest.

---

**File:** `backend/src/routes/isolation.test.js`

**Status:** Created

**Purpose:** Proves that two organizations cannot see each other's data.

**Why does this file exist?** The plan's deliverable for Day 2 is "multi-tenant auth working end to
end, **with isolation tests green**". Claiming isolation is worthless; proving it is the point.

```js
  // ISO-2 — the header is a *claim*, checked against membership. Trusting it
  // alone would make cross-tenant access a one-header attack.
  it('ISO-2: presenting another org\'s id in the header is forbidden', async () => {
    const res = await request(app)
      .get('/api/v1/parties')
      .set({ Authorization: bob.headers.Authorization, 'X-Organization-Id': alice.orgId });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
  });
```

#### Reading this code from zero

**Generic syntax — the structure of a test file**

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

beforeAll(async () => { /* setup, once */ });
afterAll(() => { /* cleanup, once */ });

describe('group name', () => {
  it('does the thing', async () => {
    expect(actual).toBe(expected);
  });
});
```

- `describe` groups related tests and gives the output structure.
- `it` is one test. The string should read as a sentence: *it does the thing.*
- `expect(x).toBe(y)` is an assertion — if it does not hold, the test fails.
- `beforeAll` / `afterAll` run once per file, around all its tests.

**In this project:**

```js
beforeAll(async () => {
  await resetDb();
  await seedRoles();

  alice = await makeUserWithOrg(app, 'alice@test.com', 'Alice Trading');
  bob = await makeUserWithOrg(app, 'bob@test.com', 'Bob Ventures');

  await request(app).post('/api/v1/parties').set(alice.headers)
    .send({ type: 'customer', code: 'A-001', name: 'Alice Customer' });
  ...
});

afterAll(() => prisma.$disconnect());
```

Two users, two organizations, one customer and one account each. Every test then asks the same
question from a different angle: *can either of them reach the other's data?*

**Why `beforeAll` and not `beforeEach`.** `beforeEach` runs before every individual test. Here the
setup is read-only for most tests and involves several Argon2 hashes, so running it once per file is
both sufficient and much faster.

**Why `afterAll` disconnects.** Prisma holds open database connections. Without closing them the
test process would not exit, and the terminal would hang after the results printed.

---

**Generic syntax — asserting on collections**

```js
expect(rows.map((r) => r.field)).toEqual(['expected']);
```

`.map()` extracts one property from every element. `.toEqual` compares deeply — element by element
for arrays — whereas `.toBe` checks identity and would fail for two arrays with equal contents.

**In this project — ISO-1:**

```js
  it('ISO-1: a list endpoint returns only the active org\'s rows', async () => {
    const aliceParties = await request(app).get('/api/v1/parties').set(alice.headers);
    const bobParties = await request(app).get('/api/v1/parties').set(bob.headers);

    expect(aliceParties.body.map((p) => p.code)).toEqual(['A-001']);
    expect(bobParties.body.map((p) => p.code)).toEqual(['B-001']);
```

**Why assert on the exact array rather than "contains".** `toEqual(['A-001'])` fails if the list has
one extra element. A weaker check like "includes A-001" would still pass if Bob's customer leaked
into Alice's list — passing while the exact bug it exists to catch was present.

The same request is sent twice with only the headers differing. That is the cleanest possible
statement of what isolation means.

---

**Generic syntax — combining values from two sources**

```js
.set({ Authorization: personA.token, 'X-Organization-Id': personB.orgId })
```

**In this project — ISO-2, the attack simulation:**

```js
  // ISO-2 — the header is a *claim*, checked against membership. Trusting it
  // alone would make cross-tenant access a one-header attack.
  it('ISO-2: presenting another org\'s id in the header is forbidden', async () => {
    const res = await request(app)
      .get('/api/v1/parties')
      .set({ Authorization: bob.headers.Authorization, 'X-Organization-Id': alice.orgId });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
  });
```

Bob's genuine token, Alice's organization ID. This is exactly what an attacker would try: log in
legitimately, then edit the header.

Bob's token is completely valid, so `authenticate` passes. The rejection has to come from
`resolveTenant`, whose `Membership` query finds no row joining Bob to Alice's organization.

**Why assert on `code` as well as status.** A 403 could come from `authorize` for a different reason
entirely. Checking `code` confirms the rejection came from where we think it did.

---

**Generic syntax — verifying stored state, not just the response**

```js
const stored = await prisma.model.findFirst({ where: { field: value } });
expect(stored.otherField).toBe(expected);
```

**In this project — ISO-3:**

```js
  // ISO-3 — writes must land in the caller's org, never the claimed one.
  it('ISO-3: a create lands in the caller\'s org even if the body says otherwise', async () => {
    await request(app).post('/api/v1/parties').set(bob.headers)
      .send({ type: 'customer', code: 'B-002', name: 'Injected' });

    const stored = await prisma.party.findFirst({ where: { code: 'B-002' } });
    expect(stored.organizationId).toBe(bob.orgId);

    const aliceSees = await request(app).get('/api/v1/parties').set(alice.headers);
    expect(aliceSees.body.map((p) => p.code)).not.toContain('B-002');
  });
```

This test checks **the database directly**, not just the API response. A response could look correct
while the row was written to the wrong organization — and the next read would then leak it.

**A subtlety worth noticing.** This `findFirst` runs inside a test, where there is no HTTP request
and therefore no `AsyncLocalStorage` context. So the tenant extension does not filter it — the test
can see across all organizations, which is exactly what is needed to verify where the row actually
landed. Test code deliberately stands outside the boundary it is verifying.

`.not.toContain(...)` inverts an assertion, confirming Alice's list does not include Bob's new
customer.

---

**Generic syntax — several assertions in one test**

```js
it('rejects all the bad cases', async () => {
  expect(caseA.status).toBe(401);
  expect(caseB.status).toBe(400);
});
```

**In this project — ISO-4:**

```js
    const noToken = await request(app)
      .get('/api/v1/parties')
      .set({ 'X-Organization-Id': alice.orgId });
    expect(noToken.status).toBe(401);
    expect(noToken.body.error.code).toBe('unauthenticated');

    const noOrgHeader = await request(app).get('/api/v1/parties').set(alice.authOnly);
    expect(noOrgHeader.status).toBe(400);
    expect(noOrgHeader.body.error.code).toBe('org_header_invalid');

    const garbageToken = await request(app)
      .get('/api/v1/parties')
      .set({ Authorization: 'Bearer not-a-real-jwt', 'X-Organization-Id': alice.orgId });
    expect(garbageToken.status).toBe(401);
```

Three malformed requests, three **different** correct answers:

- No token → **401** (we do not know who you are).
- Token but no organization header → **400** (the request itself is malformed).
- Forged token → **401** (the signature does not verify).

Distinguishing 401 from 400 from 403 matters. Collapsing them into one generic error would hide
whether the correct guard is doing the rejecting.

---

**Why these tests are the deliverable**

The plan's Day 2 deliverable (line 1449) is *"multi-tenant auth working end to end, with isolation
tests green."* Claiming isolation costs nothing; this file is the evidence.

And the evidence was itself checked. Section 6 describes the mutation test: disabling the tenant
extension made ISO-1 and ISO-3 fail immediately. A test that passes whether or not the feature works
is worse than no test at all, because it manufactures false confidence.

**What calls this file:** `npm test`.
**What this file calls:** `app.js`, `db/client.js`, `test/helpers.js`, and supertest.

---

**File:** `backend/src/routes/permissions.test.js`

**Status:** Created

**Purpose:** Proves that roles actually restrict what users can do.

The most important test in the file:

```js
  // PERM-5 — the reason permissions are not baked into the JWT. A revoked role
  // must bite immediately, not whenever the 15-minute access token expires.
  it('PERM-5: revoking a role takes effect on the very next request, same token', async () => {
    const before = await request(app)
      .post('/api/v1/parties')
      .set(members.Accountant)
      .send({ type: 'customer', code: 'X-1', name: 'Before Revoke' });
    expect(before.status).toBe(403); // Accountant has no org.manage

    // Promote to Owner, reusing the *same* access token issued minutes ago.
    const user = await prisma.user.findUnique({ where: { email: 'accountant@test.com' } });
    await prisma.membership.updateMany({
      where: { userId: user.id, organizationId: owner.orgId },
      data: { roleId: roles.Owner.id },
    });

    const after = await request(app)
      .post('/api/v1/parties')
      .set(members.Accountant)
      .send({ type: 'customer', code: 'X-2', name: 'After Promote' });
    expect(after.status).toBe(201);
  });
```

#### Reading this code from zero

**Generic syntax — a setup helper that mutates shared state**

```js
const results = {};
async function addOne(key) {
  results[key] = await create(key);
}
```

**In this project:**

```js
let roles, owner;
const members = {};

async function addMember(email, roleName) {
  await request(app)
    .post('/api/v1/auth/register')
    .send({ email, password: 'password123' });

  await request(app)
    .post(`/api/v1/orgs/${owner.orgId}/members`)
    .set(owner.headers)
    .send({ email, roleId: roles[roleName].id });

  const login = await request(app)
    .post('/api/v1/auth/login')
    .send({ email, password: 'password123' });

  members[roleName] = {
    Authorization: `Bearer ${login.body.accessToken}`,
    'X-Organization-Id': owner.orgId,
  };
}
```

Three steps per member, mirroring reality: the person creates an account, an Owner adds them to the
organization with a role, then they log in and receive their own token.

The result is stored by role name, so tests read naturally:

```js
      const res = await request(app).get('/api/v1/accounts').set(members[roleName]);
```

**Why `let roles, owner` outside the function.** `beforeAll` assigns them, and both `addMember` and
every test need them. Declaring without `const` allows the later assignment.

**Note all four users are in the same organization.** That isolates the variable under test: the
only difference between them is their role, so any difference in outcome must come from permissions
rather than tenancy.

---

**Generic syntax — looping assertions with a failure message**

```js
for (const item of items) {
  expect(result.status, `${item} should behave this way`).toBe(200);
}
```

Most assertion libraries accept a message as a second argument, shown when the assertion fails.

**In this project:**

```js
  it('PERM-2: every role can read (report.view)', async () => {
    for (const roleName of ['Accountant', 'Clerk', 'Viewer']) {
      const res = await request(app).get('/api/v1/accounts').set(members[roleName]);
      expect(res.status, `${roleName} should read accounts`).toBe(200);
    }
  });
```

**Why the message matters here.** Without it, a failure reads `expected 403 to be 200` — but which
of the three roles failed? With it, the output says `Clerk should read accounts`, and you know
immediately.

**Why test that reads succeed.** It seems trivial next to the rejection tests, but it is what makes
them meaningful. If every role were rejected from everything, PERM-3 and PERM-4 would pass while the
system was completely broken. Proving the permitted paths work is what turns the denials into
evidence.

---

**Generic syntax — asserting two things about one failure**

```js
expect(res.status).toBe(403);
expect(res.body.error.code).toBe('forbidden');
```

**In this project — PERM-3, the plan's "RBAC moment":**

```js
  // PERM-3 — the demo's RBAC moment.
  it('PERM-3: a Viewer cannot create master data', async () => {
    const res = await request(app)
      .post('/api/v1/accounts')
      .set(members.Viewer)
      .send({ code: '9999', name: 'Sneaky', type: 'EXPENSE' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
  });
```

The Viewer is a legitimate member with a valid token — `authenticate` and `resolveTenant` both pass.
The rejection comes from `authorize('org.manage')`, because the Viewer role holds only
`report.view`.

The plan (line 1683) names this as a scripted demo beat: the Clerk who *"can draft, cannot post —
the RBAC moment"*.

---

**Generic syntax — testing every member of a group against every restricted action**

```js
for (const role of roles) {
  expect(actionA(role).status).toBe(403);
  expect(actionB(role).status).toBe(403);
}
```

**In this project — PERM-4:**

```js
  it('PERM-4: non-Owners cannot administer membership', async () => {
    for (const roleName of ['Accountant', 'Clerk', 'Viewer']) {
      const list = await request(app)
        .get(`/api/v1/orgs/${owner.orgId}/members`)
        .set(members[roleName]);
      expect(list.status, `${roleName} should not list members`).toBe(403);

      const add = await request(app)
        .post(`/api/v1/orgs/${owner.orgId}/members`)
        .set(members[roleName])
        .send({ email: 'viewer@test.com', roleId: roles.Owner.id });
      expect(add.status, `${roleName} should not add members`).toBe(403);
    }
  });
```

Six assertions from three roles × two actions.

**The `add` attempt is a privilege-escalation test.** It tries to add a user as **Owner** — the most
powerful role. If membership administration were unprotected, any member could promote themselves or
an accomplice and take over the organization. Testing the worst case rather than a harmless one is
the point.

Note the Accountant is included. An Accountant can post journal entries and reconcile banks — real
financial power — yet still must not control who has access. Authority over money and authority
over access are separate, and the test enforces that.

---

**Generic syntax — changing state mid-test to observe an effect**

```js
const before = await action();
await changeSomething();
const after = await action();
expect(before).not.toEqual(after);
```

**In this project — PERM-5, the most important test in the file:**

```js
  // PERM-5 — the reason permissions are not baked into the JWT. A revoked role
  // must bite immediately, not whenever the 15-minute access token expires.
  it('PERM-5: revoking a role takes effect on the very next request, same token', async () => {
    const before = await request(app)
      .post('/api/v1/parties')
      .set(members.Accountant)
      .send({ type: 'customer', code: 'X-1', name: 'Before Revoke' });
    expect(before.status).toBe(403); // Accountant has no org.manage

    // Promote to Owner, reusing the *same* access token issued minutes ago.
    const user = await prisma.user.findUnique({ where: { email: 'accountant@test.com' } });
    await prisma.membership.updateMany({
      where: { userId: user.id, organizationId: owner.orgId },
      data: { roleId: roles.Owner.id },
    });

    const after = await request(app)
      .post('/api/v1/parties')
      .set(members.Accountant)
      .send({ type: 'customer', code: 'X-2', name: 'After Promote' });
    expect(after.status).toBe(201);
  });
```

**`members.Accountant` is never reassigned.** The identical token — issued in `beforeAll`, before
the role changed — is used for both requests. Nothing about the token is different. The only change
is one row in the database.

**What this proves.** If permissions lived inside the JWT, the second request would still be
rejected, because a signed token cannot change after it is issued. The user would keep their old
permissions until the token expired — up to 15 minutes.

Run the same logic in reverse and it is a security failure rather than an inconvenience: a fired
employee retains posting rights over the general ledger for 15 minutes after being locked out.

The plan lists this as mistake #8 (line 1147). `authorize()` costs one indexed query per request and
takes effect on the very next call. This test is the proof, and it would fail loudly if anyone later
"optimised" permissions into the token.

**Why the database is modified directly** rather than through an API call: there is no
"change a member's role" endpoint yet. The test manipulates the underlying state to isolate exactly
one variable.

**What calls this file:** `npm test`.
**What this file calls:** `app.js`, `db/client.js`, `test/helpers.js`, and supertest.

---

**File:** `backend/vitest.config.js`

**Status:** Created

**Purpose:** Configures the test runner.

**Why does this file exist?** Because of a real problem: all three test files wipe the same
database, and Vitest runs test files in parallel by default. They would destroy each other's data
mid-run.

```js
export default defineConfig({
  test: {
    // Every suite TRUNCATEs the same real Postgres database, so files must not
    // run concurrently — parallel runs would wipe each other's fixtures.
    fileParallelism: false,
    // Argon2id is deliberately slow (19MB, 2 passes); auth suites need headroom.
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
```

#### Reading this code from zero

**Generic syntax — a config file with a helper function**

```js
import { defineConfig } from 'tool/config';

export default defineConfig({
  section: { option: value },
});
```

`defineConfig` does nothing at runtime — it is an identity function whose only purpose is to give
editors the type information to autocomplete option names and flag typos.

**In this project:**

```js
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
```

Three settings, each fixing a specific real problem.

---

**`fileParallelism: false` — the correctness one**

```js
    // Every suite TRUNCATEs the same real Postgres database, so files must not
    // run concurrently — parallel runs would wipe each other's fixtures.
    fileParallelism: false,
```

By default Vitest runs test *files* in parallel across CPU cores, which is normally a large speed
win.

Here it would be a disaster. Every suite calls `resetDb()`, which truncates every table. Picture the
default behaviour:

```
Time    isolation.test.js              permissions.test.js
0ms     resetDb()                      resetDb()
50ms    create alice + bob                (still setting up)
100ms   (running ISO-1)                resetDb()   <-- deletes alice and bob
150ms   ISO-1 fails: empty list        (continues happily)
```

The failure would be **intermittent** — dependent on machine speed and core count — and would point
at the isolation code, which is not where the problem is. Intermittent failures that blame the wrong
file are among the most expensive bugs to chase.

`fileParallelism: false` makes files run one after another. Each gets a clean database that stays
clean for its duration. The whole suite still finishes in about 5 seconds.

**The trade-off, stated honestly.** The alternative is a separate database per test file, which
allows parallelism. That is more setup than a seven-day project warrants, and the plan (line 1157)
calls for tests against real PostgreSQL rather than an in-memory substitute — which is what catches
trigger and constraint bugs that mocks never would.

---

**`testTimeout` and `hookTimeout` — the Argon2 ones**

```js
    // Argon2id is deliberately slow (19MB, 2 passes); auth suites need headroom.
    testTimeout: 30000,
    hookTimeout: 60000,
```

A timeout is how long a test may run before being declared hung. Vitest defaults to 5000ms.

**Why the default is not enough.** Every password hash costs roughly 50ms *by design* — that
slowness is the security property. Now count the hashes in `permissions.test.js`:

- `beforeAll` registers 4 users → 4 hashes on register
- each `addMember` logs in → 3 more hashes
- plus organization creation and membership inserts

That is comfortably past 5 seconds on a slower machine, and the run would fail with a timeout that
looks like a hang rather than "this is simply slow work".

`hookTimeout` is separate and larger because it covers `beforeAll`, where the bulk of the hashing
happens. Individual tests are mostly quick reads.

**The lesson worth keeping.** These timeouts are not papering over slow code. The slowness is
intentional and desirable; the configuration acknowledges it. If you ever "optimise" Argon2's
settings to make tests faster, you are weakening password security to speed up a test suite — the
wrong trade.

---

**Why this file did not exist before**

Day 1's tests (`money.test.js`, `triggers.test.js`) needed no configuration. `money.test.js` is pure
computation, and `triggers.test.js` was the only file touching the database, so nothing could
conflict with it.

Adding three database-touching suites created both problems at once. The config file is the response.

**What reads this file:** Vitest, automatically, when `npm test` runs in `backend/`.

**A note on the frontend.** `frontend/vite.config.js` has its own `test` block, because Vite and
Vitest share a config file there. That is why the frontend has no separate `vitest.config.js`.

---

### 3.8 Frontend

**File:** `frontend/vite.config.js`

**Status:** Modified

**Purpose:** Configures the frontend development server and build.

**Why the change?** The browser runs the frontend on port 5173 and the API is on port 3000. Those
are different origins, and the refresh cookie is `SameSite=Strict`, which means the browser refuses
to send it across origins. A proxy makes both appear to be on the same origin.

```js
  server: {
    // Same-origin by proxy, not CORS: the refresh cookie is SameSite=Strict and
    // scoped to /api/v1/auth, so a cross-origin dev setup would silently drop it.
    proxy: {
      '/api/v1': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
```

#### Reading this code from zero

**Generic syntax — a dev-server proxy**

```js
server: {
  proxy: {
    '/some-path': { target: 'http://other-server', changeOrigin: true },
  },
},
```

A *proxy* forwards requests to another server. The browser believes it is talking to one place;
behind the scenes some requests are relayed elsewhere.

**In this project:**

```js
  server: {
    // Same-origin by proxy, not CORS: the refresh cookie is SameSite=Strict and
    // scoped to /api/v1/auth, so a cross-origin dev setup would silently drop it.
    proxy: {
      '/api/v1': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
```

**What an "origin" is.** A browser considers an origin to be *protocol + host + port*. So
`http://localhost:5173` (Vite) and `http://localhost:3000` (the API) are **different origins**, even
though both are localhost. That distinction drives a large amount of browser security.

**What this proxy does.** The frontend calls `/api/v1/parties` — a relative path, so the browser
sends it to `localhost:5173`. Vite matches the `/api/v1` prefix and relays it to `localhost:3000`.
The browser only ever sees one origin.

```
Browser -> localhost:5173/api/v1/parties   (browser thinks: same origin)
             |
             |  Vite relays
             v
           localhost:3000/api/v1/parties   (Express answers)
```

**Why this is necessary rather than convenient.** The refresh cookie is set with
`sameSite: 'strict'`, which instructs the browser to send it **only** on same-origin requests. Call
the API cross-origin and the browser silently omits the cookie — no error, no warning. Every refresh
would return "token missing", and login would appear to work while sessions never survived a reload.

The alternative is configuring CORS with `credentials: true` plus an origin allowlist. That means
preflight requests, more configuration, and a development setup that differs from production. The
proxy makes development match production, where the frontend and API are served under one domain.

`changeOrigin: true` rewrites the `Host` header to the target, which servers that route by hostname
require.

---

**Why the config also holds test settings**

```js
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.js',
    restoreMocks: true,
  },
```

Vitest is built on Vite and reads the same config, which is why the frontend needs no separate
`vitest.config.js`.

`environment: 'jsdom'` provides a simulated browser — `document`, `window`, DOM APIs — inside Node,
so React components can be rendered and queried without launching a real browser.

**What reads this file:** `npm run dev`, `npm run build`, and `npm test` in `frontend/`.

**One practical consequence:** the proxy targets `localhost:3000`, so the backend must be running
before the frontend is useful. A frontend-only session can set `VITE_USE_MOCKS=true` and work
against MSW instead.

---

**File:** `frontend/src/auth/AuthContext.jsx`

**Status:** Modified

**Purpose:** Holds the logged-in user and provides `login`, `register`, and `logout` to the whole
app.

**Why the change?** The access token lives in a JavaScript variable, which is erased when the page
reloads. Without a fix, every refresh of the browser logged the user out. The fix is to try a
silent refresh when the app starts.

```jsx
  const [user, setUser] = useState(null);
  // 'restoring' is the boot state: we hold an httpOnly refresh cookie the JS
  // cannot read, so the only way to know if a session exists is to try it.
  // Without this state ProtectedRoute would bounce every reload to /login.
  const [status, setStatus] = useState('restoring');
  const restoreStarted = useRef(false);

  useEffect(() => {
    // StrictMode runs effects twice in dev. A second /auth/refresh with the same
    // cookie is exactly the replay that trips reuse detection and revokes the
    // family — so the attempt is guarded to fire once.
    if (restoreStarted.current) return;
    restoreStarted.current = true;

    apiRequest('/auth/refresh', { method: 'POST', retryAuth: false })
      .then((session) => {
        setAccessToken(session.accessToken);
        setUser(session.user);
        setStatus('authenticated');
      })
      .catch(() => {
        // No cookie, or it expired//was revoked. Not an error — just logged out.
        setStatus('unauthenticated');
      });
  }, []);
```

#### Reading this code from zero

**Generic syntax — React state**

```jsx
const [value, setValue] = useState(initialValue);
```

`useState` gives a component memory. It returns two things: the current value, and a function to
change it. Calling the setter tells React to re-render the component with the new value.

**In this project:**

```jsx
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState('restoring');
```

`user` starts as `null` — nobody is known yet.

**The `status` value is the important one.** It is a small state machine with four values:

| Status | Meaning | What the UI does |
|---|---|---|
| `restoring` | Checking for an existing session | Show a loading state |
| `authenticating` | A login is in flight | Disable the submit button |
| `authenticated` | Logged in | Show the app |
| `unauthenticated` | Not logged in | Show the login page |

**Why the initial value is `restoring` and not `unauthenticated`.** This single choice is what makes
page reloads work. The access token lives in a JavaScript variable, which is erased on reload. But
the refresh cookie survives — and being `httpOnly`, JavaScript cannot read it to check.

So at boot the app genuinely does not know whether a session exists. The only way to find out is to
ask the server. `restoring` is the honest name for "asking".

If the initial value were `unauthenticated`, `ProtectedRoute` would immediately redirect to `/login`
before the answer came back — logging the user out on every refresh of the page.

---

**Generic syntax — `useRef` as a flag that does not trigger re-renders**

```jsx
const flag = useRef(false);
if (flag.current) return;
flag.current = true;
```

`useRef` creates a box holding a value that survives re-renders. Unlike state, changing `.current`
does **not** cause a re-render. That makes it right for bookkeeping the UI does not display.

**In this project:**

```jsx
  const restoreStarted = useRef(false);
```

---

**Generic syntax — `useEffect` with an empty dependency array**

```jsx
useEffect(() => {
  doSomethingOnce();
}, []);
```

`useEffect` runs code *after* the component renders. The second argument controls when it re-runs:

- `[]` — once, when the component first mounts.
- `[a, b]` — whenever `a` or `b` changes.
- omitted — after every render (rarely what you want).

**In this project:**

```jsx
  useEffect(() => {
    // StrictMode runs effects twice in dev. A second /auth/refresh with the same
    // cookie is exactly the replay that trips reuse detection and revokes the
    // family — so the attempt is guarded to fire once.
    if (restoreStarted.current) return;
    restoreStarted.current = true;

    apiRequest('/auth/refresh', { method: 'POST', retryAuth: false })
      .then((session) => {
        setAccessToken(session.accessToken);
        setUser(session.user);
        setStatus('authenticated');
      })
      .catch(() => {
        // No cookie, or it expired//was revoked. Not an error — just logged out.
        setStatus('unauthenticated');
      });
  }, []);
```

**Why the guard is not optional.** React's StrictMode — enabled in `frontend/src/main.jsx` —
deliberately mounts, unmounts, and remounts components in development to surface bugs. Effects
therefore run **twice**.

Normally that is harmless. Here it would be actively destructive:

```
Effect run 1: POST /auth/refresh with cookie A  -> A marked used, cookie B issued
Effect run 2: POST /auth/refresh with cookie A  -> A already used!
                                                 -> REUSE DETECTED
                                                 -> entire family revoked
                                                 -> user logged out
```

The backend would be behaving perfectly. Reuse detection is doing exactly its job — it cannot tell
StrictMode's duplicate from a stolen token. Two individually correct systems, combined, produce a
user who cannot stay logged in.

`restoreStarted` guarantees one attempt per page load. The plan predicted this exact collision
(line 1907) and budgeted three hours for it.

**A second layer already exists.** `frontend/src/lib/api-client.js`, written on Day 1, deduplicates
concurrent refreshes:

```js
async function refreshAccessToken() {
  if (!refreshPromise) {
    refreshPromise = fetch(apiUrl('/auth/refresh'), { ... })
      .finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}
```

If several API calls return 401 at once, only the first starts a refresh and the rest await the same
promise. This is the plan's "one request-deduplicating refresh promise". Belt and braces: the ref
guards boot, the promise guards concurrent 401s.

---

**Generic syntax — promise chaining**

```js
doAsyncThing()
  .then((result) => { /* success */ })
  .catch((error) => { /* failure */ });
```

`.then` runs on success with the resolved value; `.catch` runs on failure.

**Why `.then`/`.catch` here rather than `async`/`await`?** Because `useEffect`'s callback must not be
`async` — React expects it to return either nothing or a cleanup function, and an `async` function
always returns a promise, which React would misinterpret.

**Why `retryAuth: false`.** Looking at `api-client.js`, a 401 normally triggers an automatic refresh
and retry. But this request *is* the refresh. Without the flag, a failed refresh would trigger
another refresh, which would fail, and so on.

**Why the `.catch` is empty of error handling.** A failed refresh is the *normal* case for a first-
time visitor — there is no cookie. It is not an error condition, so there is nothing to report; the
app simply concludes "not logged in" and moves on.

---

**Generic syntax — `useMemo` for a stable object**

```jsx
const value = useMemo(() => ({ a, b }), [a, b]);
```

`useMemo` recomputes only when a dependency changes.

**In this project:**

```jsx
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
```

**What a Context is.** React normally passes data down through props, parent to child. Context lets a
value be published once at the top and read by any descendant, however deep — avoiding threading
`user` through five intermediate components that do not care about it. Any component can call
`useAuth()` and get this object.

**Why `useMemo` matters here.** Without it, a new object would be created on every render, and every
component consuming the context would re-render even when nothing meaningful changed. Memoising
means the object is rebuilt only when `user` or `status` actually changes.

---

**What happens at runtime — reloading the page while logged in**

1. Browser reloads. All JavaScript state is destroyed, including the access token.
2. React mounts `AuthProvider`; `status` is `restoring`.
3. `ProtectedRoute` sees `restoring` and shows "Restoring your session" — crucially, it does **not**
   redirect.
4. The effect fires (once, thanks to the ref) and POSTs to `/auth/refresh`.
5. The browser attaches the refresh cookie automatically.
6. The backend rotates the token and returns `{ user, accessToken }`.
7. `setAccessToken` stores the token in memory; `setUser` and `setStatus` update React.
8. Re-render: `ProtectedRoute` now sees `authenticated` and shows the page.

The user sees a brief loading state and stays logged in.

**And for a first-time visitor:** identical until step 6, where there is no cookie and the server
returns 401. `.catch` sets `unauthenticated`, and the login page appears.

**What calls this file:** `frontend/src/main.jsx` wraps the app in `<AuthProvider>`.
**What this file calls:** `lib/api-client.js` and `auth/auth-context.js`.

---

**File:** `frontend/src/components/ProtectedRoute.jsx`

**Status:** Modified

**Purpose:** Blocks pages that require login.

**Why the change?** It needed to understand the new `restoring` state, otherwise it would redirect
to `/login` while the silent refresh was still in flight.

```jsx
  // Redirecting while the boot refresh is still in flight would log the user
  // out on every page reload.
  if (status === 'restoring') {
    return <AsyncState title="Restoring your session" message="Checking for an existing sign-in." />;
  }

  if (status !== 'authenticated') {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
```

#### Reading this code from zero

**Generic syntax — conditional rendering with early returns**

```jsx
function Component() {
  if (loading) return <Spinner />;
  if (!allowed) return <Redirect />;
  return <TheRealThing />;
}
```

A React component is a function returning what should appear on screen. Returning early is how
components branch — one render path per situation.

**In this project:**

```jsx
export function ProtectedRoute() {
  const { status } = useAuth();
  const location = useLocation();

  // Redirecting while the boot refresh is still in flight would log the user
  // out on every page reload.
  if (status === 'restoring') {
    return <AsyncState title="Restoring your session" message="Checking for an existing sign-in." />;
  }

  if (status !== 'authenticated') {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <Outlet />;
}
```

Three outcomes in a deliberate order.

**`useAuth()`** reads the context published by `AuthProvider`. That is how this component sees
`status` without any parent passing it down.

---

**The first branch is the fix, and the order is the whole point**

```jsx
  if (status === 'restoring') {
    return <AsyncState title="Restoring your session" ... />;
  }
```

The `restoring` check must come **before** the authentication check. Walk through what happens
without it:

```
Reload -> status is 'restoring'
       -> 'restoring' !== 'authenticated'
       -> redirect to /login
       -> the refresh completes half a second later, but the user is already gone
```

That is precisely the "logged out on every refresh" bug. Placing the `restoring` branch first means
the app waits for the answer rather than assuming the worst.

**Why `AsyncState` rather than a bare "Loading…".** It is the shared component from
`frontend/src/components/AsyncState.jsx`, used for every loading, empty, and error state across the
app. The plan (line 1446) asks for exactly this:

> Empty / loading / error states as a reusable pattern **now**, not on Day 7.

It carries `role="status"`, which tells screen readers to announce the change — a user who cannot
see the spinner still learns that something is happening.

---

**The second branch — redirecting while remembering where you were**

```jsx
    return <Navigate to="/login" state={{ from: location }} replace />;
```

`<Navigate>` is React Router's declarative redirect: rendering it performs the navigation.

**`state={{ from: location }}`** attaches the page the user was trying to reach. Router state travels
with the navigation without appearing in the URL, so after logging in the app can send them back to
where they were aiming rather than dumping them on a generic dashboard.

**`replace`** substitutes the current history entry instead of adding one. Without it, pressing Back
after login would return to the login page, which would redirect forward again — a trap the user
cannot escape with the Back button.

**Why `status !== 'authenticated'`** rather than checking for `unauthenticated` specifically: it
catches `unauthenticated` *and* `authenticating` *and* any status added later. Defaulting to "deny
unless explicitly allowed" is the right posture for an access check — a new status must not
accidentally grant entry.

---

**The third branch — `<Outlet />`**

```jsx
  return <Outlet />;
```

`Outlet` is React Router's placeholder for child routes. Look at `frontend/src/App.jsx`:

```jsx
      <Route element={<ProtectedRoute />}>
        <Route element={<AppShell />}>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/customers" element={<CustomersPage />} />
        </Route>
      </Route>
```

Every route nested inside renders through `ProtectedRoute`'s `Outlet`. So the guard is written
**once** and applies to all of them — including pages added on Days 3 through 6, automatically.

This mirrors the backend's `router.use(authenticate, resolveTenant)` in `masters.js`: state the
requirement once for a group rather than repeating it per route, so a new route cannot be added
unprotected by accident.

---

**An important caveat: this is not security**

This component controls what the *UI shows*. It is not an access control.

Anyone can open devtools and alter JavaScript state to render the dashboard. What they cannot do is
obtain data, because every API request is checked by `authenticate`, `resolveTenant`, and
`authorize` on the server — where the checks actually matter.

Frontend guards exist for *user experience*: showing a login form instead of a dashboard full of
failed requests. Backend guards exist for *security*. Confusing the two is a common and serious
mistake.

---

**What happens at runtime — visiting `/customers` directly while logged out**

1. Router matches the route; `ProtectedRoute` renders first.
2. `status` is `restoring` → the loading state appears.
3. The boot refresh fails (no cookie) → `status` becomes `unauthenticated`.
4. Re-render → the second branch → redirect to `/login`, carrying `from: '/customers'`.
5. After a successful login, the app can return them to `/customers`.

**And while logged in:** step 3 instead sets `authenticated`, the third branch runs, and `<Outlet />`
renders `AppShell` and then `CustomersPage`.

**What calls this file:** `frontend/src/App.jsx`.
**What this file calls:** `auth/auth-context.js`, `components/AsyncState.jsx`, and React Router.

---

**File:** `frontend/src/pages/AccountsPage.jsx`

**Status:** Created

**Purpose:** Displays the chart of accounts, grouped by account type.

```jsx
// Balance-sheet accounts first, then P&L — the order every accountant expects
// to read a chart of accounts in.
const TYPE_ORDER = [
  ['ASSET', 'Assets'],
  ['LIABILITY', 'Liabilities'],
  ['EQUITY', 'Equity'],
  ['REVENUE', 'Revenue'],
  ['EXPENSE', 'Expenses'],
];
```

```jsx
  const accounts = useQuery({
    // The org id is part of the key so switching orgs refetches rather than
    // showing the previous tenant's chart from cache.
    queryKey: ['accounts', activeOrganizationId],
    queryFn: () => apiRequest('/accounts'),
    enabled: Boolean(activeOrganizationId),
  });
```

#### Reading this code from zero

**Generic syntax — an array of pairs used to drive rendering**

```jsx
const ORDER = [['KEY', 'Label'], ['OTHER', 'Other label']];
ORDER.map(([key, label]) => <Section key={key} title={label} />);
```

**In this project:**

```jsx
// Balance-sheet accounts first, then P&L — the order every accountant expects
// to read a chart of accounts in.
const TYPE_ORDER = [
  ['ASSET', 'Assets'],
  ['LIABILITY', 'Liabilities'],
  ['EQUITY', 'Equity'],
  ['REVENUE', 'Revenue'],
  ['EXPENSE', 'Expenses'],
];
```

Each pair holds the database value and the label shown to the user.

**The ordering is domain knowledge, not aesthetics.** Assets, Liabilities and Equity form the balance
sheet; Revenue and Expenses form the profit and loss statement. Every accounting package presents
them in this order, so an accountant can scan the page without re-reading it. Sorting alphabetically
would put Equity first and look wrong to the only people who matter.

Hard-coding the order also means an unexpected account type simply does not render, rather than
appearing in an arbitrary position.

---

**Generic syntax — fetching server data with TanStack Query**

```jsx
const result = useQuery({
  queryKey: ['identifier', variable],
  queryFn: () => fetchTheData(),
  enabled: shouldRun,
});
```

`useQuery` handles fetching, caching, loading and error states in one hook. It returns an object with
`.data`, `.isPending`, `.isError`, and `.error`.

**In this project:**

```jsx
  const { activeOrganizationId } = useOutletContext();
  const accounts = useQuery({
    // The org id is part of the key so switching orgs refetches rather than
    // showing the previous tenant's chart from cache.
    queryKey: ['accounts', activeOrganizationId],
    queryFn: () => apiRequest('/accounts'),
    enabled: Boolean(activeOrganizationId),
  });
```

**`queryKey` is the cache key, and including the org ID is essential.** TanStack Query caches by key.
With a key of just `['accounts']`, switching from Annapurna to Sherpa would show Annapurna's cached
accounts, because the key had not changed — a tenant data leak visible in the UI even though the API
behaved correctly.

Including `activeOrganizationId` makes the key change on switch, so a different cache entry is used
and fresh data is fetched. The two organizations' data can coexist in the cache without ever mixing.

**`enabled: Boolean(activeOrganizationId)`** prevents the request from firing before an organization
is known. `AppShell` loads the organization list first; until it resolves, `activeOrganizationId` is
an empty string. Without `enabled`, the app would send a request with no `X-Organization-Id` header
and get a 400.

`Boolean(x)` converts to a real boolean — `''` becomes `false`, a UUID becomes `true`.

**`useOutletContext()`** reads the value `AppShell` passes to its child routes:

```jsx
        <Outlet context={{ activeOrganizationId }} />
```

That is how the org switcher in the shell reaches every page without prop-threading.

**What `apiRequest` does behind this call.** From `frontend/src/lib/api-client.js`, it attaches the
`Authorization` header, attaches `X-Organization-Id`, unwraps the response envelope, and — if a 401
comes back — silently refreshes the token and retries once. The page never handles any of that.

---

**Generic syntax — chained conditional rendering**

```jsx
{loading ? <Loading /> : error ? <Error /> : empty ? <Empty /> : <Content />}
```

Nested ternaries inside JSX select exactly one branch. Verbose, but it forces every state to be
handled.

**In this project:**

```jsx
      {!activeOrganizationId || accounts.isPending ? (
        <AsyncState title="Loading accounts" message="Fetching this organization's chart of accounts." />
      ) : accounts.isError ? (
        <AsyncState title="Accounts unavailable" message={accounts.error.message} />
      ) : accounts.data.length === 0 ? (
        <AsyncState title="No accounts yet" message="This organization has no chart of accounts." />
      ) : (
        TYPE_ORDER.map(...)
      )}
```

Four states, all handled: loading, error, empty, and content. This is the reusable pattern the plan
asks for on Day 2 rather than Day 7 (line 1446).

**Why the empty state is separate from the loading state.** "No accounts yet" and "still loading"
look identical if you only check `isPending` — the user sees a blank area and cannot tell whether to
wait or to act.

**Why `accounts.error.message` is safe to display.** The backend's error envelope carries a
human-readable message written for users; `api-client.js` parses it into an `ApiError`. The user sees
"Not a member of this organization", not a stack trace.

**The `!activeOrganizationId ||` prefix** covers the moment before the query is enabled, when
`isPending` is technically false but no data exists.

---

**Generic syntax — grouping and skipping empty groups**

```jsx
GROUPS.map(([key, label]) => {
  const items = data.filter((d) => d.type === key);
  if (items.length === 0) return null;
  return <Section key={key}>...</Section>;
});
```

Returning `null` from inside `.map` renders nothing for that entry.

**In this project:**

```jsx
        TYPE_ORDER.map(([type, label]) => {
          const group = accounts.data.filter((account) => account.type === type);
          if (group.length === 0) return null;

          return (
            <section className="account-group" key={type}>
              <h2>{label}</h2>
              <table className="data-table">
```

The grouping happens in the browser rather than the server, which is right at this scale — 27
accounts arrive in one response, and filtering them five times is instant. Asking the server for
five separate groups would mean five round trips for no benefit.

**`key={type}`** is React's identity hint for list items. Without it React cannot tell which element
is which across re-renders and may reuse DOM nodes incorrectly.

---

**Generic syntax — conditional elements**

```jsx
{condition && <Thing />}
```

`&&` renders the right side only when the left is true. If the condition is false, nothing renders.

**In this project:**

```jsx
                      <td>
                        {/* A control account is reconciled against a subledger,
                            so manual journals into it are blocked server-side. */}
                        {account.isControlAccount && <span className="badge badge-control">Control</span>}
                        {account.isBankAccount && <span className="badge badge-bank">Bank</span>}
                        {!account.isActive && <span className="badge">Inactive</span>}
                      </td>
```

Three independent badges, each appearing only when its flag is set.

**What "control account" means, and why the badge matters.** The plan (line 363) explains that
Accounts Receivable is a *control account*: its balance must always equal the sum of the customer
subledger. If someone posts a manual journal straight into AR, the two disagree and no report can be
trusted again. Day 3's manual journal validator blocks that server-side; this badge makes the rule
visible in the UI.

The plan calls it "the detail that shows you've used real accounting software".

**`{/* comment */}`** is how comments are written inside JSX — a JavaScript block comment wrapped in
braces, since `//` inside JSX would render as text.

---

**A detail with real accounting significance**

```jsx
                      <td className="numeric">{account.code}</td>
```

The `numeric` class applies `font-variant-numeric: tabular-nums` (added to
`frontend/src/index.css` this session), which forces every digit to the same width so figures line
up vertically in a column.

In proportional fonts `1` is narrower than `8`, and a column of account codes or amounts looks
ragged and is genuinely harder to scan. The plan lists tabular numerals as a polish item (line
1531); applying it now costs nothing.

---

**What happens at runtime**

1. User clicks "Chart of accounts"; the router renders `AccountsPage` inside `AppShell`.
2. `useOutletContext()` supplies the active organization ID.
3. `useQuery` sees `enabled: true` and calls `apiRequest('/accounts')`.
4. `api-client.js` adds both headers and sends the request through the Vite proxy.
5. The backend runs `authenticate` → `resolveTenant` → `authorize('report.view')`, and the tenant
   extension scopes the query.
6. 27 accounts return. `isPending` becomes false; React re-renders.
7. The five groups render in balance-sheet order, with badges.
8. Switching organizations changes `activeOrganizationId`, which changes the query key, which
   triggers a fresh fetch.

**What calls this file:** `frontend/src/App.jsx`, at route `/accounts`.
**What this file calls:** `lib/api-client.js`, `components/AsyncState.jsx`, TanStack Query, React
Router.

---

**File:** `frontend/src/pages/CustomersPage.jsx`

**Status:** Created

**Purpose:** Lists customers with search and pagination, and provides a slide-out form to create
one.

The part worth studying — why empty fields are dropped before sending:

```jsx
    createParty.mutate({
      type: form.type,
      code: form.code.trim(),
      name: form.name.trim(),
      // The server schema is .strict() — sending empty strings for optional
      // fields would fail validation, so drop them entirely.
      ...(form.email ? { email: form.email.trim() } : {}),
      ...(form.phone ? { phone: form.phone.trim() } : {}),
      creditDays: Number(form.creditDays),
    });
```

#### Reading this code from zero

**Generic syntax — state for form fields**

```jsx
const EMPTY = { fieldA: '', fieldB: 0 };
const [form, setForm] = useState(EMPTY);

function update(field, value) {
  setForm((current) => ({ ...current, [field]: value }));
}
```

One state object holds every field, and one `update` function changes any of them.

**In this project:**

```jsx
const EMPTY_FORM = { type: 'customer', code: '', name: '', email: '', phone: '', creditDays: 30 };

  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }
```

**`[field]: value` is a computed property name.** The square brackets mean "use the *value* of the
variable `field` as the property name". So `update('code', 'C001')` sets the `code` property. Without
brackets it would create a property literally called `"field"`.

**Why the setter takes a function.** `setForm((current) => ...)` receives the latest state, which
matters because React batches updates — reading `form` directly could give a stale value if two
updates happen in quick succession.

**Why `...current` is required.** Writing `setForm({ [field]: value })` would *replace* the whole
object, wiping every other field. Spreading copies the existing values first.

`creditDays: 30` starts at the plan's default credit term.

---

**Generic syntax — validation returning an error map**

```js
function validate(form) {
  const errors = {};
  if (!form.field) errors.field = 'Required';
  return errors;
}

const found = validate(form);
if (Object.keys(found).length > 0) return;
```

**In this project:**

```jsx
// Mirrors the server's Zod schema. The server is still the authority — this
// only spares the user a round trip for obvious mistakes.
function validate(form) {
  const errors = {};
  if (!form.code.trim()) errors.code = 'Code is required';
  if (!form.name.trim()) errors.name = 'Name is required';
  if (form.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email)) errors.email = 'Enter a valid email';
  if (Number.isNaN(Number(form.creditDays)) || Number(form.creditDays) < 0) {
    errors.creditDays = 'Credit days must be 0 or more';
  }
  return errors;
}
```

**The comment states the critical principle.** Client validation is a *convenience*, never a security
control. Anyone can bypass it with devtools or by calling the API directly. The server's
`createPartySchema` in `masters.js` is the real gate. Removing this function would make the UI worse;
removing the server's would make the system exploitable.

**`.trim()`** removes surrounding whitespace, so a field containing only spaces counts as empty.

**`form.email && ...`** — email is optional, so validate the format only when something was typed.

**Reading the regex** `/^[^@\s]+@[^@\s]+\.[^@\s]+$/`:

- `^` start, `$` end — the whole string must match.
- `[^@\s]+` — one or more characters that are not `@` and not whitespace.
- `@` then more non-`@` characters, then `\.` (a literal dot), then more.

So: *something, an @, something, a dot, something.* Deliberately loose — fully validating an email
address by pattern is famously impossible, and the only real proof is sending mail to it.

**`Object.keys(found).length > 0`** counts the properties on the error object. Zero errors means an
empty object, which is truthy in JavaScript — so you must count keys rather than testing the object
itself. This is a common bug.

---

**Generic syntax — a mutation**

```jsx
const mutation = useMutation({
  mutationFn: (input) => postToServer(input),
  onSuccess: () => { invalidateCache(); },
  onError: (error) => { showMessage(error); },
});

mutation.mutate(data);
```

`useQuery` reads; `useMutation` writes. It tracks in-flight state and gives success and failure
hooks.

**In this project:**

```jsx
  const createParty = useMutation({
    mutationFn: (input) => apiRequest('/parties', { method: 'POST', body: input }),
    onSuccess: (party) => {
      // Invalidate every page/search combination, not just the current one.
      queryClient.invalidateQueries({ queryKey: ['parties'] });
      notify({ title: 'Customer created', message: party.name, tone: 'success' });
      closeDrawer();
    },
    onError: (error) => {
      notify({ title: 'Could not create customer', message: error.message, tone: 'error' });
    },
  });
```

**What "invalidate" means.** TanStack Query caches results. After creating a customer, the cached
list is stale. `invalidateQueries` marks matching entries as outdated so they refetch, and the new
row appears without a manual reload.

**Why the key is just `['parties']`.** The list query uses
`['parties', activeOrganizationId, search, page]`. Invalidating the prefix `['parties']` matches
**every** variation — every page, every search term. Passing the full key would refresh only the
current view, leaving other pages stale in the cache.

**Why refetch rather than insert the row locally?** The server may have transformed the data — it
lowercases the type, applies defaults, and generates the ID. Refetching guarantees the screen shows
what was actually stored rather than what we hoped was stored.

`error.message` is safe to show because it comes from the backend's error envelope, parsed into an
`ApiError` by `api-client.js`.

---

**Generic syntax — conditionally including properties**

```js
const payload = {
  required: value,
  ...(optional ? { optional } : {}),
};
```

**In this project — the detail that connects directly to the backend:**

```jsx
    createParty.mutate({
      type: form.type,
      code: form.code.trim(),
      name: form.name.trim(),
      // The server schema is .strict() — sending empty strings for optional
      // fields would fail validation, so drop them entirely.
      ...(form.email ? { email: form.email.trim() } : {}),
      ...(form.phone ? { phone: form.phone.trim() } : {}),
      creditDays: Number(form.creditDays),
    });
```

The form always has `email` and `phone` properties, holding `''` when untouched. The server schema
declares:

```js
  email: z.string().email().optional(),
```

`.optional()` permits the field to be **absent** — it does not permit an empty string, which fails
the `.email()` check. Sending `email: ''` would produce a 400.

Conditional spread omits the property entirely when empty, which is what `.optional()` expects.

**`Number(form.creditDays)`** converts the input's string to a number, because HTML inputs always
produce strings and the server schema expects `z.number()`.

---

**Generic syntax — controlled inputs**

```jsx
<input value={state.field} onChange={(e) => update('field', e.target.value)} />
```

A *controlled* input takes its displayed value from state and reports changes back. React state is
the single source of truth, and the DOM merely reflects it.

**In this project:**

```jsx
            <label>
              Code
              <input value={form.code} onChange={(e) => update('code', e.target.value)} aria-invalid={Boolean(errors.code)} />
              {errors.code && <span className="field-error">{errors.code}</span>}
            </label>
```

**`aria-invalid`** tells screen readers the field has failed validation. A sighted user sees a red
border; this is the equivalent signal for someone who cannot.

**The input is inside the `<label>`**, which associates the two without needing matching `id` and
`for` attributes. Clicking the label focuses the input, and screen readers announce the label when
the field receives focus.

---

**Generic syntax — pagination controls without a total count**

```jsx
<button disabled={page === 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
<button disabled={items.length < PAGE_SIZE} onClick={() => setPage((p) => p + 1)}>Next</button>
```

**In this project:**

```jsx
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
```

The API returns an array with no total, because `docs/openapi.yaml` specifies a plain array. So the
UI infers: a full page of 20 probably means more exist; fewer than 20 means this is the last.

**The known imperfection:** with exactly 20 customers, "Next" is enabled and leads to an empty page.
The honest fix is a total count in the response, which is a contract change — deliberately not made
for a cosmetic issue. Naming the limitation is better than pretending it is not there.

**`type="button"` is not optional.** Buttons inside a `<form>` default to `type="submit"`. Without
this, clicking "Next" would submit the form.

**`setPage((p) => p + 1)`** uses the function form to avoid acting on a stale value.

---

**Generic syntax — a modal dialog**

```jsx
{isOpen && (
  <div role="dialog" aria-modal="true" aria-label="Title">
    ...
  </div>
)}
```

**In this project:**

```jsx
      {drawerOpen && (
        <div className="drawer" role="dialog" aria-modal="true" aria-label="New customer">
          <form className="drawer-panel" onSubmit={submit} noValidate>
```

`role="dialog"` and `aria-modal="true"` tell assistive technology this is a modal overlay and that
content behind it is inert.

**`noValidate`** disables the browser's own validation bubbles, so our `validate()` function is the
only source of error messages — one consistent style rather than two competing ones.

**`onSubmit` on the form, not `onClick` on the button.** This makes Enter submit the form, which
users expect. The handler starts with `event.preventDefault()` to stop the browser's default
full-page reload.

---

**What happens at runtime — creating a customer**

1. User clicks "New customer"; `drawerOpen` becomes true and the drawer renders.
2. Typing updates `form` on each keystroke; React re-renders with the new values.
3. Submit → `preventDefault()` → `validate(form)`.
4. Errors → shown under the offending fields, nothing sent.
5. Valid → `createParty.mutate(...)` with empty optional fields omitted.
6. The button shows "Creating…" while `isPending` is true.
7. `api-client.js` adds both headers plus an `Idempotency-Key`, and POSTs.
8. The backend validates with Zod, uppercases the type, and the tenant extension stamps the
   organization.
9. `onSuccess` → invalidate `['parties']` → toast → close and reset the drawer.
10. The list refetches and the new customer appears.

**What calls this file:** `frontend/src/App.jsx`, at route `/customers`.
**What this file calls:** `lib/api-client.js`, `components/AsyncState.jsx`,
`components/toast-context.js`, TanStack Query, React Router.

---

**File:** `frontend/src/mocks/handlers.js`

**Status:** Modified

**Purpose:** Fake API responses used by tests and by frontend-only development.

**Why the change?** The mock `/auth/refresh` always succeeded. Once the app started calling refresh
on boot, every test began life already logged in — which is not how a fresh browser behaves.

```js
// Stands in for the httpOnly refresh cookie the mock layer cannot observe.
export const mockSession = { active: false };
```

```js
  http.post('/api/v1/auth/refresh', () => {
    if (!mockSession.active) {
      return fail('refresh_invalid', 'Refresh token invalid, reused, or expired', 401);
    }
    return ok({ user: demoUser, accessToken: 'mock-refreshed-access-token' });
  }),
```

#### Reading this code from zero

**Generic syntax — a request handler in MSW**

```js
import { http, HttpResponse } from 'msw';

export const handlers = [
  http.post('/api/path', async ({ request }) => {
    const body = await request.json();
    return HttpResponse.json({ data: 'value' });
  }),
];
```

**What MSW is.** Mock Service Worker intercepts network requests *at the network layer* — the
application's own `fetch` calls are unmodified, but the request never leaves the machine. That makes
it much closer to reality than stubbing `fetch` itself, because the real API client, the real
headers, and the real response parsing all still run.

**Why it exists in this project.** On Day 1 the backend did not exist. The plan (line 1566) has the
frontend developer build against mocks derived from the contract from the start:

```
B: shell+design ──> auth UI ──> invoice UI ──> ...
        └────────── all built against MSW mocks from the Day 1 contract ──────────┘
```

After Day 2 the app talks to the real backend, and mocks are used only by tests and by
frontend-only sessions via `VITE_USE_MOCKS=true`.

---

**Generic syntax — module-level mutable state**

```js
export const state = { flag: false };
```

Exporting an **object** rather than a boolean matters: importers share the same object, so a change
made in one file is visible in another. Exporting a bare `let flag` would give importers a snapshot
that never updates.

**In this project:**

```js
// Stands in for the httpOnly refresh cookie the mock layer cannot observe.
export const mockSession = { active: false };
```

**Why this was necessary.** The refresh cookie is `httpOnly`, so JavaScript — including MSW — cannot
read it. There is no way for the mock to check "does this browser have a valid session?" the way the
real backend checks its database.

So session state is modelled explicitly. `mockSession.active` stands in for "a valid refresh cookie
exists".

---

**The bug this fixed**

Before this session the handler was unconditional:

```js
  http.post('/api/v1/auth/refresh', () =>
    ok({ user: demoUser, accessToken: 'mock-refreshed-access-token' }),
  ),
```

Always successful. That was harmless until Day 2 added the boot-time silent refresh — at which point
**every test began life already logged in**, because the mock claimed a valid session for a browser
that had never logged in.

The visible symptom was a test failing with `Unable to find an accessible element with the role
"heading" and name "Welcome back"` — the login page was not rendering, because `ProtectedRoute` had
been told the user was authenticated.

**The app was right; the mock was wrong.** A real browser with no cookie gets a 401.

The fix models the real state machine:

```js
  http.post('/api/v1/auth/refresh', () => {
    if (!mockSession.active) {
      return fail('refresh_invalid', 'Refresh token invalid, reused, or expired', 401);
    }
    return ok({ user: demoUser, accessToken: 'mock-refreshed-access-token' });
  }),
```

with login and register setting the flag:

```js
    mockSession.active = true;
    return ok({ user: demoUser, accessToken: 'mock-access-token' });
```

and logout clearing it:

```js
  http.post('/api/v1/auth/logout', () => {
    mockSession.active = false;
    return new HttpResponse(null, { status: 204 });
  }),
```

**The error codes and messages match the real backend exactly** — `refresh_invalid`, and the same
message string from `routes/auth.js`. A mock that returns a different shape from the real API tests
nothing useful.

---

**Generic syntax — resetting shared state between tests**

```js
beforeEach(() => {
  sharedState.value = initial;
});
```

**In this project**, from `frontend/src/pages/auth-pages.test.jsx`:

```jsx
  // Each test starts as a fresh browser: no refresh cookie, no in-memory token.
  beforeEach(() => {
    mockSession.active = false;
    resetApiClient();
  });
```

**Why `beforeEach` and not `beforeAll`.** Module state persists across tests in the same file. A
login test setting `active = true` would leak into the next test, which would then start logged in
and fail confusingly. Resetting before *each* test guarantees independence.

`resetApiClient()` clears the in-memory access token in `api-client.js` for the same reason.

**This is the general lesson about mutable module state:** it is convenient, and it leaks between
tests unless explicitly reset.

---

**The two tests this made possible**

```jsx
  it('restores an existing session on boot instead of redirecting to login', async () => {
    mockSession.active = true;
    renderAuthRoute('/dashboard');

    expect(
      await screen.findByRole('heading', { name: 'Financial control center' }),
    ).toBeInTheDocument();
  });

  it('sends an unauthenticated visitor to login when no session exists', async () => {
    renderAuthRoute('/dashboard');

    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
  });
```

Two branches of the same behaviour: with a session, the protected page renders; without one, the
login page does. Together they lock in the reload fix — if someone later removed the `restoring`
state, the first test would fail.

**`findByRole` versus `getByRole`.** `getBy*` searches immediately and throws if absent. `findBy*`
returns a promise and retries for a short period. The boot refresh is asynchronous, so the assertion
must wait for it — using `getByRole` here would fail because the page had not updated yet.

**Querying by role and accessible name** rather than by CSS class means the test asserts what a
*user* perceives. It keeps passing through restyling, and it fails if the heading stops being a real
heading — so it doubles as an accessibility check.

---

**Generic syntax — a shared response helper**

```js
const ok = (data, init) => HttpResponse.json({ data }, init);
```

**In this project:**

```js
const ok = (data, init) => HttpResponse.json({ data }, init);
const fail = (code, message, status = 400) =>
  HttpResponse.json(
    { error: { code, message, requestId: `mock-${code}` } },
    { status },
  );
```

`fail` reproduces the backend's error envelope exactly — `code`, `message`, `requestId` — so
`api-client.js` parses mock errors through the identical path it uses for real ones.

Note `ok` wraps data in `{ data }`. The real backend returns bare objects, which is why
`api-client.js` ends with:

```js
    return payload?.data ?? payload;
```

It accepts either shape. That tolerance is what lets the same client work against both.

---

**What happens at runtime**

**In tests:** `frontend/src/test/setup.js` starts the MSW server; requests are intercepted in-process
and answered by these handlers.

**In the browser with `VITE_USE_MOCKS=true`:** `main.jsx` registers a Service Worker
(`frontend/public/mockServiceWorker.js`) that intercepts requests at the browser level.

**In normal development:** mocks are skipped entirely and requests go through the Vite proxy to the
real backend:

```js
// Day 2 wires the app to the real API. Mocks stay available behind a flag
// (VITE_USE_MOCKS=true) for working on screens while the backend is down.
async function enableMocking() {
  if (!import.meta.env.DEV || import.meta.env.VITE_USE_MOCKS !== 'true') return;
```

**What calls this file:** `frontend/src/mocks/server.js` (tests), `frontend/src/mocks/browser.js`
(browser), and `auth-pages.test.jsx` (imports `mockSession` directly).

---

**File:** `docs/openapi.yaml`

**Status:** Modified

**Purpose:** The API contract — the agreed description of every endpoint.

**Why the change?** `/auth/refresh` now returns the user object as well as the token. This is the
one contract change made in this session, and it is explained fully in section 7.

```yaml
  /auth/refresh:
    post:
      summary: Rotate refresh token, issue new access token
      security: []
      description: >
        Reads the httpOnly refresh cookie; no request body. Returns the user
        alongside the token so a page reload can restore the session in a single
        round trip — the access token is held in memory only and is lost on reload.
      responses:
        '200':
          description: New access token issued
          content:
            application/json:
              schema:
                type: object
                properties:
                  user:
                    $ref: '#/components/schemas/User'
                  accessToken:
                    type: string
```

#### Reading this code from zero

**Generic syntax — YAML**

```yaml
key: value
parent:
  child: value
  list:
    - item one
    - item two
```

YAML is a format for structured data, like JSON but without braces. **Indentation defines
structure** — nesting is expressed purely by how far a line is indented. A `-` marks a list item.

This is a *specification* file. No program imports it at runtime; it describes what the API promises.

**Generic syntax — an OpenAPI path**

```yaml
paths:
  /some/path:
    get:
      summary: What this does
      responses:
        '200':
          description: Success
```

OpenAPI is a standard vocabulary for describing HTTP APIs. Structure: paths, then methods, then
responses by status code.

**In this project:**

```yaml
  /auth/refresh:
    post:
      summary: Rotate refresh token, issue new access token
      security: []
```

`security: []` means *no authentication required*. That is correct and deliberate: this endpoint is
how a client that has **lost** its access token gets a new one. Requiring an access token here would
be circular. Authentication comes from the refresh cookie instead.

The quotes around `'200'` are required — unquoted, YAML would read it as the number 200 rather than
the string key OpenAPI expects.

---

**Generic syntax — a reference**

```yaml
                  fieldName:
                    $ref: '#/components/schemas/TypeName'
```

`$ref` points at a definition declared elsewhere in the file. `#/components/schemas/User` means "the
`User` schema in the `components.schemas` section".

**In this project:**

```yaml
                properties:
                  user:
                    $ref: '#/components/schemas/User'
                  accessToken:
                    type: string
```

The `User` shape is defined once, near the top:

```yaml
    User:
      type: object
      properties:
        id: ...
        email: ...
        createdAt: ...
      required: [id, email, createdAt]
```

**Why references matter.** `User` appears in register, login, refresh, and member listings. Defining
it once means all four cannot drift apart. It is the same principle as extracting a shared function.

**Notice what `User` does not contain:** no `name`, and no `password` or `passwordHash`. This is why
the "Full name" field was removed from `RegisterPage.jsx` — the contract has no such field, and the
server's `.strict()` schema would have rejected it.

---

**Generic syntax — a multi-line string**

```yaml
      description: >
        This text continues
        across several lines.
```

The `>` folds the following indented lines into one string, joining them with spaces. It is how you
write a long explanation without one enormous line.

---

**Why this change counts as significant**

The plan (line 1423) declares a contract freeze:

> **★ Joint, 16:00–18:00 — CONTRACT FREEZE.** ... **Changes after this require a 5-minute conversation and a joint commit.**

**Why the freeze exists.** Two developers work in parallel — one on the API, one on the UI, against
mocks. That only works if both build against the same agreed description. Silent changes mean the
frontend discovers the mismatch at integration time, when there is no schedule left to absorb it.

**Why this change was still made.** The access token lives in memory only, so a page reload loses
it. Restoring the session requires knowing *who* the user is, and the endpoint returned only a
token.

**And why it was the smaller of two options.** The alternative was a new `GET /auth/me` endpoint —
also a contract change, plus a second round trip on every boot. Adding the user here needed one
extra database read.

**The deciding evidence:** the Day 1 MSW mock *already* returned `{ user, accessToken }` from
refresh:

```js
  http.post('/api/v1/auth/refresh', () =>
    ok({ user: demoUser, accessToken: 'mock-refreshed-access-token' }),
  ),
```

The mock and the contract disagreed. The frontend had already been built against the shape the
contract did not promise, so this change made the contract match what was already assumed rather
than inventing something new.

**What reads this file:** developers today; Day 6 will feed the same schemas to `zod-to-openapi` and
serve Swagger UI at `/api/v1/docs` (plan line 1527).

---

## 4. The code explained from zero

This section takes the most important lines and explains them assuming no framework knowledge.

### 4.1 `app.use('/api/v1/auth', authRouter)`

This exact line lives in `backend/src/app.js`. Here is every part of it.

**What is `app`?**

```js
const app = express();
```

`express` is a library for building web servers. Calling `express()` creates an application object.
Think of `app` as a receptionist: requests arrive, and the receptionist decides what happens to
each one. On its own it knows nothing — you teach it by registering handlers.

**What is a request?**

When a browser asks for something, it sends a *request*: a method (`GET`, `POST`), a path
(`/api/v1/parties`), headers (extra information like `Authorization`), and sometimes a body (JSON
data). The server sends back a *response*: a status code (200 = fine, 401 = not logged in, 403 =
not allowed), headers, and usually a body.

**What does `.use()` mean?**

`.use()` registers a piece of code to run on incoming requests. Crucially, **order matters**.
Express keeps a list, and runs them top to bottom in the order you registered them. This session
had a bug caused exactly by getting that order wrong (section 7.1).

**What is middleware?**

Middleware is a function that sits between the request arriving and the response going out. It has
this shape:

```js
function something(req, res, next) {
  // do work
  next();
}
```

- `req` — the incoming request. You can read from it and attach things to it.
- `res` — the outgoing response. You use it to send data back.
- `next` — a function meaning "I am done, move to the next item in the list".

If middleware never calls `next()` and never sends a response, the request hangs forever. If it
calls `next(err)` with an argument, Express skips straight to the error handler.

A real one from `backend/src/app.js`:

```js
app.use((req, res, next) => {
  req.id = randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
});
```

This gives every request a unique ID, puts that ID in the response headers, and moves on. Later,
when an error occurs, that same ID appears in the error message and in the audit log, so you can
trace one request through the whole system.

**What does `/api/v1/auth` represent?**

A URL prefix. When the first argument to `.use()` is a string, the middleware only runs for
requests whose path starts with it. `/api` marks it as an API rather than a web page; `/v1` is a
version number, so a future `/v2` can change shape without breaking existing clients.

**What is `authRouter`?**

A router is a mini-application that groups related routes. From `backend/src/routes/auth.js`:

```js
const router = Router();

router.post('/register', async (req, res, next) => { ... });
router.post('/login', async (req, res, next) => { ... });
router.post('/refresh', async (req, res, next) => { ... });
router.post('/logout', async (req, res, next) => { ... });

export default router;
```

Notice the paths are `/register`, not `/api/v1/auth/register`. The router does not know or care
where it will be mounted. The prefix is added when `app.js` mounts it. This means the whole auth
module could move to a different URL by changing one line.

**Why use a router at all?** Without one, `app.js` would contain every route in the system — a
thousand-line file. Routers let each area of the app live in its own file.

**What happens when a request reaches that URL?**

Trace `POST /api/v1/auth/login` through `backend/src/app.js`:

1. The request-ID middleware runs — assigns `req.id`.
2. `auditLog` runs — registers a listener for when the response finishes, then calls `next()`.
3. `helmet()` runs — adds security headers.
4. `cors()` runs — adds cross-origin headers.
5. `express.json()` runs — sees `Content-Type: application/json`, reads the body, parses it, and
   puts the result on `req.body`. **Before this line, `req.body` does not exist.**
6. The `/healthz` route does not match, so it is skipped.
7. `app.use('/api/v1/auth', authRouter)` — the path matches, so Express hands the request to the
   router, stripping the prefix. The router sees `/login`.
8. The router's `/login` handler runs.

**Which file handles the request next?** `backend/src/routes/auth.js`, which validates the body and
then calls `loginUser` from `backend/src/lib/auth/login.js`.

---

### 4.2 Validation with Zod

From `backend/src/routes/auth.js`:

```js
const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
}).strict();

router.post('/register', async (req, res, next) => {
  try {
    const { email, password } = registerSchema.parse(req.body);
```

**What is Zod?** A library that describes the shape data must have, then checks real data against
that description.

**Line by line:**

- `z.object({...})` — "this must be an object with these fields".
- `z.string().email()` — "this field must be a string, and it must look like an email address".
- `z.string().min(8)` — "a string of at least 8 characters".
- `.strict()` — "reject any field I did not list".

**Why `.strict()` matters.** Without it, extra fields are silently ignored. Imagine someone posts:

```json
{ "email": "a@b.com", "password": "12345678", "isAdmin": true }
```

If the code later did `prisma.user.create({ data: req.body })`, that `isAdmin` would be written to
the database. This is called a *mass assignment* vulnerability. `.strict()` rejects the request
outright. There is a test for exactly this in `backend/src/routes/auth.test.js`.

**What is `.parse()`?** It checks the data. If valid, it returns it. If not, it **throws** an error.

**What is `const { email, password } = ...`?** Destructuring — shorthand for pulling named
properties out of an object into separate variables.

**Where does the thrown error go?** Into the `catch (err)` block, which calls `next(err)`, which
sends it to the error handler in `app.js`.

---

### 4.3 Why login runs a hash check even when the user does not exist

From `backend/src/lib/auth/login.js`:

```js
let dummyHashPromise;
function getDummyHash() {
  if (!dummyHashPromise) dummyHashPromise = hashPassword('not-a-real-password-000');
  return dummyHashPromise;
}

export async function loginUser(email, password) {
  const user = await prisma.user.findUnique({ where: { email } });
  const hashToCheck = user ? user.passwordHash : await getDummyHash();
  const valid = await verifyPassword(password, hashToCheck);

  if (!user || !valid) {
    const err = new Error('Invalid email or password');
    err.status = 401;
    err.code = 'invalid_credentials';
    throw err;
  }
```

The obvious way to write this would be:

```js
// NOT what we do — and here is why
const user = await prisma.user.findUnique({ where: { email } });
if (!user) throw new Error('Invalid email or password');  // returns instantly
const valid = await verifyPassword(password, user.passwordHash);  // takes ~50ms
```

That version has a flaw that has nothing to do with the message it returns. Argon2 is deliberately
slow — roughly 50 milliseconds. So:

- Unknown email → responds in about 2ms (no hashing happened).
- Known email, wrong password → responds in about 52ms.

An attacker with a list of a million emails can send one login attempt for each, measure the
response times, and learn which addresses are registered. This is a **timing attack**, and the
different messages were never the only leak.

Our version always runs one verification. If there is no user, it verifies against a throwaway hash
so the timing matches. `getDummyHash()` computes that hash once and reuses it, because computing it
on every failed login would be wasteful.

The `!user || !valid` check produces one identical error for both cases. There is a test asserting
both paths return the same `code` and same `message`.

---

### 4.4 The two-token system

**Why two tokens instead of one?** They have opposite requirements:

- Every API request needs a token, so checking it must be fast — no database query.
- Logging out must work immediately, which requires the server to remember something — a database
  query.

You cannot have both in one token, so we use two.

**The access token** — from `backend/src/lib/auth/tokens.js`:

```js
export function signAccessToken(userId) {
  return jwt.sign({ sub: userId, jti: randomUUID() }, process.env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: ACCESS_TOKEN_TTL,
  });
}
```

A **JWT** (JSON Web Token) is three chunks of text joined by dots: a header, some data, and a
signature. The data is *encoded, not encrypted* — anyone can read it. What they cannot do is change
it, because the signature is computed using `JWT_SECRET`, which only the server knows.

- `sub` — "subject", standard JWT terminology for who the token is about. We store the user ID.
- `jti` — "JWT ID", a unique ID for this specific token. Not used yet; it is the standard place to
  hang per-token revocation later.
- `expiresIn: '15m'` — after 15 minutes the token is rejected. This caps the damage if it is
  stolen.

**Crucially, there are no permissions in the token.** The plan (line 1099) is explicit about this:

> **no permissions in the token** (a revoked role must take effect immediately; look permissions up per request)

If permissions were in the token, firing someone would leave them with working access for up to 15
minutes. Test PERM-5 proves our version does not have that gap.

**Verifying it:**

```js
export function verifyAccessToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
}
```

The `algorithms: ['HS256']` is a security measure, not decoration. Without it, an attacker can send
a token claiming `"alg": "none"` and some libraries will accept it without checking the signature
at all. Pinning the algorithm closes that hole.

**The refresh token:**

```js
export function generateRefreshToken() {
  const raw = randomBytes(32).toString('base64url');
  return {
    raw,
    tokenHash: hashRefreshToken(raw),
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  };
}

export function hashRefreshToken(raw) {
  return createHash('sha256').update(raw).digest('hex');
}
```

`randomBytes(32)` produces 32 bytes of cryptographically secure randomness — 256 bits. Guessing it
is not feasible.

**Why SHA-256 here, but Argon2 for passwords?** Argon2 is slow on purpose, to make guessing
*low-entropy* secrets expensive. Human passwords have maybe 20–40 bits of real randomness, so
slowing each guess matters enormously. A refresh token already has 256 bits — brute force is
already impossible. Slowing it down would only make every refresh request slower for no security
gain. SHA-256 gives the property we actually need: if the database leaks, the attacker gets hashes,
not usable tokens.

---

### 4.5 Rotation and reuse detection

From `backend/src/lib/auth/refresh-tokens.js`. This is the 40 minutes of work the plan says
separates this project from tutorial auth.

**The problem.** Refresh tokens live 7 days. If one is stolen, the attacker has 7 days of access
and nobody notices.

**The solution.** Every time a refresh token is used, it is destroyed and replaced. Tokens are
grouped into a *family* — all descendants of one login share a `familyId`. If a token that was
already used shows up again, that is proof something is wrong: legitimate clients never reuse a
token, because they always have the newest one. So the whole family is revoked.

```js
export async function rotateRefreshToken(rawToken) {
  const tokenHash = hashRefreshToken(rawToken);
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });

  if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
    return { error: 'invalid' };
  }

  if (stored.usedAt) {
    await prisma.refreshToken.updateMany({
      where: { familyId: stored.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { error: 'reused' };
  }

  await prisma.refreshToken.update({
    where: { id: stored.id },
    data: { usedAt: new Date() },
  });

  const { raw, familyId } = await issueRefreshToken(stored.userId, stored.familyId);
  return { raw, familyId, userId: stored.userId };
}
```

**Walking through it:**

1. Hash the incoming token, because the database stores hashes, not raw tokens.
2. Look it up. If it does not exist, was revoked, or expired — reject.
3. **If `usedAt` is set, this token was already swapped.** Revoke every unrevoked token sharing its
   `familyId` and reject.
4. Otherwise mark it used.
5. Issue a new one *in the same family*.

**Why revoke the whole family and not just this token?** Consider the theft scenario:

```
Login          -> token A                    (family F)
Attacker steals A
Attacker uses A -> gets token B              (A now used, family F)
You use A       -> A is already used!
                -> revoke everything in F, including B
```

If only A were revoked, the attacker would still hold B and keep refreshing forever. Revoking the
family kills the attacker's access too. Both parties get logged out; you log back in, the attacker
cannot.

This is tested directly in `backend/src/routes/auth.test.js`:

```js
    // B was never used, but it shares A's family, so it dies with it. This is
    // the assertion that separates real reuse detection from just marking A used.
    const sibling = await request(app).post('/api/v1/auth/refresh').set('Cookie', tokenB);
    expect(sibling.status).toBe(401);
```

---

### 4.6 The cookie settings

From `backend/src/routes/auth.js`:

```js
const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  path: '/api/v1/auth',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};
```

A **cookie** is a small piece of data the server asks the browser to store and send back on future
requests. Each option here blocks a specific attack:

- **`httpOnly: true`** — JavaScript cannot read this cookie. If an attacker injects a script into
  your page (an XSS attack), it cannot steal the refresh token. This is the single most important
  option here, and it is why the access token is deliberately kept in a JavaScript variable
  instead of a cookie: the two tokens have different threat models.
- **`sameSite: 'strict'`** — the browser only sends this cookie when the request comes from your
  own site. This blocks CSRF, where a malicious site tries to make your browser perform actions
  using your cookies.
- **`path: '/api/v1/auth'`** — the browser only sends it to auth endpoints. Every other API call
  does not carry it, shrinking exposure.
- **`secure`** — only send over HTTPS. Gated on production because local development uses plain
  HTTP, where a `Secure` cookie would simply be dropped.
- **`maxAge`** — 7 days in milliseconds.

**Reading cookies back.** Express can write cookies but not read them. Rather than add a
dependency, `backend/src/routes/auth.js` parses the header directly:

```js
function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return undefined;
  const match = header.split('; ').find((entry) => entry.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : undefined;
}
```

The browser sends all cookies in one header like `a=1; b=2; refreshToken=xyz`. This splits on
`"; "`, finds the entry starting with the name, and returns what follows the `=`.

---

### 4.7 AsyncLocalStorage — the hardest concept in this session

**The problem.** The database layer needs to know the current organization ID. But a database query
might happen deep inside a chain of function calls:

```
route handler -> service function -> helper -> prisma.party.findMany()
```

The obvious solution is to pass `organizationId` down through every function. But that means every
function signature grows an extra parameter, and — much worse — **any function that forgets to
pass it creates a security hole**. That is exactly the class of bug we are trying to eliminate.

**The solution.** `AsyncLocalStorage` is built into Node. It stores a value that is visible to all
code running within a particular asynchronous call chain, without being passed as a parameter.

Think of it as a labelled room. `run(value, callback)` puts the value in the room and calls the
callback inside it. Any code the callback triggers — however deep, and even across `await` — can
call `getStore()` to see the value. Two requests handled at the same time each get their own room.

`backend/src/lib/request-context.js` creates one:

```js
import { AsyncLocalStorage } from 'node:async_hooks';

export const requestContext = new AsyncLocalStorage();
```

`backend/src/middleware/resolve-tenant.js` fills it:

```js
    requestContext.run({ organizationId }, next);
```

This says: "put `{ organizationId }` in the room, and run the rest of the request inside it."

`backend/src/db/tenant-extension.js` reads it:

```js
          const organizationId = requestContext.getStore()?.organizationId;
```

**What is `?.`** — optional chaining. `getStore()` returns `undefined` when there is no active
context, and `.organizationId` on `undefined` would crash. `?.` makes the whole expression evaluate
to `undefined` instead. This matters: it is exactly what happens during login, where there is no
organization yet.

---

### 4.8 The Prisma tenant extension

From `backend/src/db/tenant-extension.js`. The plan calls building this "the highest-leverage hour
of the week".

```js
export function withTenantScope(client) {
  return client.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const organizationId = requestContext.getStore()?.organizationId;
          if (!organizationId || !TENANT_SCOPED_MODELS.has(model)) {
            return query(args);
          }

          if (SINGLE_RECORD_READS.includes(operation) || MULTI_RECORD_READS.includes(operation)) {
            args.where = { ...args.where, organizationId };
          }

          if (operation === 'create') {
            args.data = { ...args.data, organizationId };
          }

          return query(args);
        },
      },
    },
  });
}
```

**What is Prisma?** An ORM — Object Relational Mapper. Instead of writing SQL strings, you write
JavaScript like `prisma.party.findMany()` and Prisma generates the SQL.

**What is `$extends`?** A Prisma feature that wraps the client with extra behaviour. `$allModels`
and `$allOperations` mean "intercept every operation on every model".

**The four arguments:**

- `model` — the model name, e.g. `'Party'`.
- `operation` — what is being done, e.g. `'findMany'`.
- `args` — the arguments that were passed, e.g. `{ where: { code: 'CUS-001' } }`.
- `query` — a function that actually performs the query. Nothing happens until you call it.

**What the code does.** If there is no organization context, or the model is not tenant-scoped, run
the query unchanged. Otherwise, for reads and updates add `organizationId` to `where`; for creates
add it to `data`. Then run it.

**What `{ ...args.where, organizationId }` means.** The `...` is spread syntax: copy every property
from `args.where` into a new object, then add `organizationId`. So:

```js
{ code: 'CUS-001' }  becomes  { code: 'CUS-001', organizationId: 'abc-123' }
```

**A concrete example.** In `backend/src/routes/masters.js` the handler writes:

```js
    const accounts = await prisma.account.findMany({
      where: type ? { type } : {},
      orderBy: { code: 'asc' },
    });
```

There is no mention of organization anywhere. The SQL that actually runs is roughly:

```sql
SELECT * FROM "Account" WHERE "organizationId" = 'abc-123' ORDER BY code ASC
```

**Why this is better than remembering to filter.** With manual filtering, security depends on 100%
of developers getting it right 100% of the time forever. Here, forgetting is impossible — the
filter is added by the infrastructure.

**The 404-instead-of-403 property.** The plan (line 1109) requires that requesting another tenant's
record by ID returns 404, not 403, because a 403 confirms that the ID exists — an enumeration
oracle. This falls out for free: `findUnique({ where: { id } })` becomes
`findUnique({ where: { id, organizationId } })`, which returns `null` for another tenant's record.
The route sees "not found" and returns 404 without any special-case code.

**The known limitation.** Only models in `TENANT_SCOPED_MODELS` are protected, because only they
have an `organizationId` column. `JournalLine` and `AccountingPeriod` do not. This is why
`/periods` in `masters.js` filters manually through the parent:

```js
      where: {
        fiscalYear: { organizationId: req.organizationId },
        ...(fiscalYearId ? { fiscalYearId } : {}),
      },
```

Day 3's posting engine must do the same for `JournalLine`.

---

### 4.9 Why the audit log waits for the response

From `backend/src/middleware/audit-log.js`:

```js
export function auditLog(req, res, next) {
  res.on('finish', () => {
    if (!req.auditEntry) return;
    if (res.statusCode < 200 || res.statusCode >= 300) return;

    writeAuditLog({ ... }).catch((err) => {
      console.error(`[${req.id}] audit log write failed`, err);
    });
  });
  next();
}
```

**What is `res.on('finish', ...)`?** Registering a listener. `res` can emit events; `'finish'` fires
once the response has been fully sent. So the callback runs *after* the user already has their
answer.

**Three deliberate decisions:**

**It runs after the response is sent.** The user does not wait for the audit write.

**It only logs on 2xx status codes.** A failed request did not change anything, so logging it as if
it had would make the audit trail lie.

**Failures are caught and only logged.** If the audit write fails, an invoice that was already
created successfully must not retroactively appear to fail. This is correct — but it is also
exactly what hid a real bug in this session (section 7.3).

**How routes use it.** From `backend/src/routes/masters.js`:

```js
    req.auditEntry = {
      action: 'account.create',
      entityType: 'Account',
      entityId: account.id,
      before: null,
      after: serializeAccount(account),
    };

    res.status(201).json(serializeAccount(account));
```

The route attaches data to `req`, then responds. The middleware picks it up afterwards. `before` is
`null` because this is a creation — there was no previous state.

---

### 4.10 Transactions

From `backend/src/routes/orgs.js`:

```js
    // Org + first membership must land together: an org with no owner is
    // unreachable, since every other route requires an active membership.
    const org = await prisma.$transaction(async (tx) => {
      const created = await tx.organization.create({ data: { name } });
      await tx.membership.create({
        data: { userId: req.userId, organizationId: created.id, roleId: ownerRole.id },
      });
      return created;
    });
```

**What is a transaction?** A group of database operations that either all succeed or all fail.
There is no in-between.

**Why it is needed here.** Creating an organization requires two inserts: the organization, and the
membership making the creator its Owner. If the first succeeded and the second failed, you would
have an organization nobody can access — every other route requires an active membership. It would
be permanently stranded in the database.

**What is `tx`?** Inside the transaction you must use `tx` instead of `prisma`. `tx` is a special
client bound to this transaction. Using `prisma` inside would run outside the transaction and would
not be rolled back on failure.

---

### 4.11 The frontend silent refresh

From `frontend/src/auth/AuthContext.jsx`:

```jsx
  const restoreStarted = useRef(false);

  useEffect(() => {
    if (restoreStarted.current) return;
    restoreStarted.current = true;

    apiRequest('/auth/refresh', { method: 'POST', retryAuth: false })
      .then((session) => { ... setStatus('authenticated'); })
      .catch(() => { setStatus('unauthenticated'); });
  }, []);
```

**What is `useEffect`?** A React hook that runs code after the component appears on screen. The
empty array `[]` at the end means "run this once when the component first mounts".

**What is `useRef`?** A container holding a value that survives re-renders but does not itself
cause a re-render when changed. Here it is a flag.

**Why the flag is not optional.** React's StrictMode — enabled in `frontend/src/main.jsx` —
deliberately runs effects **twice** in development to surface bugs. Without the guard, the app
would call `/auth/refresh` twice with the same cookie on every boot. The second call would present
an already-used token, which is precisely the reuse signal, and the backend would revoke the whole
family and log the user out.

This is a case where two correct systems — StrictMode's double-invocation and reuse detection —
interact badly. The plan predicted it (line 1907):

> Refresh rotation + reuse detection + silent refresh interacts badly with React StrictMode double-effects and concurrent 401s.

There is a second layer of protection already in `frontend/src/lib/api-client.js` (built on Day 1):

```js
async function refreshAccessToken() {
  if (!refreshPromise) {
    refreshPromise = fetch(apiUrl('/auth/refresh'), { ... })
      .finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}
```

If several requests get a 401 simultaneously, only the first starts a refresh; the rest wait on the
same promise. This is the "one request-deduplicating refresh promise" the plan prescribes.

---

## 5. The complete request flow

### 5.1 The actual architecture

The plan's diagram (line 232) describes the intended pipeline. Here is what the code in this
repository actually does:

```
Browser
   |  fetch() with Authorization + X-Organization-Id headers
   v
Vite dev server (port 5173)   -- proxy, so the browser sees one origin
   |
   v
Express app  (backend/src/app.js)
   |
   |-- requestId middleware      -> assigns req.id
   |-- auditLog middleware       -> registers a 'finish' listener
   |-- helmet()                  -> security headers
   |-- cors()                    -> cross-origin headers
   |-- express.json()            -> parses body into req.body
   |
   v
Router  (routes/auth.js | routes/orgs.js | routes/masters.js)
   |
   |-- authenticate     -> verifies JWT, sets req.userId
   |-- resolveTenant    -> verifies membership, sets req.organizationId + req.roleId,
   |                       enters AsyncLocalStorage context
   |-- authorize(code)  -> checks the role has the permission
   |
   v
Route handler
   |-- Zod .parse() validates req.body
   |-- calls a service (lib/auth/*.js) or Prisma directly
   |
   v
Prisma client  (db/client.js, wrapped by db/tenant-extension.js)
   |-- extension reads AsyncLocalStorage
   |-- injects organizationId into where/data
   |
   v
PostgreSQL
   |
   v
Response travels back; res.on('finish') fires; audit row is written
```

Note this differs from a textbook layered architecture. There is no separate "controller" layer —
route handlers *are* the controllers. And services exist only for auth; the masters routes call
Prisma directly, because wrapping a four-line query in a service function would add a file without
adding meaning.

### 5.2 Following one real request end to end

`GET /api/v1/parties` — "show me this organization's customers".

**Step 1 — The browser sends:**

```
GET /api/v1/parties HTTP/1.1
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
X-Organization-Id: f000a3d8-3cad-45be-8662-d055dc2e4dba
```

**Step 2 — `backend/src/app.js`, request ID.** `req.id` is set to a fresh UUID, and the same value
goes out as the `X-Request-Id` response header.

**Step 3 — audit middleware.** Registers a `'finish'` listener and calls `next()`. Nothing is
written yet.

**Step 4 — helmet, cors, json.** Security headers added. `express.json()` sees no body on a GET and
moves on.

**Step 5 — routing.** `/api/v1/auth` does not match. `/api/v1/orgs` does not match. `/api/v1`
matches, so `mastersRouter` receives the request with path `/parties`.

**Step 6 — `backend/src/routes/masters.js`, `router.use(authenticate, resolveTenant)`.** Both run
for every route in this file.

**Step 7 — `authenticate`.** Reads the `Authorization` header, strips `'Bearer '`, calls
`verifyAccessToken`. If the signature is valid and the token has not expired, `req.userId` is set
from the `sub` claim. Otherwise 401.

**Step 8 — `resolveTenant`.** Reads `X-Organization-Id`, validates it is a UUID, then:

```js
    const membership = await prisma.membership.findFirst({
      where: { userId: req.userId, organizationId, isActive: true },
    });
```

This is the security-critical query: does *this user* have an active membership in *this
organization*? If not, 403.

Notice this query runs *before* `requestContext.run()`. There is no organization context yet, so
the tenant extension leaves it alone. That is necessary — you cannot tenant-filter the query that
decides which tenant you are allowed into.

On success it sets `req.organizationId` and `req.roleId`, then enters the context:

```js
    requestContext.run({ organizationId }, next);
```

**Step 9 — `authorize('report.view')`.** Queries `RolePermission` joined to `Permission` for this
role and this permission code. Missing → 403.

**Step 10 — the route handler.**

```js
    const { search, page } = listPartiesSchema.parse(req.query);
    const parties = await prisma.party.findMany({
      where: search ? { name: { contains: search, mode: 'insensitive' } } : {},
      orderBy: { code: 'asc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    });
```

No organization filter is written here.

**Step 11 — the tenant extension.** Intercepts. Model is `Party`, which is tenant-scoped. Operation
is `findMany`. Reads `organizationId` from the context and merges it into `where`.

**Step 12 — PostgreSQL** runs approximately:

```sql
SELECT * FROM "Party"
WHERE "organizationId" = 'f000a3d8-...'
ORDER BY code ASC LIMIT 20 OFFSET 0
```

**Step 13 — serialization.** The handler maps rows through `serializeParty`, which converts the
database's uppercase `CUSTOMER` to the contract's lowercase `customer` and omits internal fields.

**Step 14 — response sent.** `res.on('finish')` fires. `req.auditEntry` is undefined (reads are not
audited), so nothing is written.

### 5.3 What happens when it fails

The same request with a token belonging to a user who is *not* a member:

Steps 1–7 are identical — the token is perfectly valid, so `authenticate` passes. Step 8 finds no
membership and calls `next(err)` with `status = 403`.

Calling `next()` **with an argument** makes Express skip every remaining normal middleware and jump
straight to the error handler in `app.js`:

```js
app.use((err, req, res, _next) => {
  console.error(`[${req.id}]`, err);

  if (err instanceof ZodError) {
    return res.status(400).json({ ... });
  }

  res.status(err.status || 500).json({
  error: {
      code: err.code || 'INTERNAL_ERROR',
      message: err.message || 'Something went wrong',
      requestId: req.id,
    },
  });
});
```

An error handler is recognised by having **four** parameters instead of three. This is why the
unused fourth parameter is named `_next` rather than deleted — removing it would silently turn this
into ordinary middleware and errors would stop being handled.

The response:

```json
{
  "error": {
    "code": "forbidden",
    "message": "Not a member of this organization",
    "requestId": "2a1522e2-9e6e-46d9-9590-24ec9fc93d3d"
  }
}
```

The database was never queried for parties. The request was stopped at the gate.

---

## 6. New concepts introduced

### Middleware

**What is it?** A function that runs between a request arriving and a response leaving.

**Why do we need it?** Many routes need the same checks. Middleware lets you write each check once.

**How does it work?** Express keeps an ordered list. Each middleware receives `(req, res, next)` and
either responds, or calls `next()` to continue, or calls `next(err)` to jump to the error handler.

**How did we use it?** `authenticate`, `resolveTenant`, `authorize`, and `auditLog`. The order is
the design: identity, then tenancy, then permission.

---

### Password hashing

**What is it?** A one-way transformation of a password into a scrambled string.

**Why do we need it?** So a database leak does not expose passwords.

**How does it work?** Argon2id is deliberately slow and memory-hungry (19MB per hash here), which
makes mass guessing impractical. It also adds a random *salt* to each hash, so two identical
passwords produce different hashes and precomputed lookup tables are useless. The output embeds the
algorithm, the settings, and the salt — which is why `verify()` needs only the hash and the
candidate password.

**How did we use it?** `backend/src/lib/auth/password.js`, called by register, login, and the seed.

---

### JWT

**What is it?** A signed token carrying data that anyone can read but nobody can forge.

**Why do we need it?** So the server can verify identity without a database lookup on every request.

**How does it work?** Header, payload, and signature joined by dots. The signature is computed from
the first two parts plus a secret key. Change any character and the signature no longer matches.

**How did we use it?** 15-minute access tokens containing `sub` and `jti`, and deliberately no
permissions.

---

### Refresh token rotation with reuse detection

**What is it?** Replacing the refresh token on every use, and treating the reappearance of an old
one as evidence of theft.

**Why do we need it?** A long-lived token that never changes is a permanent key if stolen.

**How does it work?** Tokens share a `familyId`. Using one marks it `usedAt` and issues a successor.
A used token presented again triggers revocation of the entire family.

**How did we use it?** `backend/src/lib/auth/refresh-tokens.js`, with a test proving the never-used
sibling dies too.

---

### Multi-tenancy

**What is it?** One application and one database serving many independent customers.

**Why do we need it?** Running a separate database per company does not scale operationally.

**How does it work?** Every tenant-owned table has an `organizationId` column, and every query
filters on it.

**How did we use it?** Three layers: a verified membership check in `resolveTenant`, automatic
filter injection in the tenant extension, and 404-not-403 behaviour falling out of the injection.

---

### AsyncLocalStorage

**What is it?** A Node feature for storing data visible to everything in one asynchronous call
chain.

**Why do we need it?** To get the organization ID to the database layer without threading it
through every function signature.

**How does it work?** `run(value, callback)` establishes a context; `getStore()` retrieves it from
anywhere inside, including across `await`. Concurrent requests each get their own.

**How did we use it?** `backend/src/lib/request-context.js`, filled by `resolveTenant`, read by the
tenant extension.

---

### ORM and Prisma client extensions

**What is it?** An ORM maps database rows to objects. An extension wraps the client to add
behaviour.

**Why do we need it?** The extension is what turns "remember to filter by organization" from a
human responsibility into a structural guarantee.

**How does it work?** `$extends` with `$allModels` / `$allOperations` intercepts every query,
inspects `model` and `operation`, mutates `args`, then calls `query(args)`.

**How did we use it?** `backend/src/db/tenant-extension.js`, applied once in `db/client.js`.

---

### Database transactions

**What is it?** A group of operations that all succeed or all fail.

**Why do we need it?** Partial writes leave the database in an impossible state.

**How does it work?** `prisma.$transaction(async (tx) => { ... })`. Operations use `tx`. If the
callback throws, everything rolls back.

**How did we use it?** Creating an organization with its first membership.

---

### Idempotency

**What is it?** The property that doing something twice has the same effect as doing it once.

**Why do we need it?** Networks retry. Users double-click. A payment must not be created twice.

**How does it work?** The client sends a unique `Idempotency-Key`. The server records it *inside
the same transaction as the write*. A duplicate key replays the stored response.

**Why Postgres and not Redis?** From the plan (line 544): because the key is written in the same
transaction as the financial record, a rollback undoes both. With Redis you have two systems that
can disagree about whether a payment happened — exactly the failure you were preventing.

**How did we use it?** `backend/src/lib/idempotency/run-idempotent.js`. Built, not yet called.

---

### Integration testing with supertest

**What is it?** Sending real HTTP requests to your app in a test, without starting a server.

**Why do we need it?** Unit-testing `authorize()` in isolation would not prove the middleware chain
is wired correctly. Most real bugs live in the wiring.

**How does it work?** `request(app).get('/api/v1/parties').set(headers)` runs the entire Express
pipeline against a real database.

**How did we use it?** All three backend test files. This is why `app.js` was split from
`index.js`.

---

### Mutation testing

**What is it?** Deliberately breaking your code to confirm your tests notice.

**Why do we need it?** A passing test proves nothing until you have seen it fail. A test that
passes whether or not the feature works is worse than no test, because it creates false confidence.

**How did we use it?** After the isolation tests passed, the tenant extension was temporarily
disabled by replacing the context lookup with `null`. ISO-1 and ISO-3 failed immediately:

```
FAIL  ISO-1: a list endpoint returns only the active org's rows
  - []
  + [Alice Customer, Bob Customer]
FAIL  ISO-3: a create lands in the caller's org even if the body says otherwise
```

Then the change was reverted and the suite went green again. Now we know those tests bite.

---

## 7. Errors and debugging

### 7.1 Middleware order — `req.body` was undefined

**What happened.** The auth router was mounted at the very top of `app.js`, above `express.json()`.
Requests to `/auth/register` returned a 500 whose message was a JSON parse error.

**Why it happened.** Express runs middleware in registration order. `express.json()` is what reads
the request body and puts it on `req.body`. Registering the router *before* it meant the handler
ran while `req.body` was still `undefined`. `registerSchema.parse(undefined)` then threw.

The same mistake also skipped `helmet()`, `cors()`, and the request-ID middleware for those routes —
so those requests had no `req.id` either, and the error handler reported `requestId: undefined`.

**How we found it.** Reading `app.js` top to bottom and noticing the mount sat above the parsers.

**What we changed.** Moved `app.use('/api/v1/auth', authRouter)` below the middleware stack.

**Why the fix works.** By the time the router runs, `express.json()` has already populated
`req.body`.

**The lesson.** In Express, position in the file *is* behaviour. Middleware order is not style.

---

### 7.2 The stale server — 39 minutes of phantom 404s

**What happened.** `POST /api/v1/auth/register` kept returning `Cannot POST /api/v1/auth/register`
even though the route existed and the file was correct. Meanwhile `/healthz` worked fine.

**Why it happened.** Every `npm run dev` after adding the router had crashed at import time with
`ERR_MODULE_NOT_FOUND` — first because `tokens.js` did not exist yet, then because `jsonwebtoken`
was not installed. A crash during import happens *before* `app.listen()`, so those processes never
took the port. An older Node process, started before the auth router existed, was still holding
port 3000 and answering every request.

That old process knew `/healthz` (it existed at startup) but not `/auth/register`. Hence: health
checks pass, new routes 404, and re-reading the source proves nothing.

**How we found it.** Checking what actually held the port:

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen | ForEach-Object { Get-Process -Id $_.OwningProcess }
```

It showed a process with `StartTime` 39 minutes earlier — well before the router was written.

**What we changed.** Killed the stale process and started a clean one.

**Why the fix works.** The new process actually contained the new routes.

**The lesson.** When the code is provably correct but behaviour disagrees, question whether the
code you are reading is the code that is running. `Cannot POST` is Express's own 404 — it means the
running app has no such route, which is different from the route erroring.

---

### 7.3 The audit log that silently dropped entries

**What happened.** Querying the audit table showed `party.create` and `account.create` rows, but no
`org.create` rows — even though organization creation was working and setting `req.auditEntry`.

**Why it happened.** A chain of three correct decisions producing one wrong outcome:

1. `AuditLog.organizationId` is `NOT NULL` in the schema.
2. `POST /orgs` runs *without* tenant context — there is no organization yet, which is the whole
   point of that route. So the tenant extension had nothing to inject.
3. The insert therefore failed. And `middleware/audit-log.js` deliberately catches audit failures
   so they cannot break a successful business operation — so the failure was logged to the console
   and swallowed.

Every individual decision was right. Together they made a silent hole.

**How we found it.** Not from an error — there was none visible in the API. We queried the audit
table directly after running the endpoint tests and noticed which action types were missing.

**What we changed.** Allowed an audit entry to carry an explicit `organizationId`:

```js
// organizationId is normally injected by the tenant extension from request
// context. Routes that run before tenancy exists (org creation) must pass it
// explicitly, since the column is NOT NULL.
export async function writeAuditLog({ organizationId, userId, action, ... }) {
```

and in `backend/src/routes/orgs.js`:

```js
    req.auditEntry = {
      // No tenant context on this route yet — the extension has nothing to inject.
      organizationId: org.id,
      action: 'org.create',
      ...
    };
```

**Why the fix works.** The extension only *overrides* `organizationId` when a context exists. With
no context it leaves the explicit value alone, so the insert satisfies the NOT NULL constraint.

**The lesson.** Error handling that protects one thing can hide another. When you deliberately
swallow failures, you need a way to check that the swallowed path is healthy — here, querying the
table directly.

---

### 7.4 Validation errors returned 500 instead of 400

**What happened.** Posting an unknown field returned HTTP 500 `INTERNAL_ERROR` with a raw Zod dump
as the message.

**Why it happened.** The error handler treated any error without a `status` property as a server
fault. Zod errors have no `status`, so they defaulted to 500. But a bad request body is the
*client's* mistake, not the server's — 4xx, not 5xx. Returning 500 also leaks internal validation
structure.

**How we found it.** Testing `.strict()` behaviour. The rejection worked; the status code was
wrong.

**What we changed.** Added a Zod branch to the error handler in `backend/src/app.js`:

```js
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: 'validation_error',
        message: 'Request validation failed',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        requestId: req.id,
      },
    });
  }
```

**Why the fix works.** `instanceof ZodError` catches every validation failure anywhere in the app
and converts it to a clean 400 with a structured `details` array the frontend can display per
field.

---

### 7.5 Tests wiped each other's data

**What happened.** Three test files each truncate the database in `beforeAll`. Vitest runs test
files in parallel by default.

**Why it would fail.** While `isolation.test.js` was mid-run, `permissions.test.js` could start and
truncate the tables out from under it. Failures would be random and unreproducible.

**How we found it.** Anticipated it while writing the second suite, from the existing pattern in
`backend/src/db/triggers.test.js`.

**What we changed.** Created `backend/vitest.config.js` with `fileParallelism: false`, plus
generous timeouts because Argon2 is intentionally slow.

**The trade-off worth knowing.** The suites share one real database instead of isolating each file.
That is a deliberate choice: real Postgres catches constraint and trigger bugs that an in-memory
fake never would. The cost is that `npm test` **truncates your development database** — you must
re-run `npm run seed` afterwards.

---

### 7.6 The frontend mock made every test start logged in

**What happened.** After adding boot-time silent refresh, two frontend tests failed. One could not
find the "Welcome back" login heading.

**Why it happened.** The mock `/auth/refresh` handler unconditionally returned success. Once the
app started calling refresh on boot, the mock reported "yes, you have a valid session" for a
browser that had never logged in. So `ProtectedRoute` rendered the dashboard instead of redirecting
to login.

The mock was wrong, not the app. A real browser with no cookie gets a 401.

**How we found it.** The test failure named the missing heading, and the cause was traced back to
what boot now does that it did not do before.

**What we changed.** Gave the mock a session flag, since MSW cannot observe an httpOnly cookie:

```js
// Stands in for the httpOnly refresh cookie the mock layer cannot observe.
export const mockSession = { active: false };
```

Login and register set it; logout clears it; refresh checks it. Tests reset it in `beforeEach`.

**Why the fix works.** The mock now models the real state machine, so tests exercise the same paths
a browser would.

**Bonus.** This made two genuinely valuable tests possible:

```jsx
  it('restores an existing session on boot instead of redirecting to login', async () => {
  it('sends an unauthenticated visitor to login when no session exists', async () => {
```

---

### 7.7 The second failure — a field that no longer existed

**What happened.** A registration test failed with `Unable to find a label with the text of: Full
name`.

**Why it happened.** We removed that field. Neither the `User` model in `schema.prisma` nor the
`User` schema in `docs/openapi.yaml` has a `name`, and `/auth/register` uses `.strict()`, so
sending one would have been rejected with a 400. The field existed only because the Day 1 MSW mock
invented it.

**What we changed.** Removed the field from the form, its validation, and the test; changed
`AppShell.jsx` to display the email instead.

**The lesson.** Mocks drift from contracts. The moment you connect to a real API, the drift surfaces
as failures. That is the mock doing its final useful job.

---

### 7.8 The contract change

Not a bug, but the one decision in this session that changed a frozen agreement.

**The situation.** The access token lives in memory only, so a page reload loses it. To restore the
session, the app calls `/auth/refresh` on boot. But the contract said that endpoint returns only
`accessToken` — so the app would hold a valid session with no idea who the user is.

**The discovery.** The Day 1 MSW mock at `frontend/src/mocks/handlers.js` *already* returned
`{ user, accessToken }` from refresh. The mock and `openapi.yaml` disagreed. Developer B had been
building against a shape the contract did not promise.

**The options.** Add a separate `GET /auth/me` endpoint (two round trips on boot), or return the
user from refresh (one round trip, and matches what the frontend already assumed).

**The decision.** Return the user from refresh, and update `docs/openapi.yaml` to match:

```yaml
      description: >
        Reads the httpOnly refresh cookie; no request body. Returns the user
        alongside the token so a page reload can restore the session in a single
        round trip — the access token is held in memory only and is lost on reload.
```

The plan (line 1423) says contract changes require a five-minute conversation and a joint commit.
This one is documented here rather than made quietly.

---

## 8. Final understanding check

You should now be able to answer these without looking at the code. If any answer does not come,
that section is worth re-reading.

### On what we built

1. What are the four authentication endpoints, and what does each one do?
2. Why are there two different kinds of tokens instead of one? What job does each do that the other
   cannot?
3. Why is the access token 15 minutes and the refresh token 7 days?
4. What does "multi-tenant" mean here, and which two organizations does the seed create?

### On security reasoning

5. Why is the password hashed with Argon2 but the refresh token hashed with SHA-256? Why not use
   the same for both?
6. Why does `loginUser` verify against a dummy hash when the email does not exist? What attack does
   that prevent, and why is returning the same error message not enough on its own?
7. Why are permissions looked up from the database on every request instead of being stored inside
   the JWT? Which test proves this matters?
8. Why does the refresh cookie have `httpOnly: true` while the access token is deliberately kept in
   a JavaScript variable?
9. What is refresh token reuse detection? Walk through the theft scenario and explain why the
   *entire family* is revoked rather than just the reused token.
10. Why does a cross-tenant record request return 404 rather than 403?

### On architecture

11. What is middleware? Why does the order of `app.use()` calls matter, and what broke when we got
    it wrong?
12. What does `resolveTenant` verify, and why is checking the `X-Organization-Id` header alone not
    enough?
13. What is `AsyncLocalStorage`, and what problem would we have without it? What would the
    alternative look like, and why is it worse?
14. How does the Prisma tenant extension work? Trace what happens to
    `prisma.party.findMany({ where: {} })` from the route handler to the SQL.
15. Which two models does the tenant extension *not* protect, and why? What must Day 3 do about it?
16. Why was `app.js` split from `index.js`?
17. Why is the audit log written in `res.on('finish')` rather than before the response is sent?
18. Why must creating an organization and its first membership happen in a transaction? What breaks
    if only the first succeeds?

### On the request lifecycle

19. Trace `GET /api/v1/parties` from browser to database and back. Name every middleware it passes
    through and what each one does.
20. What happens differently when the user is not a member of the requested organization? Where
    exactly does the request stop?
21. How does Express know which function is the error handler?

### On debugging

22. Why did `/healthz` work while `/auth/register` returned 404 for 39 minutes? What was the actual
    cause, and how would you diagnose it faster next time?
23. Why did `org.create` audit entries silently disappear? Explain how three individually correct
    decisions combined into one bug.
24. What is mutation testing, and what did it prove about the isolation tests?
25. Why does `npm test` in the backend require re-running `npm run seed` afterwards?

### On the plan

26. Which Day 2 objectives are complete, and which items are deliberately deferred to Day 6?
27. What one contract change was made, why, and what was the alternative?

---

## Quick reference

**Run the backend**
```
cd backend
npm run dev
```

**Run the frontend** (backend must be running — the proxy targets port 3000)
```
cd frontend
npm run dev
```

**Run tests** (this truncates the database)
```
cd backend
npm test
npm run seed     # restore demo data afterwards
```

**Demo accounts** — all use password `Demo@2026`

| Email | Role | Organization |
|---|---|---|
| `sunita@annapurnatrading.com.np` | Owner | Both orgs — use this to demo the switcher |
| `rajan@annapurnatrading.com.np` | Accountant | Annapurna Trading |
| `bimala@annapurnatrading.com.np` | Clerk | Annapurna Trading |
| `auditor@external.com.np` | Viewer | Sherpa Ventures only |

**Permission map** (from `backend/prisma/seed.js`)

| Role | Permissions |
|---|---|
| Owner | all eight |
| Accountant | everything except `org.manage` |
| Clerk | `invoice.create`, `payment.create`, `report.view` |
| Viewer | `report.view` |
