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

---

**File:** `docs/openapi.yaml`

**Status:** Modified

**Purpose:** The API contract — the agreed description of every endpoint.

**Why the change?** `/auth/refresh` now returns the user object as well as the token. This is the
one contract change made in this session, and it is explained fully in section 7.

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
