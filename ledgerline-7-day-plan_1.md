# Ledgerline — 7-Day Portfolio Build Plan

**Two developers · Seven days · One end-to-end fintech workflow**

Stack: React + Vite + Tailwind · Node + Express + JavaScript (ESM) · PostgreSQL + Prisma · Redis (rate limiting, optional BullMQ) · Zod · Vitest + Supertest · OpenAPI · Docker Compose

Source document: `tigg-clone-implementation-plan.md` (a 4–6 month full-ERP architecture). This plan implements roughly 6% of it — the 6% that carries all the engineering signal.

---

## 1. Project concept

### Name

**Ledgerline**

Alternates if the domain is gone: **Kosh Ledger**, **Trueline Books**.

The name points at the thing that matters: a *line* in a *ledger*. Every screen in this product is ultimately a view over `journal_lines`. That is the whole thesis.

### One-line description

> Ledgerline is a multi-tenant, double-entry accounting API and dashboard where every financial document — invoice, payment, credit note, bank charge — is posted to an immutable general ledger, and every report is derived from that ledger rather than stored alongside it.

### What the product does

A small business or an external accountant signs in, picks an organisation, and:

1. Creates customers and issues VAT invoices.
2. Posts those invoices, which generates a balanced journal entry.
3. Records customer receipts and allocates them across one or many open invoices.
4. Uploads a bank statement CSV.
5. Watches the matching engine pair statement lines against ledger movements, resolves the leftovers by hand, and closes the reconciliation with a zero difference.
6. Runs Trial Balance, General Ledger, P&L, Balance Sheet and AR Aging — all computed live from journal lines.
7. Inspects an append-only audit trail showing who posted what, when, from which IP, with before/after state.

Nothing is ever deleted. Mistakes are corrected by reversal or credit note.

### Target user

Small and mid-sized Nepali trading and service businesses (NPR, 13% VAT, Bikram Sambat fiscal years like 2082/83) and the freelance accountants who serve several of them at once. That last detail is why `users` live outside tenants and `memberships` join them in — a real accountant is one human with four clients.

### The fintech problem it solves

Most small-business "accounting" software in this segment is a CRUD invoicing app with a totals column bolted on. The invoice table stores `amount_paid`. A report reads that column. When someone edits a paid invoice, the report silently lies, and nobody finds out until an audit.

Ledgerline inverts that: **documents are inputs, the ledger is the truth, reports are pure functions of the ledger.** An invoice that has been posted cannot be edited — the database physically refuses. If you want it changed, you issue a credit note, and both documents survive in the record. That is how real accounting systems work, and it is the single hardest thing to retrofit later.

### Why it is technically impressive

- **The database enforces accounting, not the application.** A deferred constraint trigger rejects any journal entry where debits ≠ credits. A `BEFORE UPDATE` trigger rejects any change to a posted entry. You cannot write a bug that breaks these invariants from application code, because application code is not what enforces them.
- **The subledger and the general ledger are proved equal by test.** `SUM(invoice.outstanding)` must equal the Accounts Receivable control account balance after any arbitrary sequence of invoices, payments, allocations and credit notes. That test is the difference between someone who has read about accounting and someone who has built it.
- **Concurrency is handled where money is at stake.** Document numbering uses a locked counter row, not `MAX(n)+1`. Payment allocation locks the target invoice rows, so two simultaneous receipts cannot over-allocate a single invoice. Mutating endpoints accept an `Idempotency-Key` stored transactionally in Postgres, so a retried payment POST does not become two payments.
- **Tenant isolation is defended twice** — once by a Prisma client extension that injects `organizationId` into every query, once by Postgres Row-Level Security — and proved by a test suite that tries to read across the boundary.
- **The reconciliation engine is a real matching problem**, with a confidence-scored multi-pass algorithm, a greedy bipartite assignment step, and named handling for duplicates, partials, timing differences and re-imports.

### Why it is a strong portfolio project

Recruiters screening backend and full-stack candidates see the same six projects. A ledger-correct accounting core is not one of them. More importantly, it produces *interview material*: every design decision here (why NUMERIC and not float, why reversal and not delete, why the report doesn't read a cached total, why idempotency lives in Postgres and not Redis) is a five-minute answer that demonstrates judgement rather than recall.

And it demos beautifully. The moment where you click **Post** on an invoice and a balanced journal entry appears beside it — debits on the left, credits on the right, totals equal — makes the whole architecture legible in four seconds.

**Positioning note:** never describe this as a Tigg clone, in the README, the repo name, the commit history, or an interview. It is an original product informed by how systems in this category work. Do not copy Tigg's copy, colours, logo or screenshots.

---

## 2. MVP scope

The budget is roughly **100–110 focused developer-hours** (2 people × 7 days × ~7.5 productive hours). The scope below is estimated at ~95 hours. That margin is the entire safety buffer — it is why the CUT list is so long.

### MUST HAVE

These are non-negotiable. Cutting any one of them breaks the demo or removes the signal.

| # | Feature | Why it must be in |
|---|---|---|
| 1 | **Auth: register, login, JWT access + rotating refresh tokens, Argon2id hashing** | Every reviewer checks this first. Refresh-token *rotation with reuse detection* takes 40 extra minutes and separates you from tutorial auth. |
| 2 | **Multi-tenancy: `organizations`, `memberships`, org switcher, `organizationId` on every tenant table** | The #1 differentiator vs a single-user CRUD app, and the source of the worst possible bug in this domain. Enforced by a Prisma extension. |
| 3 | **RBAC: `roles`, `permissions`, `role_permissions`, route-level + object-level checks** | "Who is allowed to post to the ledger" is a financial control, not a UI concern. Four roles is enough: Owner, Accountant, Clerk, Viewer. |
| 4 | **Chart of Accounts, seeded (~28 accounts, 5 types)** | Prerequisite for everything. Seeded, not user-built — building a COA editor is a day you do not have. Users may add accounts; they cannot restructure the tree. |
| 5 | **Journal entries + journal lines with DB-enforced balance** | The heart. Deferred constraint trigger. Without this the project is an invoicing app. |
| 6 | **Posting engine (one service, per-document-type rule sets)** | Invoice, Credit Note, Receipt, Manual Journal. One code path, four rule sets. Demonstrates the abstraction, not four copy-pasted controllers. |
| 7 | **Posted-record immutability + reversal** | Trigger-enforced. The clearest possible signal of financial-data-integrity understanding. |
| 8 | **Customers (parties) + Invoices with lines and 13% VAT** | The demo's entry point. Server recomputes every total; client-sent amounts are ignored. |
| 9 | **Receipts + payment allocations (partial, and one receipt → many invoices)** | Allocation is where naive implementations fall over. Row-locked, sum-constrained. |
| 10 | **Bank accounts + CSV statement import + matching engine + manual match + reconcile** | The most visually impressive module and the clearest "banking operations" signal. |
| 11 | **Reports derived from the ledger: Trial Balance, General Ledger, P&L, Balance Sheet, AR Aging, Reconciliation Summary** | All six are SQL over one table once the ledger exists. Cheap to add, high to display. |
| 12 | **Append-only audit log (actor, action, entity, before/after JSONB, IP, request ID)** | Compliance signal. ~2 hours as middleware around the service layer. |
| 13 | **Idempotency keys on all mutating POSTs** | Stored in Postgres inside the same transaction as the write. Two hours; enormous senior signal. |
| 14 | **Fiscal year + period locking** | Blocks posting into a closed period, by trigger. One hour. |
| 15 | **Zod validation on every request boundary + OpenAPI generated from the same Zod schemas** | Single source of truth for shape. `@asteasolutions/zod-to-openapi` gives you Swagger UI nearly free. |
| 16 | **Test suite: accounting invariants, tenant isolation, permissions, idempotency, concurrency, reconciliation, one golden E2E** | Section 10. This is what converts "nice demo" into "this person is careful". |
| 17 | **Docker Compose (api, web, postgres, redis) + seeded demo data script** | A reviewer must be able to run `docker compose up && npm run seed:demo` and see the demo company. |

### SHOULD HAVE

Build these only if the Day 5 checkpoint is green.

| Feature | Why it is second-tier | Estimated cost |
|---|---|---|
| **Accounts Payable: suppliers, bills, supplier payments** | The posting rules are the mirror image of AR, so the *backend* is ~3 hours through the same engine. But every AP feature needs UI, and UI is what you are short of. **Recommendation: implement the posting rules + API + tests, and a read-only AP list screen.** You get to say "the engine is document-type agnostic — here is the proof" without spending a day on forms. | 4–5 h |
| **AI document extraction (the one "impressive extra")** | See the note below. Genuinely feature-flagged, Day 6, timeboxed to 6 hours across both devs. | 6 h |
| **Dashboard with KPI cards + a receivables chart** | Nice for the demo's opening frame, contributes zero correctness signal. Build a simple version; skip if behind. | 3 h |
| **Postgres Row-Level Security as second isolation layer** | Real defence-in-depth and a great interview answer, but it forces every query into an explicit transaction with `SET LOCAL app.current_org_id`. Add it Day 6 if the suite is green, and write the tradeoff up in the README either way. | 3 h |
| **CI (GitHub Actions: migrate + test on a Postgres service) + coverage badge** | High README value, low effort, but only meaningful once tests exist. | 1.5 h |
| **Live deployment (Neon + Render/Fly + Vercel)** | A live URL roughly doubles the click-through rate on a portfolio link. Budgeted into Day 7. | 3 h |

### The one impressive extra — and my honest recommendation

You mentioned wanting an agentic loop in this project. Here is the version that fits and the version that does not.

**Fits (Day 6, 6 hours, feature-flagged): AI invoice/bill extraction with a validating loop.**

```
Upload PDF/image  →  BullMQ job  →  VLM call with a Zod-derived JSON schema in the prompt
                                 →  parse + validate against the same Zod schema
                                 →  on validation failure, re-prompt once with the errors  ← the loop
                                 →  tool-style DB lookup: fuzzy-match extracted party name
                                    against this org's customers (pg_trgm), attach candidates
                                 →  per-field confidence  →  human review screen
                                 →  accept  →  creates a DRAFT invoice
                                 →  user posts it through the normal posting engine
```

Why this is the safe choice: the AI output never touches the ledger. It produces a draft that goes through the exact same validation and posting path as a hand-typed invoice. If the model hallucinates, the worst case is a wrong draft that a human rejects. The accounting core stays untouched, which is the constraint you set.

Why the loop is real and not decorative: the model's output is checked against a machine-readable contract and it gets one bounded retry with the specific validation errors fed back. That is a genuine (if small) agentic loop, and it is defensible in an interview because you can explain the failure modes and the retry budget.

**Does not fit:** an autonomous agent that categorises transactions and posts them, a multi-agent reconciliation system, or anything where a model decides ledger contents. Both because of the time budget and because "the LLM writes to the general ledger" is a design a fintech interviewer will push back on hard.

**Fallback if Day 5 slips:** cut AI entirely and replace it with *rule-based intelligent categorisation* in the reconciliation module — a small keyword/regex ruleset that suggests an expense account for unmatched bank debits ("SALARY" → Salaries Expense, "RENT" → Rent Expense). Two hours, demos almost as well, cannot fail live.

### CUT FROM MVP

Ruthlessly. Each of these is in the source document; none of them belong in seven days.

| Cut | Why |
|---|---|
| **Inventory, stock ledger, valuation (WAvg/FIFO), COGS on sale** | This is the second-largest subsystem in the source doc. Correct perpetual valuation with backdated entries is a week by itself. Sell services and non-stock goods; the invoice posts `Dr AR / Cr Revenue / Cr VAT` with no inventory leg. State this as a deliberate scope decision in the README. |
| **POS / Retail / Restaurant (KOT, tables, sessions, split tender)** | Entirely orthogonal to the fintech signal. Adds surface, adds zero depth. |
| **Purchase orders, quotations, sales orders, document conversion chains** | `parent_doc_id` conversion flows are pure workflow plumbing. No accounting insight. |
| **Production / BOM / landed costs** | Manufacturing accounting. Not in a week. |
| **Subscriptions, plans, metering, usage counters, SMS credits** | This is *your* billing, not your user's accounting. Recruiters reading a fintech project want the ledger, not the paywall. |
| **IRD / CBMS integration, fiscal invoice certification** | The source document is explicit that this cannot be implemented unilaterally. Do not fake it, do not stub it, do not mention it. |
| **Multi-currency + FX revaluation** | The schema should carry `currency` and `fx_rate` columns so the design is visibly future-proof, but everything is NPR at rate 1.0. Unrealised FX gain/loss is a genuinely hard accounting topic; attempting it half-way is worse than not attempting it. |
| **Bikram Sambat date system + AD↔BS conversion** | A real time sink (correct BS conversion needs a lookup table, not arithmetic). Compromise: store AD dates only, and *label* the fiscal year "FY 2082/83" as a string. You get the local flavour for free. |
| **Approval workflows (rules, steps, requests, actions)** | An entire state machine and UI. RBAC already covers "who may post". |
| **Email, SMS, push, in-app notifications** | Zero signal, real integration cost, and a live-demo failure risk. |
| **Custom fields, reporting tags / dimensions, document templates** | Metadata infrastructure. Interesting, invisible. |
| **Webhooks, public API keys, developer portal** | Platform surface, not financial depth. |
| **PDF invoice generation** | Puppeteer/pdfkit in Docker is a classic half-day sinkhole for a printed rectangle. Use the browser's print stylesheet if you want a PDF at all. |
| **`account_balances` rollup / materialised balances** | The source doc is right that this is needed at 200k transactions/year. Your demo has ~40. Computing the trial balance live from `journal_lines` is one indexed aggregation, and the rollup introduces an entire class of backdating bugs. **Cut it, and say so in the README with the threshold at which you'd add it.** Deliberately declining an optimisation, with a stated reason, reads as more senior than adding one. |
| **Soft deletes anywhere financial** | Not a feature — an anti-feature here. Nothing financial is deletable at all. |
| **Marketing site, mobile apps, i18n** | No. |

---

## 3. Fintech concepts demonstrated

This is the map from what you build to what a reviewer perceives. Put a condensed version of this table in the README — most recruiters will not infer it themselves.

| Implemented feature | Fintech / engineering concept it proves |
|---|---|
| Balanced `journal_entries` + `journal_lines`, DB-enforced | Double-entry bookkeeping fundamentals; the accounting equation as a system invariant |
| Every document funnels through one `postDocument()` service | Understanding that documents are *inputs* and the ledger is the *record* — the core architectural idea of accounting software |
| `NUMERIC(18,4)` end to end, `Decimal` arithmetic, single rounding boundary | Money representation; awareness that floats lose cents and that rounding drift is the most common accounting bug |
| Posted entries immutable at the trigger level; correction by reversal / credit note | Financial data integrity, non-repudiation, why accounting systems are append-only |
| AR control account reconciled to invoice outstanding by test | Subledger-to-general-ledger agreement — the thing an actual auditor checks |
| Payment allocations (partial, many-to-many, row-locked, sum-constrained) | Receivables operations; cash application; over-allocation as a real financial risk |
| Fiscal years + period locking enforced by trigger | Period-end close discipline; why you cannot backdate into a closed year |
| CSV statement import + multi-pass confidence-scored matching + manual override | Banking operations, cash reconciliation, and the reality that automated matching is a *suggestion* engine with a human in the loop |
| Reconciliation statement: book vs bank vs difference, must reach zero | Cash controls; deposits-in-transit and outstanding-item reasoning |
| Trial Balance / P&L / Balance Sheet computed live from `journal_lines` | Reporting derived from source of truth, never from denormalised totals; the accounting equation proven at report time |
| Balance Sheet with a computed current-year-earnings figure | Real understanding of how P&L rolls into equity — most people get this wrong |
| AR Aging bucketed by due date from ledger + allocations | Credit risk / collections; working-capital reporting |
| Append-only `audit_log` with actor, before/after, IP, request ID | Financial compliance, auditability, forensic traceability |
| `organizationId` on every row + Prisma extension + (optional) RLS + isolation tests | Multi-tenant SaaS data isolation; treating cross-tenant leakage as the highest-severity bug class |
| Roles → permission codes → route guard → object-level scope check | Financial access control; separation of duties (a Clerk drafts, an Accountant posts) |
| `Idempotency-Key` persisted transactionally, replayed on retry | Payments-grade API design; understanding that a retried POST must not create a second payment |
| `SELECT … FOR UPDATE` on numbering series and on invoices during allocation | Concurrency control where money is at stake; statutory gapless numbering |
| Invariant test suite (`SUM(debits) = SUM(credits)` after arbitrary op sequences) | Testing *properties*, not just endpoints — the mindset financial engineering requires |
| Zod → OpenAPI single-source contract | Secure API design; validation at the boundary; no drift between docs and reality |

---

## 4. System architecture

A **modular monolith**, deliberately. Two developers in seven days have no business operating a distributed system, and a well-layered monolith with clear module boundaries is the correct answer for this scale — say so in interviews rather than apologising for it.

### Layering rule

`route → zod validation → controller (HTTP only) → service (all business rules, owns the transaction) → repository / Prisma → Postgres`

Controllers never touch Prisma. Services never touch `req`/`res`. This one rule makes the code reviewable in ninety seconds.

### Language: plain JavaScript, and what that changes

The project is JavaScript (ESM, Node 20 native `import`) rather than TypeScript. Three practical consequences, and the compensations for each — these matter more here than on a normal CRUD app, because the thing you lose type-checking on is money.

**1. Zod becomes the type system.** Every request boundary, every service input, and every parsed CSV row is validated by a Zod schema — not as a nice-to-have but as the *only* place shape is guaranteed. Use `.strict()` on every object schema so unknown keys are rejected. `zod-to-openapi` still generates Swagger from those same schemas, so §15's single-source-of-truth claim survives intact. The one schema file is genuinely shared between `/server` and `/web`, with no build step.

**2. Money needs runtime discipline, not compile-time.** In TypeScript a `Decimal` and a `number` are different types and the compiler catches the mix. In JavaScript nothing does — and `Prisma.Decimal + 5` silently produces a string. So:

- One `Money` module (`server/src/lib/money.js`) exporting `dec(x)`, `add`, `sub`, `mul`, `round2`, `eq`, `isZero`. **Arithmetic on money happens nowhere else in the codebase.**
- An ESLint `no-restricted-syntax` rule banning `parseFloat`, `Number(`, and `+` on anything named `*amount|*total|*balance|debit|credit` inside `server/src/accounting/` and `server/src/reporting/`. Ten minutes to write, and it catches the exact class of bug the compiler would have.
- An assertion helper `assertDecimal(x, label)` at the top of every posting rule. Cheap, and it fails loudly in tests rather than quietly in a report.

**3. Editor help via JSDoc, on the files that earn it.** Add `// @ts-check` plus JSDoc typedefs to just three files — `money.js`, `posting-rules.js`, and the Prisma client wrapper — and VS Code gives you autocomplete and red squiggles there without a build step or a `tsconfig` for the whole repo. Skip it everywhere else; it is not worth the annotation cost in a seven-day window.

**How to frame this in an interview**, if asked: the correctness guarantees in this system are enforced at runtime by the database and by Zod, not by the compiler — a deferred constraint trigger catches an unbalanced entry regardless of language, and a type system would not have caught any of the bugs the invariant tests do catch. That is a defensible position. Do not say "we didn't have time for TypeScript."

### Diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│  BROWSER — React 18 + Vite + JavaScript (JSX) + Tailwind                 │
│                                                                          │
│  Routes        /login  /orgs  /dashboard  /customers  /invoices          │
│                /receipts  /banking  /reports/*  /audit                   │
│  State         TanStack Query (server state) · Context (auth + active org)│
│  Forms         react-hook-form + the SAME Zod schemas as the server      │
│  Money         never computed client-side; totals come from the API       │
│  Tokens        access token in memory · refresh token in httpOnly cookie  │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │  HTTPS  /api/v1
                                │  Authorization: Bearer <access>
                                │  X-Organization-Id: <uuid>
                                │  Idempotency-Key: <uuid>  (mutations)
┌───────────────────────────────▼──────────────────────────────────────────┐
│  API — Node 20 + Express + JavaScript (ESM)                              │
│                                                                          │
│  ── Middleware pipeline (order matters) ──────────────────────────────    │
│   helmet → cors(allowlist) → requestId → rateLimit(Redis)                │
│    → authenticate(JWT)                                                   │
│    → resolveTenant(X-Organization-Id ⟶ VERIFY against memberships)       │
│    → authorize(permission code)                                          │
│    → validate(Zod: params, query, body)                                  │
│    → idempotency(Postgres-backed, mutations only)                        │
│    → controller                                                          │
│    → auditLog(after commit)  → errorHandler(uniform error envelope)      │
│                                                                          │
│  ── Domain modules (services) ────────────────────────────────────────    │
│   ┌────────────┐ ┌────────────┐ ┌──────────────┐ ┌───────────────────┐   │
│   │  identity  │ │  masters   │ │    sales     │ │      banking      │   │
│   │ auth,orgs, │ │ accounts,  │ │ invoices,    │ │ bank accounts,    │   │
│   │ members,   │ │ parties,   │ │ credit notes,│ │ CSV import,       │   │
│   │ roles/perm │ │ tax codes, │ │ receipts,    │ │ MATCHING ENGINE,  │   │
│   │            │ │ fiscal yrs │ │ allocations  │ │ reconciliation    │   │
│   └────────────┘ └────────────┘ └──────┬───────┘ └─────────┬─────────┘   │
│                                        │                   │             │
│                          ┌─────────────▼───────────────────▼──────────┐  │
│                          │   ★ POSTING ENGINE  (accounting/)          │  │
│                          │   postDocument(doc, actor)                 │  │
│                          │   · period + org-state guards              │  │
│                          │   · locked numbering series                │  │
│                          │   · per-doc-type journal rule sets         │  │
│                          │   · Σdebit == Σcredit assertion            │  │
│                          │   · ONE Prisma $transaction                │  │
│                          │   · reverseEntry(), never UPDATE/DELETE    │  │
│                          └─────────────┬──────────────────────────────┘  │
│                                        │                                 │
│   ┌────────────────────┐   ┌───────────▼──────────┐  ┌───────────────┐   │
│   │  reporting/        │   │   audit/             │  │  ai/ (flagged)│   │
│   │  pure SQL over     │   │   append-only,       │  │  extract job  │   │
│   │  journal_lines:    │   │   before/after JSONB │  │  + Zod retry  │   │
│   │  TB · GL · P&L ·   │   │   written post-commit│  │  loop         │   │
│   │  BS · AR aging     │   └──────────────────────┘  └───────┬───────┘   │
│   └────────────────────┘                                     │           │
└───────────────────────────────┬──────────────────────────────┼───────────┘
                                │                              │
        ┌───────────────────────▼──────────┐   ┌───────────────▼─────────┐
        │  PostgreSQL 16                   │   │  Redis 7                │
        │                                  │   │  · rate-limit counters  │
        │  · NUMERIC(18,4) money           │   │  · BullMQ queue "ai"    │
        │  · deferred BALANCE trigger      │   │    (only if AI is on)   │
        │  · IMMUTABILITY trigger          │   └───────────────┬─────────┘
        │  · PERIOD-LOCK trigger           │                   │
        │  · FK ON DELETE RESTRICT         │           ┌───────▼────────┐
        │  · partial idx WHERE posted      │           │ BullMQ worker  │
        │  · optional RLS on org_id        │           │ (same image,   │
        │  · idempotency_keys UNIQUE       │           │  WORKER=1)     │
        └──────────────────────────────────┘           └────────────────┘

  Docker Compose: web · api · worker(optional) · postgres · redis
```

### Is Redis / BullMQ genuinely necessary?

Honest answer: **not for the core.** CSV import of a 60-line statement and the matching pass complete in well under 300 ms — making that async would add a polling UI and a failure mode in exchange for nothing.

Redis earns its place for **rate limiting** (you want a shared counter, and `express-rate-limit` with a Redis store is a five-minute change). BullMQ earns its place **only if you ship the AI extraction feature**, where a 3–10 second VLM call genuinely must not block a request.

So: put Redis in `docker-compose.yml` from Day 1 for rate limiting. Add the BullMQ queue on Day 6 alongside the AI feature, or not at all. If you don't ship AI, remove BullMQ from the README rather than leaving an unused dependency — reviewers notice.

### Two decisions worth defending in an interview

**Tenant isolation, primary mechanism: a Prisma Client extension.** A `$allModels` query override injects `where: { organizationId }` from AsyncLocalStorage request context on every read and sets it on every write. This makes "forgot the org filter" — the worst bug in the system — structurally impossible rather than a code-review responsibility.

**Tenant isolation, secondary mechanism: Postgres RLS.** Real defence in depth against a raw-SQL mistake or a compromised service. The cost is real: with a pooled connection, `SET LOCAL app.current_org_id` must run inside a transaction, so every request's DB work becomes an explicit transaction. Schedule it for Day 6, ship it if green, and either way write the tradeoff into the README. Knowing *why* you'd hesitate is the senior part.

---

## 5. Database design

### Conventions

- **Primary keys:** UUID (v7 if you use a generator, else v4). Sequential integers leak volume and invite IDOR probing.
- **Money:** `NUMERIC(18,4)` — Prisma `Decimal @db.Decimal(18, 4)`. Never `Float`, never `Number` in JS. Prisma returns `Prisma.Decimal`; do all arithmetic on it and **serialise to JSON as a string** (`"135600.0000"`), because JS `number` cannot round-trip more than 15 significant digits. The frontend formats strings; it never adds them.
- **Rounding:** stored at 4 dp, presented at 2 dp, rounded **half-up at exactly one boundary** per calculation chain (see §6).
- **Tenancy:** every tenant table carries `organization_id NOT NULL`, indexed, and it is the **first column of every composite index**.
- **Deletion:** `ON DELETE RESTRICT` on every financial FK. Nothing financial is ever deleted or soft-deleted.
- **Auditing columns:** `created_at`, `updated_at`, `created_by_id` on every table that a user can cause to exist.
- **Triggers:** Prisma cannot express deferred constraint triggers. Use `npx prisma migrate dev --create-only` and hand-write the SQL into the migration file. This is normal and expected; put those three trigger definitions in `prisma/migrations/*/migration.sql` and reference them from the README.

### Table-by-table

#### `users` — a person, global across tenants
`id · email CITEXT UNIQUE · password_hash · full_name · is_active · last_login_at · created_at`

An external accountant is one human serving many organisations. Users therefore cannot live inside a tenant — a mistake that is essentially unfixable later. No `organization_id` here.

#### `organizations` — the tenant
`id · name · legal_name · slug UNIQUE · pan_vat_no · base_currency CHAR(3) DEFAULT 'NPR' · fiscal_year_start_month SMALLINT DEFAULT 4 · status ENUM(active|read_only) · created_at`

`status = read_only` is a single flag checked in the posting guard. Cheap to add, and it demonstrates you've thought about subscription lapse without building a billing system.

#### `memberships` — user ↔ organization ↔ role
`id · user_id FK · organization_id FK · role_id FK · is_owner BOOL · status ENUM(active|disabled)`
`UNIQUE(user_id, organization_id)` · index on `(user_id)` for the org-switcher query.

Every request's tenant resolution is: read `X-Organization-Id` → **look up an active membership for this user and that org** → attach `{organizationId, permissions}` to request context. Never trust the header alone. This is the single most important line of authorisation code in the system.

#### `roles`, `permissions`, `role_permissions`
- `roles`: `id · organization_id NULL · name · is_system BOOL` — NULL org means a system template (Owner, Accountant, Clerk, Viewer) cloned into each new organisation at signup.
- `permissions`: `id · code UNIQUE · module` — codes are strings like `invoice.create`, `invoice.post`, `payment.create`, `journal.post`, `bank.reconcile`, `report.view`, `audit.view`, `org.manage`.
- `role_permissions`: `(role_id, permission_id)` composite PK.

Default matrix — put this table in the README, it reads as separation of duties:

| Permission | Owner | Accountant | Clerk | Viewer |
|---|:--:|:--:|:--:|:--:|
| `invoice.create` | ✓ | ✓ | ✓ | |
| `invoice.post` | ✓ | ✓ | | |
| `payment.create` | ✓ | ✓ | ✓ | |
| `journal.post` (manual JV) | ✓ | ✓ | | |
| `bank.reconcile` | ✓ | ✓ | | |
| `report.view` | ✓ | ✓ | ✓ | ✓ |
| `audit.view` | ✓ | ✓ | | |
| `org.manage` | ✓ | | | |

A Clerk drafting an invoice that an Accountant must post is a *financial control*, and it demos in ten seconds: log in as Clerk, watch the Post button be absent, hit the API directly with curl, get `403 permission_denied`.

#### `fiscal_years` and `accounting_periods`
- `fiscal_years`: `id · organization_id · label ('2082/83') · start_date · end_date · status ENUM(open|closed)` — `UNIQUE(organization_id, label)`, and a `CHECK (start_date < end_date)`.
- `accounting_periods`: `id · organization_id · fiscal_year_id · period_no · start_date · end_date · status ENUM(open|locked)`

The period-lock trigger looks up the period containing `entry_date` and raises if `status = 'locked'`. One table, one trigger, and you can demo "try to post into a locked month → rejected by the database".

#### `accounts` — Chart of Accounts
`id · organization_id · code · name · type ENUM(asset|liability|equity|income|expense) · parent_id self-FK NULL · is_bank BOOL · is_control BOOL · control_type ENUM(receivable|payable|tax) NULL · allow_manual_entry BOOL DEFAULT true · is_active`
`UNIQUE(organization_id, code)` · index `(organization_id, type)`

`is_control` is the detail that shows you've used real accounting software. Accounts Receivable is a *control account*: its balance must always equal the sum of the customer subledger. If a user can post a manual journal directly into AR, the two desynchronise and no report is trustworthy again. So `allow_manual_entry = false` on control accounts, enforced in the manual-JV validator.

Seed set (28 accounts):

```
1000 ASSETS
  1010 Cash in Hand                    asset
  1020 Bank — Nabil Bank Current       asset   is_bank
  1030 Bank — NIC Asia Savings         asset   is_bank
  1100 Accounts Receivable             asset   is_control(receivable)  no manual
  1200 Prepaid Expenses                asset
  1300 Fixed Assets — Equipment        asset
  1310 Accum. Depreciation — Equip.    asset   (contra)
2000 LIABILITIES
  2100 Accounts Payable                liability is_control(payable)   no manual
  2200 VAT Payable (Output)            liability is_control(tax)
  2210 VAT Receivable (Input)          asset     is_control(tax)
  2300 TDS Payable                     liability
  2400 Accrued Expenses                liability
3000 EQUITY
  3100 Owner's Capital                 equity
  3200 Retained Earnings               equity
  3900 Current Year Earnings           equity  (computed, never posted to)
4000 INCOME
  4100 Sales Revenue — Goods           income
  4200 Sales Revenue — Services        income
  4300 Discount Given                  income  (contra)
  4900 Other Income                    income
5000 EXPENSES
  5100 Cost of Sales                   expense
  5200 Salaries & Wages                expense
  5300 Rent Expense                    expense
  5400 Utilities                       expense
  5500 Bank Charges                    expense
  5600 Professional Fees               expense
  5700 Depreciation Expense            expense
  5900 Other Expenses                  expense
```

`3900 Current Year Earnings` exists as an account row so the Balance Sheet has somewhere to put net profit, but nothing ever posts to it — the report computes it. Explain that in the interview; it's the detail that shows you understand how P&L rolls into equity.

#### `parties` — customers and suppliers, one table
`id · organization_id · type ENUM(customer|supplier|both) · code · name · pan_vat_no · email · phone · address · credit_days INT DEFAULT 30 · credit_limit NUMERIC(18,4) NULL · is_active`
`UNIQUE(organization_id, code)` · index `(organization_id, type, is_active)`

One table because in this market the same entity is frequently both, and unifying it makes party ledgers and payment allocation uniform. `credit_days` drives the invoice due date and therefore the aging report.

#### `document_series` — gapless numbering
`id · organization_id · doc_type · fiscal_year_id · prefix · padding INT · next_number INT`
`UNIQUE(organization_id, doc_type, fiscal_year_id)`

Allocation is `SELECT … FOR UPDATE` on this row inside the posting transaction, then increment. **Never `MAX(doc_no)+1`** — under concurrency that produces duplicates, and duplicate invoice numbers are a statutory problem, not just a bug. A Postgres sequence is the alternative but leaves gaps on rollback; a locked counter row inside the same transaction as the posting does not. Say that out loud in the interview.

#### `documents` and `document_lines` — one shape, several types

`documents`:
`id · organization_id · fiscal_year_id · doc_type ENUM(invoice|credit_note|receipt|bill|supplier_payment) · doc_no · doc_date DATE · due_date DATE NULL · party_id FK NULL · bank_account_id FK NULL · currency CHAR(3) DEFAULT 'NPR' · fx_rate NUMERIC(18,8) DEFAULT 1 · subtotal · discount_amount · taxable_amount · tax_amount · grand_total · allocated_amount · outstanding_amount · status ENUM(draft|posted|paid|partially_paid|reversed) · parent_document_id self-FK NULL · reference_no · notes · journal_entry_id FK NULL · posted_at · posted_by_id · created_by_id · version INT DEFAULT 0`

- `UNIQUE(organization_id, doc_type, fiscal_year_id, doc_no)` — no duplicate invoice numbers, ever.
- `CHECK (grand_total >= 0)` — negatives are expressed as credit notes, not sign flips. This is an accounting-convention decision worth stating.
- `CHECK (outstanding_amount >= 0 AND outstanding_amount <= grand_total)` — the database refuses over-allocation even if a service-layer bug slips through.
- Partial index `(organization_id, party_id) WHERE outstanding_amount > 0` — the aging report's hot path.
- Index `(organization_id, doc_type, doc_date)`.
- `version` powers optimistic concurrency on draft edits (`UPDATE … WHERE id = ? AND version = ?`, 0 rows → `409 conflict`).
- `parent_document_id` links a credit note to the invoice it corrects.
- `outstanding_amount` is deliberately denormalised — and §10 contains the test that proves it always equals what the ledger says.

`document_lines`:
`id · document_id FK · line_no · description · account_id FK · quantity NUMERIC(18,6) · unit_price NUMERIC(18,4) · discount_pct NUMERIC(5,2) · taxable_amount · tax_code_id FK NULL · tax_amount · line_total`
`UNIQUE(document_id, line_no)` · `CHECK (quantity > 0 AND unit_price >= 0)`

Each line names its own revenue/expense account. That is what lets one invoice split across `4100 Sales — Goods` and `4200 Sales — Services`, and it's what makes the P&L interesting rather than one-line.

#### `tax_codes`
`id · organization_id · name ('VAT 13%') · rate NUMERIC(7,4) · type ENUM(vat|exempt|zero) · output_account_id FK · input_account_id FK · is_active`

Rates are data. Hard-coding 0.13 anywhere in the codebase is an instant deduction.

#### `journal_entries` — ★ the record
`id · organization_id · fiscal_year_id · entry_no · entry_date DATE · narration · source_type ENUM(invoice|credit_note|receipt|bill|supplier_payment|manual|opening|bank_charge) · source_id UUID NULL · status ENUM(draft|posted|reversed) · reversal_of_id self-FK NULL · reversed_by_id self-FK NULL · posted_at · posted_by_id · created_at`
`UNIQUE(organization_id, fiscal_year_id, entry_no)` · index `(organization_id, entry_date)` · partial index `(organization_id, entry_date) WHERE status = 'posted'`

`source_type` + `source_id` is the polymorphic link back to the originating document. Every report filters `status = 'posted'` — draft entries are invisible to accounting.

#### `journal_lines` — ★ the atoms
`id · journal_entry_id FK ON DELETE RESTRICT · organization_id · line_no · account_id FK · debit NUMERIC(18,4) NOT NULL DEFAULT 0 · credit NUMERIC(18,4) NOT NULL DEFAULT 0 · party_id FK NULL · description`
`UNIQUE(journal_entry_id, line_no)` · index `(organization_id, account_id)` · index `(organization_id, party_id) WHERE party_id IS NOT NULL`

Two constraints and one trigger carry the entire thesis of the project:

```sql
-- 1. A line is a debit or a credit. Never both, never negative.
ALTER TABLE journal_lines ADD CONSTRAINT jl_sign_check
  CHECK (debit >= 0 AND credit >= 0 AND NOT (debit > 0 AND credit > 0)
         AND (debit > 0 OR credit > 0));

-- 2. Every entry balances. DEFERRED, so lines may be inserted one at a
--    time inside a transaction and are only checked at COMMIT.
CREATE OR REPLACE FUNCTION assert_entry_balanced() RETURNS trigger AS $$
DECLARE d NUMERIC(18,4); c NUMERIC(18,4);
BEGIN
  SELECT COALESCE(SUM(debit),0), COALESCE(SUM(credit),0) INTO d, c
  FROM journal_lines WHERE journal_entry_id = COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);
  IF d <> c THEN
    RAISE EXCEPTION 'Journal entry % is unbalanced: debits %, credits %',
      COALESCE(NEW.journal_entry_id, OLD.journal_entry_id), d, c
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END; $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_entry_balanced
  AFTER INSERT OR UPDATE OR DELETE ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_entry_balanced();

-- 3. Posted entries are immutable. The only permitted UPDATE is the
--    reversal back-reference.
CREATE OR REPLACE FUNCTION block_posted_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Posted journal entries cannot be deleted (entry %)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'posted' AND NEW.status = 'posted'
     AND (NEW.entry_date, NEW.narration, NEW.entry_no) IS DISTINCT FROM
         (OLD.entry_date, OLD.narration, OLD.entry_no) THEN
    RAISE EXCEPTION 'Posted journal entry % is immutable', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_je_immutable BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION block_posted_mutation();
```

A matching `BEFORE UPDATE OR DELETE` trigger on `journal_lines` rejects any change to a line whose parent entry is posted. Demo this live from `psql` — it lands harder than any slide.

#### `payment_allocations`
`id · organization_id · payment_document_id FK · target_document_id FK · amount NUMERIC(18,4) · allocated_at · created_by_id`
`UNIQUE(payment_document_id, target_document_id)` · `CHECK (amount > 0)` · index `(organization_id, target_document_id)`

The many-to-many that makes cash application real: one receipt settling three invoices, or three receipts settling one. The allocation service:

1. Opens a transaction.
2. `SELECT … FOR UPDATE` on every target invoice row (**ordered by id**, to avoid deadlock between two concurrent receipts hitting the same pair of invoices).
3. Asserts `Σ new allocations ≤ invoice.outstanding_amount` for each.
4. Inserts allocations, decrements `outstanding_amount`, flips `status` to `partially_paid` / `paid`.
5. Posts the receipt journal entry.
6. Commits.

The `CHECK (outstanding_amount >= 0)` on `documents` is the seatbelt if step 3 is ever wrong.

#### `bank_accounts`
`id · organization_id · account_id FK accounts (must be is_bank) · bank_name · account_no_masked · opening_balance · is_active`

Note `account_no_masked` — store `****4821`, not the full number. Small detail, correct instinct, free to implement.

#### `bank_statements` and `bank_statement_lines`
- `bank_statements`: `id · organization_id · bank_account_id FK · file_name · file_sha256 · period_start · period_end · opening_balance · closing_balance · line_count · imported_by_id · imported_at` — `UNIQUE(bank_account_id, file_sha256)` makes re-import idempotent.
- `bank_statement_lines`: `id · organization_id · statement_id FK · txn_date DATE · description · reference · debit NUMERIC(18,4) · credit NUMERIC(18,4) · running_balance · row_hash · status ENUM(unmatched|suggested|matched|reconciled|ignored) · matched_journal_line_id FK NULL · match_confidence NUMERIC(4,3) · matched_by ENUM(auto|manual) NULL · matched_at`
  - `UNIQUE(statement_id, row_hash)` where `row_hash = sha256(date|debit|credit|description|running_balance|row_index)` — the row index matters, because two identical NPR 5,000 transfers on the same day are legitimate and must both survive import.
  - `CHECK (NOT (debit > 0 AND credit > 0))`
  - Index `(organization_id, bank_account_id, status)`.

#### `reconciliations`
`id · organization_id · bank_account_id FK · as_of_date · statement_id FK · book_balance · bank_balance · difference · unreconciled_count · status ENUM(in_progress|completed) · completed_by_id · completed_at`

`CHECK (status <> 'completed' OR difference = 0)` — you literally cannot mark a reconciliation complete with a non-zero difference. That constraint *is* the internal control, expressed in DDL.

#### `audit_log` — append-only
`id · organization_id · actor_user_id FK NULL · action ('invoice.posted') · entity_type · entity_id · before JSONB NULL · after JSONB NULL · ip INET · user_agent · request_id · created_at`
Index `(organization_id, created_at DESC)` · index `(organization_id, entity_type, entity_id)`

Append-only enforced by a `BEFORE UPDATE OR DELETE` trigger that always raises. Written **after** the business transaction commits, so a rolled-back operation never leaves an audit entry claiming it happened.

#### `idempotency_keys`
`id · organization_id · key TEXT · endpoint · request_hash · response_status INT · response_body JSONB · created_at`
`UNIQUE(organization_id, key)`

Why Postgres and not Redis: the key row is inserted **inside the same transaction as the financial write**. If the transaction rolls back, so does the key, and the client's retry correctly re-attempts. With Redis you have two systems that can disagree about whether a payment happened, which is exactly the failure you were trying to prevent. This is a genuinely good interview answer — have it ready.

Flow:
```
BEGIN
  INSERT INTO idempotency_keys (org, key, endpoint, request_hash) …
      → unique violation? ROLLBACK, read stored row, replay stored response (HTTP 200, header Idempotent-Replay: true)
      → request_hash differs for the same key? → 422 idempotency_key_reuse
  … perform the financial write …
  UPDATE idempotency_keys SET response_status, response_body
COMMIT
```

### Entity relationships at a glance

```
users ─┬─< memberships >─┬─ organizations ─< everything (organization_id)
       │                 └─ roles ─< role_permissions >─ permissions
       │
organizations ─< fiscal_years ─< accounting_periods
              ─< accounts (self-FK tree)
              ─< parties
              ─< tax_codes
              ─< document_series
              ─< documents ─< document_lines
              │           └─ journal_entry_id ──┐
              │           └─ parent_document_id ┼─ (credit note → invoice)
              ─< payment_allocations ───────────┤ (payment ↔ invoice, M:N)
              ─< journal_entries ─< journal_lines ─ account_id
              │        └─ reversal_of_id (self-FK)
              ─< bank_accounts ─< bank_statements ─< bank_statement_lines
              │                                        └─ matched_journal_line_id
              ─< reconciliations
              ─< audit_log
              ─< idempotency_keys
```

---

## 6. Accounting engine

This is the section to get right. Everything else in the project is scaffolding around it.

### The single entry point

Every financial document — every one, without exception — goes through `postDocument()`. There is no second code path that writes to `journal_entries`.

```js
async function postDocument(documentId, actor) {
  return prisma.$transaction(async (tx) => {
    // 1. Lock the document. Prevents double-posting under concurrent requests.
    const [doc] = await tx.$queryRaw`
      SELECT * FROM documents
      WHERE id = ${documentId} AND organization_id = ${actor.organizationId}
      FOR UPDATE`;
    if (!doc) throw new NotFound();

    // 2. Guards — each throws a custom error class the handler maps to HTTP.
    assert(doc.status === 'draft',        new Conflict('already_posted'));
    assert(actor.org.status === 'active', new BusinessRule('organization_read_only'));
    await assertPeriodOpen(tx, doc.docDate, actor.organizationId);
    await assertPermission(actor, `${doc.docType}.post`);

    // 3. Allocate the document number from a LOCKED series row.
    doc.docNo = await nextDocNumber(tx, doc.docType, doc.fiscalYearId); // SELECT..FOR UPDATE

    // 4. Build journal lines from the rule set for this document type.
    const lines = POSTING_RULES[doc.docType](doc);

    // 5. Assert balance in application code too — fail fast with a good
    //    message rather than a raw Postgres exception at COMMIT.
    const debits  = sum(lines.map(l => l.debit));
    const credits = sum(lines.map(l => l.credit));
    assert(debits.equals(credits), new Internal(`unbalanced ${debits} vs ${credits}`));

    // 6. Write the entry and its lines. The DEFERRED trigger re-checks at COMMIT.
    const entry = await tx.journalEntry.create({
      data: { ...header(doc), status: 'posted', postedAt: new Date(),
              postedById: actor.userId, lines: { create: lines } }
    });

    // 7. Update the document: status, number, journal link, outstanding.
    await tx.document.update({ where: { id: doc.id }, data: {
      status: 'posted', docNo: doc.docNo, journalEntryId: entry.id,
      outstandingAmount: doc.grandTotal, version: { increment: 1 } }});

    return entry;
  }, { isolationLevel: 'ReadCommitted' });
  // 8. AFTER commit, outside the transaction: audit log, cache bust, webhooks.
  //    Never inside — you would emit events for transactions that rolled back.
}
```

Steps 1–7 are one transaction. Step 8 is not. That distinction is a real thing senior engineers check for.

### The posting rule sets

`POSTING_RULES` is a map from `doc_type` to a pure function `(document) => JournalLine[]`. Pure means: no I/O, no clock, no randomness — which makes them trivially unit-testable, and that is the point.

| Document | Debit | Credit |
|---|---|---|
| **Sales invoice** | Accounts Receivable (grand total) | Sales Revenue (per line, taxable); VAT Payable (tax) |
| **Credit note** | Sales Revenue (taxable); VAT Payable (tax) | Accounts Receivable (grand total) |
| **Customer receipt** | Bank / Cash (amount) | Accounts Receivable (amount) |
| **Purchase bill** *(SHOULD)* | Expense / Asset (per line); VAT Receivable (tax) | Accounts Payable (grand total) |
| **Supplier payment** *(SHOULD)* | Accounts Payable (amount) | Bank / Cash (amount) |
| **Bank charge** (from an unmatched statement debit) | Bank Charges expense | Bank |
| **Manual journal** | user-supplied | user-supplied |
| **Opening balance** | asset accounts | liability + equity accounts |

The AR and Bank lines carry `party_id`, which is what makes a per-customer party ledger a `WHERE` clause rather than a new subsystem.

### Worked example 1 — invoice with two lines

`INV-2082-0001`, dated 2026-01-12, customer *Himalayan Trek Supplies Pvt. Ltd.*, credit 30 days → due 2026-02-11.

| Line | Description | Account | Qty | Rate | Disc | Taxable | VAT 13% | Total |
|---|---|---|---:|---:|---:|---:|---:|---:|
| 1 | Trekking backpacks | 4100 Sales — Goods | 15 | 8,000.00 | 0% | 120,000.00 | 15,600.00 | 135,600.00 |
| 2 | Repair service | 4200 Sales — Services | 1 | 45,000.00 | 0% | 45,000.00 | 5,850.00 | 50,850.00 |

*(For the demo these are two separate invoices — shown merged here only to illustrate multi-account posting.)*

Taking line 1 alone as `INV-2082-0001`:

```
JE-2082-0003   2026-01-12   Sales Invoice INV-2082-0001 — Himalayan Trek Supplies
────────────────────────────────────────────────────────────────────────────────
  Dr  1100  Accounts Receivable   (party: Himalayan Trek)     135,600.0000
      Cr  4100  Sales Revenue — Goods                                     120,000.0000
      Cr  2200  VAT Payable (Output)                                       15,600.0000
────────────────────────────────────────────────────────────────────────────────
                                          Σ Dr 135,600.0000  Σ Cr 135,600.0000  ✓
```

### Worked example 2 — the rounding boundary

This is the bug that bites every accounting system. Consider a line: qty 3 @ NPR 1,250.50 with a 5% discount, VAT 13%.

```
gross     = 3 × 1250.50            = 3,751.50
discount  = 3751.50 × 0.05         =   187.575    → ROUND HALF-UP 2dp → 187.58
taxable   = 3751.50 − 187.58       = 3,563.92
vat       = 3563.92 × 0.13         =   463.3096   → ROUND HALF-UP 2dp → 463.31
lineTotal = 3563.92 + 463.31       = 4,027.23
```

The rule: **round at each named boundary (discount, tax, line total), then sum the rounded values.** Never sum unrounded values and round at the end — the printed invoice will disagree with the ledger by a paisa, and paisa differences are exactly what makes a trial balance fail to foot.

Document totals are `Σ` of already-rounded line values, so `grand_total` on the document always equals `Σ debit` on the journal entry, exactly. Write a test for that (§10, INV-11).

Store 4 dp, present 2 dp. One helper — `round2(decimal)` using `ROUND_HALF_UP` — used at every boundary and nowhere else.

### Worked example 3 — partial payment and allocation

`RCP-2082-0001`, 2026-02-05, NPR 100,000 received into `1020 Bank — Nabil`, allocated fully against `INV-2082-0001` (135,600).

```
JE-2082-0006   2026-02-05   Receipt RCP-2082-0001 — Himalayan Trek Supplies
────────────────────────────────────────────────────────────────────────────────
  Dr  1020  Bank — Nabil Bank Current                          100,000.0000
      Cr  1100  Accounts Receivable  (party: Himalayan Trek)              100,000.0000
────────────────────────────────────────────────────────────────────────────────
```

Side effects inside the same transaction:
- `payment_allocations`: one row, `amount = 100,000`.
- `INV-2082-0001.outstanding_amount`: 135,600 → **35,600**
- `INV-2082-0001.status`: `posted` → `partially_paid`

And now the invariant that matters: the balance of account `1100` is `135,600 + 50,850 − 100,000 = 86,450`… and `Σ documents.outstanding_amount WHERE doc_type='invoice'` is `35,600 + 50,850 = 86,450`. **Equal.** The subledger agrees with the general ledger. Test INV-3 asserts this after every operation in the suite.

Over-allocation: a receipt of 150,000 offered against an invoice with 35,600 outstanding is rejected at the service layer with `422 over_allocation`, and would be rejected by the `CHECK (outstanding_amount >= 0)` constraint even if the service were wrong.

Unallocated receipts are legal — a customer advance. The receipt posts `Dr Bank / Cr AR` and sits with `outstanding_amount = amount` on the payment document, to be allocated later. Supporting this costs nothing and shows you know advances exist.

### Worked example 4 — credit note (correcting a posted invoice)

Suppose 2 of the 15 backpacks were returned. Credit note `CN-2082-0001`, 2026-02-20, `parent_document_id = INV-2082-0001`, 2 × 8,000 = 16,000 + VAT 2,080 = 18,080.

```
JE-2082-0010   2026-02-20   Credit Note CN-2082-0001 vs INV-2082-0001
────────────────────────────────────────────────────────────────────────────────
  Dr  4100  Sales Revenue — Goods                               16,000.0000
  Dr  2200  VAT Payable (Output)                                 2,080.0000
      Cr  1100  Accounts Receivable  (party: Himalayan Trek)               18,080.0000
────────────────────────────────────────────────────────────────────────────────
```

The invoice's `outstanding_amount` drops 35,600 → 17,520. Note that **the invoice itself is untouched** — its `grand_total` is still 135,600. The correction lives in a second document, and both appear in the audit trail. That is the accounting answer to "the customer wants a change".

### Worked example 5 — reversal (correcting a wrong journal)

A credit note corrects a *commercial* fact. A reversal corrects a *posting* mistake — say a manual JV hit the wrong expense account.

`reverseEntry(entryId, reason, actor)`:

1. Load the original posted entry. Assert `status = 'posted'` and `reversed_by_id IS NULL`.
2. Assert the reversal date's period is open.
3. Create a **new** entry, `source_type = 'manual'`, `reversal_of_id = original.id`, narration `"Reversal of JE-2082-0007: <reason>"`, with every line's debit and credit **swapped**.
4. Set the original's `status = 'reversed'` and `reversed_by_id = new.id`. *(This is the one status transition the immutability trigger permits — it changes no financial field.)*
5. Cascade: if the reversed entry came from a document, the document returns to a `reversed` state and its `outstanding_amount` is zeroed.

```
Original  JE-2082-0007        Dr 5900 Other Expenses  12,000    Cr 1020 Bank  12,000
Reversal  JE-2082-0011        Dr 1020 Bank            12,000    Cr 5900 Other Expenses  12,000
Net effect on the ledger: zero. Rows deleted: zero. Audit entries: three.
```

Demo this. Then run `DELETE FROM journal_entries WHERE id = '…'` in `psql` and let the reviewer watch Postgres refuse.

### Posting states

```
Document:        draft ──post──> posted ──allocate──> partially_paid ──> paid
                   │                │
                   │                └──credit note──> (outstanding reduced)
                   │                └──reverse──────> reversed
                   └──delete (drafts only, hard delete permitted)

Journal entry:   draft ──post──> posted ──reverse──> reversed
                 (posted is terminal except for the reversal back-reference)

Bank line:       unmatched ──auto──> suggested ──confirm──> matched ──reconcile──> reconciled
                     │                    │
                     └──manual match──────┘
                     └──ignore──> ignored
                     └──create entry──> matched
```

Each of these lives in **one** explicit transition table, not scattered `if (status === …)` checks. A tiny `canTransition(entity, from, to)` helper plus a test that enumerates every illegal transition is thirty lines and reads extremely well in review.

### Validation layers

Four, and each is load-bearing:

1. **Client (React + Zod):** shape, required, ranges. UX speed only. Never trusted.
2. **API boundary (same Zod schemas):** types, enums, FK existence **scoped to the tenant** — a valid UUID from another organisation must fail here as `404`, not `403` (revealing existence is itself a leak).
3. **Service layer:** business invariants — period open, org active, permission, credit limit, over-allocation, duplicate detection (same party + amount + reference within 7 days → a warning flag, not a rejection).
4. **Database:** balance trigger, immutability trigger, period-lock trigger, `CHECK`s, uniques, RLS.

The demo line for this: "totals are never accepted from the client — the server recomputes every line, every tax, and every total from quantities and rates, then compares. If a client sends a `grand_total`, it is ignored." That is a specific, checkable claim about your API and it is exactly the kind of thing a fintech interviewer probes.

### Period locking

```sql
CREATE OR REPLACE FUNCTION assert_period_open() RETURNS trigger AS $$
DECLARE st TEXT;
BEGIN
  IF NEW.status <> 'posted' THEN RETURN NEW; END IF;
  SELECT status INTO st FROM accounting_periods
   WHERE organization_id = NEW.organization_id
     AND NEW.entry_date BETWEEN start_date AND end_date;
  IF st IS NULL THEN
    RAISE EXCEPTION 'No accounting period covers %', NEW.entry_date USING ERRCODE='check_violation';
  ELSIF st = 'locked' THEN
    RAISE EXCEPTION 'Accounting period containing % is locked', NEW.entry_date USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
```

Service-layer check first (for the nice error message), trigger second (because the service layer can be bypassed). Belt and braces, and saying "belt and braces" about financial constraints is a good look.

### Transaction atomicity — the rules you follow

1. One document post = **one** `prisma.$transaction`. Never two.
2. Row locks acquired in a **deterministic order** (by `id`) to avoid deadlock.
3. No network I/O inside a transaction — no HTTP, no queue push, no email. Ever.
4. Side effects (audit log, cache invalidation, webhooks, AI jobs) are enqueued **after** commit.
5. `ReadCommitted` + explicit `FOR UPDATE` on contended rows, rather than `Serializable` everywhere. `Serializable` would work but converts contention into retry storms you'd then have to handle; explicit locks are more predictable and easier to explain.

---

## 7. Bank reconciliation

No real bank integration. CSV upload, a realistic sample statement, and a matching engine that is genuinely a matching engine — not a `WHERE amount = amount` lookup dressed up.

### Import pipeline

```
POST /api/v1/bank-accounts/:id/statements   (multipart, Idempotency-Key)
  1. Guard: mimetype allowlist (text/csv, application/vnd.ms-excel), ≤ 2 MB, ≤ 5,000 rows
  2. Read into memory (never write user files to disk in this app)
  3. sha256(file) → UNIQUE(bank_account_id, file_sha256) → duplicate upload returns 200
     with the ORIGINAL statement, not a second import
  4. Parse with a strict Zod row schema; a column-mapping step for date format,
     debit/credit vs single signed amount
  5. Reject the WHOLE file if any row fails (all-or-nothing import; a half-imported
     statement is worse than none) and return per-row errors
  6. Insert statement + lines in one transaction, status = 'unmatched'
  7. Run the matcher synchronously (< 300 ms for a 60-row statement)
  8. Return { statement, imported, autoMatched, suggested, unmatched }
```

Sample CSV format (ship 3 fixtures: clean, messy dates, duplicate amounts):

```csv
Date,Description,Reference,Debit,Credit,Balance
2026-01-20,RENT PAYMENT ANNAPURNA COMPLEX,CHQ 004821,25000.00,,475000.00
2026-02-05,NEFT/HIMALAYAN TREK SUPPLIES/INV-2082-0001,NEFT8834512,,100000.00,575000.00
2026-02-08,IPS/EVEREST CAFE PVT LTD,IPS2210094,,50850.00,625850.00
2026-02-25,MONTHLY SERVICE CHARGE,,1130.00,,624720.00
```

### The candidate pool

For a statement line, candidates are **posted journal lines on the bank account's GL account** that are not already reconciled:

```sql
SELECT jl.id, jl.debit, jl.credit, je.entry_date, je.narration,
       d.doc_no, d.reference_no, p.name AS party_name
FROM journal_lines jl
JOIN journal_entries je ON je.id = jl.journal_entry_id
LEFT JOIN documents d   ON d.journal_entry_id = je.id
LEFT JOIN parties p     ON p.id = d.party_id
WHERE jl.organization_id = $org
  AND jl.account_id      = $bankGlAccount
  AND je.status          = 'posted'
  AND je.entry_date BETWEEN $lineDate - INTERVAL '7 days'
                        AND $lineDate + INTERVAL '7 days'
  AND jl.id NOT IN (SELECT matched_journal_line_id FROM bank_statement_lines
                     WHERE matched_journal_line_id IS NOT NULL)
```

**Direction must agree.** A bank statement *credit* (money in) corresponds to a *debit* on the bank GL account. Getting this backwards is the classic first-day reconciliation bug — write a test for it (RECON-6).

### Scoring: four passes, one score

Each candidate gets a score in [0, 1]:

```
score = 0.55 × amountScore          (hard gate: 0 unless exact to 2 dp → 1.0)
      + 0.25 × dateScore            (same day 1.0; |Δ|=1 → 0.9; ≤3 → 0.7; ≤7 → 0.4; else 0)
      + 0.20 × referenceScore       (max of:
                                       doc_no appears in description/reference → 1.0
                                       payment reference_no exact match        → 1.0
                                       party name trigram similarity           → similarity()
                                       else                                     0)
```

Amount is a **hard gate**, not a weight: if the amounts differ by even one paisa the candidate scores zero and never appears. Partial payments are a *separate* pass (below), not a fuzzy amount match. Being strict here is the correct call and worth explaining — a system that "helpfully" matches 100,000 against 100,500 will silently hide a NPR 500 error forever.

Trigram similarity uses `pg_trgm`:
```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
SELECT similarity(lower($description), lower($partyName));
```
`"IPS/EVEREST CAFE PVT LTD"` vs `"Everest Cafe Pvt. Ltd."` scores around 0.55 — enough for a suggestion, not enough to auto-confirm.

### Assignment: greedy bipartite matching

Scoring alone is not enough, because two statement lines can both want the same journal line. Assignment must be one-to-one.

```
1. Build all (statementLine, journalLine, score) triples with score > 0.45
2. Sort descending by score
3. Walk the list; accept a pair only if NEITHER side is already assigned
4. Classify:
     score ≥ 0.90  → status='matched',   matched_by='auto'   (auto-confirmed)
     0.45–0.90     → status='suggested'                      (needs one click)
     no candidate  → status='unmatched'
```

Greedy is O(n log n) after scoring and is correct enough at statement scale. In the interview, name what you'd do at scale — the Hungarian algorithm / min-cost max-flow for a globally optimal assignment — and say why you didn't: greedy is within a rounding error of optimal when the top scores are near 1.0, and a human confirms everything below 0.9 anyway. **Knowing the optimal algorithm and choosing not to use it, with a reason, is the answer they want.**

### The three resolution paths for an unmatched line

1. **Manual match** — user picks any candidate from a searchable list. Sets `matched_by = 'manual'`, `match_confidence = 1.0`, and writes an audit entry with the actor.
2. **Create an entry from the line** — the line is a real transaction you never recorded (bank charges, interest, a direct debit). The user picks an account (`5500 Bank Charges`), and the system posts a normal journal entry through `postDocument()` — *the same engine* — then auto-matches the new journal line to the statement line. This is the best moment in the demo: an unexplained NPR 1,130 becomes a ledger entry and the difference falls to zero on screen.
3. **Ignore** — an internal transfer already recorded elsewhere. Requires a reason string; excluded from the difference calculation but retained in the record.

### Closing a reconciliation

```
book_balance(as_of) = Σ(debit) − Σ(credit)
                      FROM journal_lines
                      WHERE account_id = <bank GL account>
                        AND journal_entries.status = 'posted'
                        AND journal_entries.entry_date <= as_of

bank_balance         = statement.closing_balance
difference           = bank_balance − book_balance
```

`POST /reconciliations/:id/complete` requires `difference = 0` and `unmatched_count = 0`; the DB `CHECK` refuses regardless. On completion, every matched line flips to `reconciled` and becomes ineligible for future matching.

Demo arithmetic for the sample statement above:

```
Book balance 2026-02-28, before the bank charge is recorded  =  625,850.00
Bank closing balance per statement                           =  624,720.00
Difference                                                   =    1,130.00   ✗
  → create bank-charge entry from the unmatched line          
Book balance                                                 =  624,720.00
Difference                                                   =        0.00   ✓  Reconcile
```

### Edge cases — name every one of these in the README

| Case | Handling |
|---|---|
| **Two identical amounts on the same day** | Both survive import (`row_hash` includes the row index). The matcher finds two equal-scoring candidates; the tie means neither reaches 0.90, so both are *suggested*, not auto-matched. Deliberate: a coin-flip auto-match is worse than asking. |
| **Partial payment** | Amount gate fails, so no match. Pass 4 (optional, if time) looks for a *subset* of unmatched receipts summing to the statement amount, capped at C(n,2) pairs. Beyond pairs it is subset-sum; do not go there in a week. |
| **One deposit covering several invoices** | Handled naturally: the *receipt* is one journal line for the total; allocation to invoices happened earlier and is independent of reconciliation. Worth explaining — it shows you see reconciliation and cash application as separate problems. |
| **Bank charges / interest** | Resolution path 2. |
| **Deposit in transit** (recorded in books, not yet on the statement) | Stays unmatched, and the reconciliation report lists it under "Unreconciled book items", which is precisely how a paper bank reconciliation works. |
| **Bounced cheque** | A reversal entry, then both the original and the reversal appear as book items to match. |
| **Re-uploading the same file** | `UNIQUE(bank_account_id, file_sha256)` → returns the existing statement, imports nothing. Idempotent by construction. |
| **Overlapping statement periods** | Row-level `row_hash` dedupe within a statement, plus a warning if the new period overlaps an existing one. |
| **Messy CSV** (DD/MM/YYYY vs YYYY-MM-DD, `1,25,000.00` lakh grouping, BOM, CRLF, trailing blank rows) | A normaliser with an explicit tested list of accepted date formats; strip BOM; reject ambiguous formats rather than guessing. |
| **Single signed `Amount` column instead of Debit/Credit** | Column-mapping step at upload: user maps their headers once. |
| **Matched line whose journal entry is later reversed** | Reversal clears `matched_journal_line_id` and returns the statement line to `unmatched`, provided the reconciliation is not yet completed. If it is completed, the reversal is blocked with `422 reconciled_period`. |

---

## 8. Financial reports

**The rule:** every report is a pure function of `journal_lines WHERE status = 'posted'`. No report reads a cached total, a denormalised balance, or an invoice's own numbers. Put this sentence at the top of the README.

Build **all six**. They look like six features; they are one indexed aggregation with six `GROUP BY` shapes. Total cost ≈ 5 hours backend + 6 hours UI.

### 8.1 Trial Balance — build first, on Day 3

The foundation, and your live self-check.

```sql
SELECT a.code, a.name, a.type,
       SUM(jl.debit)  AS total_debit,
       SUM(jl.credit) AS total_credit,
       GREATEST(SUM(jl.debit) - SUM(jl.credit), 0) AS debit_balance,
       GREATEST(SUM(jl.credit) - SUM(jl.debit), 0) AS credit_balance
FROM journal_lines jl
JOIN journal_entries je ON je.id = jl.journal_entry_id
JOIN accounts a         ON a.id = jl.account_id
WHERE jl.organization_id = $org
  AND je.status = 'posted'
  AND je.entry_date BETWEEN $from AND $to
GROUP BY a.id, a.code, a.name, a.type
HAVING SUM(jl.debit) <> 0 OR SUM(jl.credit) <> 0
ORDER BY a.code;
```

The response envelope carries its own integrity proof:

```json
{ "asOf": "2026-02-28",
  "rows": [ … ],
  "totals": { "debit": "720350.0000", "credit": "720350.0000" },
  "integrity": { "balanced": true, "difference": "0.0000" } }
```

The UI renders `integrity.balanced` as a green check beside the totals. A report that audits itself and shows the result on screen is a strong, specific thing to point at in a demo.

### 8.2 General Ledger / Account Ledger — Day 3

Every movement on one account with a running balance, computed by window function, not by JavaScript:

```sql
SELECT je.entry_date, je.entry_no, je.narration, d.doc_no, p.name AS party,
       jl.debit, jl.credit,
       SUM(jl.debit - jl.credit) OVER (ORDER BY je.entry_date, je.entry_no, jl.line_no
                                       ROWS UNBOUNDED PRECEDING) + $opening AS running_balance
FROM journal_lines jl … WHERE jl.account_id = $account AND je.status='posted' …
```

Add a `party_id` filter and the same endpoint becomes a **Customer Statement** — one query, two features. Every row deep-links to its source document, which is what makes the demo feel like a real product: click a number in the trial balance, land on the ledger, click a row, land on the invoice.

### 8.3 Profit & Loss — Day 5

`Income` accounts as credits-positive, `Expense` accounts as debits-positive, over a date range:

```
Revenue
  4100  Sales Revenue — Goods                    150,000.00
  4200  Sales Revenue — Services                  45,000.00
                                        Total    195,000.00
Expenses
  5300  Rent Expense                              25,000.00
  5500  Bank Charges                               1,130.00
                                        Total     26,130.00
                          ─────────────────────────────────
                          NET PROFIT              168,870.00
```

Note this is a *period* report (movements between two dates), unlike the Balance Sheet which is a *point-in-time* report (cumulative to a date). Getting that distinction right in the SQL is a small thing that a knowledgeable reviewer specifically checks.

### 8.4 Balance Sheet — Day 5

The report that proves you understand the accounting equation.

```
ASSETS
  1020  Bank — Nabil Bank Current                624,720.00
  1100  Accounts Receivable                       69,500.00
                                  Total Assets   694,220.00
LIABILITIES
  2200  VAT Payable (Output)                      25,350.00
                             Total Liabilities    25,350.00
EQUITY
  3100  Owner's Capital                          500,000.00
  3900  Current Year Earnings   (computed)       168,870.00
                                  Total Equity   668,870.00
                          ─────────────────────────────────
        TOTAL LIABILITIES + EQUITY               694,220.00
        Balanced ✓  (difference 0.00)
```

The critical mechanic: `Current Year Earnings` is **not** a stored balance. It is `Σ(income) − Σ(expense)` for the fiscal year to the report date, computed at render. Without it, assets exceed liabilities + equity by exactly the net profit, and your balance sheet does not balance. This is the single most common mistake in home-grown accounting systems — implementing it correctly, and being able to explain *why* it works that way, is disproportionately impressive.

The endpoint returns `integrity: { balanced, difference }` here too, and the test asserts `difference = 0` after every scenario.

### 8.5 AR Aging — Day 4

Buckets by `due_date` relative to `as_of`, from `documents.outstanding_amount`:

```
Customer                          Current    1–30    31–60   61–90    90+     Total
Himalayan Trek Supplies Pvt. Ltd.       —  35,600        —       —      —    35,600
Sagarmatha Hardware Suppliers      33,900       —        —       —      —    33,900
─────────────────────────────────────────────────────────────────────────────────────
TOTAL                              33,900  35,600        —       —      —    69,500
                                                        AR control account:   69,500  ✓
```

Show that reconciliation line **on screen**. The aging report is derived from the subledger; the AR control account comes from the general ledger; they agree. Nobody's tutorial project does this, and a finance-literate reviewer will notice within seconds.

### 8.6 Bank Reconciliation Summary — Day 5

Comes free with §7. Format it the way accountants read it:

```
Balance per bank statement, 2026-02-28                       624,720.00
  add:  Deposits in transit (recorded in books, not on stmt)       0.00
  less: Outstanding cheques (issued, not yet cleared)              0.00
                                                          ──────────────
Adjusted bank balance                                        624,720.00
Balance per books (GL 1020), 2026-02-28                      624,720.00
                                                          ──────────────
Difference                                                         0.00  ✓
Matched 4 · Auto-matched 3 · Manually matched 1 · Unmatched 0
```

### Performance note to put in the README

At demo scale (~40 entries) every report is a sub-millisecond aggregation over an index. The scaling answer, which you should be able to give without hesitation: at roughly 10⁵–10⁶ journal lines per organisation per year, add a `account_balances (organization_id, account_id, period YYYYMM, opening_debit, opening_credit, period_debit, period_credit)` rollup maintained inside the posting transaction, with an asynchronous recompute of affected periods on backdated entries. **You deliberately did not build it**, because the rollup introduces a correctness surface (backdating invalidates every downstream period) that is not worth carrying at this scale. Declining an optimisation with a stated threshold and a stated risk is a stronger signal than shipping one.

---

## 9. Security

### Checklist

**Authentication**
- Argon2id (`@node-rs/argon2`, m=19456, t=2, p=1). If you must use bcrypt, cost ≥ 12. Never both.
- Access token: JWT, **15 min**, `HS256` with a 32-byte secret from env, claims `{sub, jti, iat, exp}` — **no permissions in the token** (a revoked role must take effect immediately; look permissions up per request).
- Refresh token: opaque 32-byte random, **hashed** in the DB (never stored in plaintext), 7 days, `httpOnly; Secure; SameSite=Strict; Path=/api/v1/auth`.
- **Rotation with reuse detection:** each refresh issues a new token and marks the old one used, recording `family_id`. If an already-used token is presented, revoke the entire family and force re-login. That is a stolen-token signal. Forty minutes of work; asked about in real interviews.
- Access token lives **in memory** on the client, never `localStorage`. Reload triggers a silent refresh.
- Login rate limit: 5 attempts / 15 min / (IP + email). Constant-time comparison; identical error message for unknown email and wrong password.
- Logout revokes the refresh family server-side. A client-only logout is not a logout.

**Authorisation**
- `resolveTenant` middleware: `X-Organization-Id` → **active membership lookup** → context. The header alone is never trusted.
- `authorize('invoice.post')` on every mutating route; permissions read fresh from the DB per request (cached in Redis for 60 s at most).
- **Object-level**: the Prisma extension appends `organizationId` to every query. A valid UUID from another tenant returns **404, not 403** — a 403 confirms the record exists.
- RLS as second layer (Day 6 if green).

**Input and injection**
- Zod at every boundary; `.strict()` on every object schema so unknown keys are rejected rather than silently ignored (this is how mass-assignment bugs get in).
- Prisma parameterises everything. Every `$queryRaw` uses tagged-template interpolation — **never** string concatenation. Grep the repo for `$queryRawUnsafe` before submitting and make sure the count is zero.
- Report filters (date ranges, account IDs, sort columns) validated against enums/allowlists, never passed through to SQL as identifiers.
- Body size cap 1 MB (`express.json({ limit: '1mb' })`); file upload cap 2 MB.

**Transport and headers**
- `helmet()` with `hsts`, `noSniff`, `frameguard`, and a CSP on the frontend.
- CORS: explicit origin allowlist from env, `credentials: true`. Never `origin: '*'` with credentials — the browser blocks it anyway, and reviewers check.
- HTTPS everywhere in deployment; `trust proxy` set correctly so rate limiting sees real client IPs.

**Rate limiting**
- Redis-backed. Global 300/min/IP; auth endpoints 5/15min; CSV import 10/hour/org; report endpoints 60/min/org.

**Files**
- In-memory (`multer.memoryStorage()`), never written to disk. MIME validated by **magic bytes**, not by extension or the client-supplied `Content-Type`. Row cap 5,000. Never `eval` a formula cell.
- **CSV export formula injection**: any exported cell starting with `= + - @ TAB CR` gets prefixed with `'`. Almost nobody does this; it takes four lines and is a genuine, citable vulnerability class.

**Secrets and data handling**
- `.env` git-ignored, `.env.example` committed with placeholder values. Zod-validate the environment at boot and **crash on a missing secret** rather than starting with `undefined`.
- Structured logging (pino) with a redaction list: `password`, `token`, `authorization`, `refreshToken`, `pan_vat_no`. Never log request bodies on auth or payment routes.
- Bank account numbers masked at rest. No card data anywhere — say explicitly in the README that the system stores no PCI-scope data, which is itself a design decision.
- `X-Request-Id` generated per request, returned in every error envelope, written into `audit_log`. Traceability.

### The most dangerous fintech-specific mistakes — and how you avoid each

| # | Mistake | Why it is catastrophic | Your mitigation |
|---|---|---|---|
| 1 | **A query missing the tenant filter** | One customer sees another's ledger. Unrecoverable trust failure; in this domain, company-ending. | Prisma extension injects `organizationId` structurally; optional RLS behind it; a dedicated cross-tenant test suite (§10). |
| 2 | **Floating-point money** | Silent, compounding, undetectable until a reconciliation fails months later. | `NUMERIC(18,4)` + `Prisma.Decimal` + JSON as string + a lint rule banning `parseFloat` in `server/src/accounting`. |
| 3 | **Trusting client-supplied totals** | Trivial browser edit → an invoice for NPR 1 that posts as 135,600, or vice versa. | Server recomputes every line, tax and total from qty + rate; client totals are ignored entirely. |
| 4 | **Mutable posted records** | Destroys auditability. There is no way to prove what the books said last month. | Immutability triggers; corrections only via reversal or credit note. |
| 5 | **Non-idempotent payment endpoints** | Network retry or a double-click creates a second payment. Real money, real disputes. | `Idempotency-Key` persisted in the same transaction as the write. |
| 6 | **Race on payment allocation** | Two concurrent receipts each see 35,600 outstanding, both allocate, invoice goes negative. | `SELECT … FOR UPDATE` in deterministic ID order + `CHECK (outstanding_amount >= 0)`. |
| 7 | **`MAX(doc_no) + 1` numbering** | Duplicate invoice numbers under concurrency — a statutory problem, not a cosmetic one. | Locked `document_series` counter row inside the posting transaction. |
| 8 | **Permissions embedded in the JWT** | Revoking a role does nothing until the token expires. A dismissed employee keeps posting rights for 15 minutes. | Permissions resolved per request from the DB. |
| 9 | **403 instead of 404 on cross-tenant IDs** | Confirms which record IDs exist in other tenants — an enumeration oracle. | Cross-tenant reads return 404 uniformly. |
| 10 | **Emitting events inside the DB transaction** | A rolled-back invoice fires a "posted" webhook. Downstream systems now disagree with your ledger. | All side effects strictly after commit. |
| 11 | **Deleting instead of reversing** | Destroys the audit trail and desynchronises anything that referenced the deleted row. | `ON DELETE RESTRICT` everywhere financial; no delete endpoint exists for posted objects. |
| 12 | **Auto-matching on approximate amounts** | Hides real discrepancies forever behind a "reconciled" flag. | Amount equality is a hard gate; anything below 0.90 confidence requires human confirmation. |

---

## 10. Testing strategy

This section is what turns the project from "looks nice" into "this person should be interviewed". Budget **~12 hours across both developers**, most of it Day 6, with the invariant tests written on Day 3 alongside the engine.

### Setup

- **Vitest** + **Supertest**, `--pool=forks --no-file-parallelism` so tests share one Postgres.
- A real Postgres in Docker (never SQLite — you are testing triggers, `NUMERIC`, `FOR UPDATE`, and deferred constraints; SQLite has none of them).
- Reset strategy: `TRUNCATE … RESTART IDENTITY CASCADE` between tests, migrations run once. Faster and less flaky than per-test transactions, which conflict with testing transactional behaviour.
- Fixture builders: `makeOrg()`, `makeInvoice({lines})`, `makeReceipt()` returning plain objects with sane defaults. Never fixture JSON files — they rot.

### Target: ~70 tests. Realistic and enough.

| Layer | Count | What it covers |
|---|---:|---|
| Unit — posting rules (pure functions) | 14 | Every doc type, multi-line, multi-tax, rounding boundaries |
| Unit — money helpers | 8 | `round2` half-up, tax computation, allocation arithmetic |
| Unit — reconciliation scoring | 10 | Each scoring pass, tie handling, direction |
| API/integration — auth & RBAC | 10 | Login, refresh rotation, reuse detection, four roles × key routes |
| API/integration — tenant isolation | 6 | Every resource type, cross-tenant read/write |
| API/integration — accounting invariants | 12 | The list below |
| API/integration — reconciliation | 6 | Import, match, manual, create-from-line, complete |
| E2E golden path | 1 | The whole demo, asserted to the paisa |

### The invariant tests — the ones that matter

**INV-1 · Every posted entry balances.**
```
For each posting rule × 20 generated documents (fast-check property test):
  Σ debit == Σ credit, exactly, at 4 dp.
```

**INV-2 · The books balance globally after any operation sequence.**
```
Property test: generate a random sequence of 40 ops drawn from
  {create+post invoice, receipt+allocate, credit note, manual JV, reverse}
After each op:  SELECT SUM(debit) - SUM(credit) FROM journal_lines
                WHERE organization_id = org  →  MUST equal 0.0000
```
This one test catches an entire class of bugs that unit tests never reach. It is also the single best thing to point at in an interview.

**INV-3 · Subledger equals general ledger (the auditor's test).**
```
After every operation in INV-2:
  Σ documents.outstanding_amount WHERE doc_type='invoice' AND status <> 'reversed'
  ==
  balance of account 1100 Accounts Receivable   (Σ debit − Σ credit)
```

**INV-4 · The accounting equation holds.**
```
Assets − (Liabilities + Equity + Income − Expenses) == 0
computed independently from the Balance Sheet endpoint and from raw SQL
```

**INV-5 · Posted entries are immutable.**
```
prisma.$executeRaw`UPDATE journal_lines SET debit = 999 WHERE id = ${postedLine}`
  → rejects with ERRCODE restrict_violation
prisma.$executeRaw`DELETE FROM journal_entries WHERE id = ${postedEntry}`
  → rejects
DELETE /api/v1/invoices/:id  where status='posted'
  → 405 method_not_allowed (the route does not exist for posted documents)
```

**INV-6 · Unbalanced entries are impossible.**
```
Attempt a direct insert of lines totalling Dr 100 / Cr 90 inside a transaction
  → COMMIT raises 'Journal entry … is unbalanced: debits 100, credits 90'
Assert: zero rows persisted.
```

**INV-7 · Over-allocation is impossible.**
```
Invoice 135,600 → receipt 100,000 allocated (outstanding 35,600)
→ second receipt allocating 40,000 to the same invoice → 422 over_allocation
→ invoice.outstanding_amount still 35,600, no journal entry created
```

**INV-8 · Reversal nets to zero and preserves both entries.**
```
Post JV (Dr 5900 12,000 / Cr 1020 12,000) → reverse
  original.status == 'reversed', reversal.reversalOfId == original.id
  net effect on both account balances == 0
  journal_entries count == 2   (nothing deleted)
  audit_log entries == 3       (created, posted, reversed)
```

**INV-9 · Rounding never drifts.**
```
Invoice with 7 lines of qty 3 @ 1,250.50 @ 5% disc @ 13% VAT
  document.grand_total == Σ journal_lines.debit on the AR line, exactly
  document.tax_amount  == VAT Payable credit, exactly
```

**INV-10 · Period locking is enforced by the database.**
```
Lock the period containing 2026-01-31
POST an invoice dated 2026-01-20 → 422 period_locked
Bypass the service and insert a posted entry directly → trigger raises
```

**INV-11 · Document total equals journal total.**
```
For every posted document in the fixture set:
  document.grand_total == Σ(debit) on the control-account line of its journal entry
```

### Tenant isolation tests

```
ISO-1  Org A user GET  /invoices/{orgB invoice}            → 404  (not 403)
ISO-2  Org A user POST /receipts { invoiceId: orgB }       → 404
ISO-3  Org A user GET  /reports/trial-balance
         → contains zero accounts belonging to org B
ISO-4  X-Organization-Id header set to org B with an org-A-only token → 403
ISO-5  Same email, membership in A and B: switching orgs changes the data set
       and the permission set
ISO-6  Raw-SQL smoke test: with RLS on and app.current_org_id = A,
         SELECT * FROM journal_lines returns zero org-B rows
```

Run ISO-1..3 against **every** resource type via a parameterised loop. It costs twenty lines and covers the highest-severity bug class in the system.

### Permission tests

```
PERM-1  Clerk  POST /invoices              → 201   (may draft)
PERM-2  Clerk  POST /invoices/:id/post     → 403 permission_denied
PERM-3  Viewer POST /invoices              → 403
PERM-4  Viewer GET  /reports/trial-balance → 200
PERM-5  Clerk  GET  /audit-log             → 403
PERM-6  Accountant POST /journal-entries with account 1100 (control)
          → 422 manual_entry_not_allowed_on_control_account
PERM-7  Revoking a role takes effect on the NEXT request, not on token expiry
```

### Idempotency and concurrency tests

```
IDEM-1  Same Idempotency-Key posted twice → one payment; second response
        identical, header Idempotent-Replay: true
IDEM-2  Same key, different body → 422 idempotency_key_reuse
IDEM-3  Key from org A reused by org B → treated as a new request (keys are
        tenant-scoped)

CONC-1  Promise.all of 5 receipts × 30,000 against an invoice with 100,000
        outstanding → exactly 3 succeed, 2 return 422; outstanding == 10,000;
        Σ allocations == 90,000; ledger still balanced
CONC-2  Promise.all of 10 concurrent invoice posts → 10 distinct doc numbers,
        no gaps, no duplicates
CONC-3  Two concurrent allocations touching the same TWO invoices in opposite
        order → no deadlock (proves the ordered-lock rule)
```

CONC-1 is the test that makes experienced reviewers stop scrolling.

### Reconciliation tests

```
RECON-1  Import 4-line CSV → 3 auto-matched (≥0.90), 1 unmatched
RECON-2  Re-import the same file → 200, zero new lines, same statement id
RECON-3  Two identical 5,000 credits on the same date → both imported,
         both 'suggested', neither auto-matched
RECON-4  Manual match sets matched_by='manual', confidence 1.0, audit row written
RECON-5  Create-entry-from-line posts through postDocument(), auto-matches,
         difference goes 1,130 → 0
RECON-6  DIRECTION: a statement CREDIT never matches a journal CREDIT on the
         bank account (only a debit)
RECON-7  POST /reconciliations/:id/complete with difference ≠ 0 → 422; DB CHECK
         also refuses on a direct insert
RECON-8  Reversing a matched journal entry returns its statement line to
         'unmatched' (when the reconciliation is not completed)
```

### The golden E2E test

One test, asserted to the paisa, that *is* the demo:

```js
it('invoice → payment → reconciliation → reports stay consistent', async () => {
  await seedDemoOrg();                                  // Annapurna Trading, FY 2082/83

  const inv1 = await postInvoice({ party: 'HIMALAYAN', lines: [{ qty: 15, rate: '8000', account: '4100' }] });
  expect(inv1.grandTotal).toBe('135600.0000');
  expect(journalOf(inv1)).toMatchLines([
    { account: '1100', debit: '135600.0000' },
    { account: '4100', credit: '120000.0000' },
    { account: '2200', credit:  '15600.0000' },
  ]);

  const inv2 = await postInvoice({ party: 'EVEREST',    lines: [{ qty: 1,  rate: '45000', account: '4200' }] });
  const inv3 = await postInvoice({ party: 'SAGARMATHA', lines: [{ qty: 1,  rate: '30000', account: '4100' }] });

  await postReceipt({ amount: '100000', bank: '1020', allocations: [{ invoice: inv1, amount: '100000' }] });
  await postReceipt({ amount: '50850',  bank: '1020', allocations: [{ invoice: inv2, amount: '50850'  }] });

  expect(await outstanding(inv1)).toBe('35600.0000');
  expect(await accountBalance('1100')).toBe('69500.0000');          // INV-3

  const stmt = await importStatement('fixtures/nabil-jan-feb-2026.csv');
  expect(stmt.autoMatched).toBe(3);
  expect(stmt.unmatched).toBe(1);

  await createEntryFromLine(stmt.unmatchedLines[0], { account: '5500' });   // bank charges
  const rec = await completeReconciliation(stmt.id);
  expect(rec.difference).toBe('0.0000');

  const tb = await trialBalance('2026-02-28');
  expect(tb.totals.debit).toBe('720350.0000');
  expect(tb.totals.credit).toBe('720350.0000');
  expect(tb.integrity.balanced).toBe(true);

  const pl = await profitAndLoss('2025-07-17', '2026-02-28');
  expect(pl.revenue).toBe('195000.0000');
  expect(pl.expenses).toBe('26130.0000');
  expect(pl.netProfit).toBe('168870.0000');

  const bs = await balanceSheet('2026-02-28');
  expect(bs.totalAssets).toBe('694220.0000');
  expect(bs.currentYearEarnings).toBe('168870.0000');               // computed, not stored
  expect(bs.totalLiabilitiesAndEquity).toBe('694220.0000');
  expect(bs.integrity.balanced).toBe(true);

  const aging = await arAging('2026-02-28');
  expect(aging.total).toBe(await accountBalance('1100'));           // subledger == GL
});
```

Put that test file's path in the README, linked from the line "the accounting is proved, not asserted".

---

## 11. Seven-day development schedule

### Ground rules

- **Two integration checkpoints daily**: 13:00 (mid-day sync, ~15 min) and 20:00 (merge to `main`, demo the day's deliverable to each other). Non-negotiable. Skipping the evening merge is how a 7-day project becomes a 14-day project.
- **The Day 1 contract freeze is the single most important event in the week.** OpenAPI paths, request/response shapes and error codes are agreed and committed before either developer writes a feature. B then builds the entire frontend against MSW mocks generated from those schemas and is *never blocked* by A.
- **Feature freeze is the end of Day 5.** Days 6 and 7 are tests, hardening, deployment, README and rehearsal. This is not a suggestion; it is the plan.

### Day 0 — optional, 2–3 hours the evening before

Not part of the seven days, but it buys you half of Day 1. Both devs: install Node 20 / Docker / Postgres client; create the GitHub repo with branch protection; agree the folder layout; skim §5 and §6 of this plan together so neither is discovering the domain model on the clock.

---

### Day 1 — Foundations and the contract

**Developer A (Ledger & Platform)**
- Monorepo scaffold: `/server`, `/web`, `/docker-compose.yml`, ESM everywhere (`"type": "module"`), ESLint + Prettier.
- `docker compose up` brings up Postgres 16 + Redis 7 with volumes and healthchecks.
- Express skeleton (ESM, Node 20 native): `requestId` → `helmet` → `cors` → error handler → `/healthz`.
- **`server/src/lib/money.js`** (`dec`, `add`, `sub`, `mul`, `round2`, `eq`, `isZero`) + the ESLint `no-restricted-syntax` rule + `assertDecimal()`. Build these **before** the posting engine exists — retrofitting them on Day 4 means auditing every file you already wrote. One hour.
- **Prisma schema v1**: users, organizations, memberships, roles, permissions, role_permissions, fiscal_years, accounting_periods, accounts, tax_codes, journal_entries, journal_lines, audit_log, idempotency_keys.
- **Hand-written migration SQL** for the three triggers (balance, immutability, period lock) + `CHECK`s + indexes.
- Seed script: 4 system roles + permission catalogue + 28-account COA + FY 2082/83 with 12 periods.
- Write the three trigger tests immediately — they are the foundation everything else stands on.

**Developer B (Product & Interface)**
- Vite + React 18 + Tailwind + React Router.
- Design tokens (a restrained fintech palette; use tabular numerals — `font-variant-numeric: tabular-nums` — for every money column, it instantly looks like financial software).
- API client: `fetch` wrapper with auth header, org header, `Idempotency-Key` generation on mutations, error envelope parsing, silent-refresh-on-401 interceptor.
- The `<Money>` component and the Decimal-as-string response mapper — decided and written today, so no screen ever renders `{s,e,d}`.
- TanStack Query setup; MSW mock server.
- App shell: sidebar, topbar with org switcher, protected-route wrapper, toast system, `<Money>` component (accepts a string, never a number).
- Login and Register screens against mocks.

**★ Joint, 16:00–18:00 — CONTRACT FREEZE.** Write `docs/openapi.yaml` (or the Zod schema file both generate from) covering every endpoint for the week: auth, orgs, accounts, parties, invoices, receipts, allocations, journal entries, bank statements, matches, reconciliations, all six reports, audit log. Agree the error envelope and the full error-code list. Commit it. **Changes after this require a 5-minute conversation and a joint commit.**

**Checkpoint:** `docker compose up` → migrations applied → `GET /healthz` 200 → seed runs → frontend renders the shell with mocked data.
**Deliverable:** a running skeleton, a frozen contract, and a database that already refuses unbalanced journal entries.

---

### Day 2 — Identity, tenancy, masters

**Developer A**
- Register / login / refresh / logout. Argon2id. Refresh rotation + reuse detection + family revocation.
- `authenticate` → `resolveTenant` (membership-verified) → `authorize(permissionCode)` middleware chain.
- **Prisma client extension** injecting `organizationId` on every model query. This is the highest-leverage hour of the week.
- `audit_log` service + middleware, written post-commit.
- `idempotency` middleware backed by the Postgres table.
- Endpoints: `/auth/*`, `/orgs`, `/orgs/:id/members`, `/accounts`, `/parties`, `/fiscal-years`, `/periods`.
- Tests: auth flow, rotation reuse detection, ISO-1..4, PERM-1..5.

**Developer B**
- Auth wired to the real API; token-in-memory + refresh cookie; silent refresh on 401.
- Org switcher (list memberships → set active org → invalidate all queries).
- Chart of Accounts screen: tree by type, badges for control/bank accounts.
- Customers: list with search + pagination, create/edit drawer with Zod validation shared from the server package.
- Empty / loading / error states as a reusable pattern **now**, not on Day 7.

**Checkpoint 20:00:** log in as a real user → switch between two seeded orgs → see different customers and accounts in each.
**Deliverable:** multi-tenant auth working end to end, with isolation tests green.

---

### Day 3 — ★ The ledger. The most important day of the week.

If Day 3 slips, everything after it slips. Protect it.

**Developer A**
- `postDocument()` — the full pipeline from §6 including guards, locked numbering, rule dispatch, balance assertion, single transaction.
- Posting rules for `invoice` and `manual`.
- Invoice service: draft create/update (with `version` optimistic concurrency), server-side recomputation of every line, tax and total.
- Endpoints: `POST /invoices`, `PATCH /invoices/:id` (drafts only), `POST /invoices/:id/post`, `GET /invoices`, `GET /invoices/:id`, `GET /journal-entries`, `GET /journal-entries/:id`, `POST /journal-entries` (manual JV, control accounts blocked).
- **`GET /reports/trial-balance`** — build it today, so every subsequent day can be sanity-checked against it.
- Tests: INV-1, INV-6, INV-9, INV-11, PERM-6.

**Developer B**
- Invoice list: status pills, outstanding column, filters by party/status/date.
- Invoice editor: dynamic line rows, per-line account selector, live totals **displayed from a server preview call** (`POST /invoices/preview`) rather than computed in JS — a deliberate, explainable choice.
- **Invoice detail with the journal-entry panel side by side**: document on the left, `Dr | Cr` table on the right with equal totals and a green balanced check.
- Post button gated on permission; confirmation modal; status transitions reflected in the UI.
- Trial Balance screen.

**Checkpoint 20:00 — the pivotal moment:** create an invoice in the browser, click Post, and watch the balanced journal entry appear beside it. Screenshot it. That image is going at the top of your README.
**Deliverable:** the accounting core is alive and visible.

---

### Day 4 — Cash: receipts, allocation, aging

**Developer A**
- Receipt posting rule; receipt service with allocation (row-locked in ID order, sum-constrained).
- Credit note posting rule + `parent_document_id` linkage.
- `reverseEntry()` with cascade to source documents.
- Period lock enforcement wired to the API.
- `GET /reports/ar-aging`, `GET /reports/general-ledger`.
- Tests: INV-3, INV-7, INV-8, INV-10, IDEM-1..3, **CONC-1, CONC-2**.

**Developer B**
- Receipt screen: pick customer → open invoices load with outstanding amounts → allocate across several → live "unallocated remainder" indicator.
- Invoice detail: payment history section, outstanding recalculated.
- AR Aging screen with the bucket table **and the AR-control-account reconciliation line underneath**.
- General Ledger / account drill-down with running balance; clickable rows into source documents.
- Dashboard v1: total receivables, overdue, revenue this period, cash at bank.

**Checkpoint 20:00:** receive a partial payment, see the invoice flip to `partially_paid`, see AR aging update, see the trial balance still balance.
**Deliverable:** the full AR cash cycle, plus the concurrency tests that prove it holds under load.

---

### Day 5 — Banking, reconciliation, reports. FEATURE FREEZE at 20:00.

**Developer A**
- CSV parser + normaliser + column mapping + all-or-nothing validation.
- Statement import with `file_sha256` idempotency and per-row `row_hash`.
- **The matching engine**: candidate query, four-pass scoring, greedy bipartite assignment, thresholds.
- Endpoints: import, `GET /statements/:id/lines`, `POST /lines/:id/match`, `POST /lines/:id/create-entry`, `POST /lines/:id/ignore`, `POST /reconciliations`, `POST /reconciliations/:id/complete`.
- `GET /reports/profit-loss`, `GET /reports/balance-sheet` (with computed current-year earnings), `GET /reports/bank-reconciliation`.
- Tests: RECON-1..8.

**Developer B**
- Banking module: bank account list, statement upload with drag-drop and a column-mapping step.
- **Reconciliation workspace — the visual centrepiece.** Two columns: statement lines left, ledger movements right. Auto-matched pairs joined by a connector and shown collapsed; suggestions with a confidence badge and Confirm/Reject; unmatched lines with three action buttons. A sticky footer showing *Book / Bank / Difference*, with the difference in red until it hits zero, then green.
- P&L, Balance Sheet, Bank Reconciliation Summary screens.
- Report export to CSV (with the formula-injection escape).

**Checkpoint 20:00 — the whole story must run end to end** in the browser, unassisted: customer → invoice → post → journal → receipt → allocation → CSV → match → create-from-line → reconcile → TB → P&L → BS → aging.
**Deliverable:** a demoable product. **From here, no new features.**

---

### Day 6 — Hardening, tests, audit, (optional AI)

**Developer A**
- Complete the test suite to ~70 tests: property tests INV-2 and INV-4, the golden E2E, remaining isolation and permission cases.
- GitHub Actions: Postgres service, `prisma migrate deploy`, `vitest run --coverage`. Badge in README.
- Rate limiting, helmet, CORS allowlist, env validation at boot, log redaction.
- Postgres RLS as the second isolation layer, **if the suite is green by 15:00**.
- `zod-to-openapi` → Swagger UI at `/api/v1/docs`.

**Developer B**
- Audit trail screen: filterable timeline, before/after JSON diff viewer, actor + IP + request ID.
- Polish pass: every empty/loading/error state, keyboard focus, `aria-label`s on icon buttons, tabular numerals audited across every money column, right-aligned amounts, consistent negative formatting `(1,130.00)`.
- Mobile: the reconciliation workspace collapses to stacked tabs; everything else already works.
- `npm run seed:demo` producing the exact demo dataset from §14 (idempotent, re-runnable).

**Optional AI slot — only if both devs are ahead at 12:00. Hard stop at 18:00.**
A: BullMQ queue + worker + `POST /ai/extractions` + the extract→validate→retry-once→fuzzy-match-party loop, behind `FEATURE_AI=true`.
B: upload → processing → review screen with per-field confidence highlighting and Accept-as-draft.
**If it is not working at 18:00, delete the branch.** A half-finished AI feature in the repo is worse than no AI feature.

**Checkpoint:** `npm test` green, CI green, Swagger UI live, demo data reproducible from scratch.

---

### Day 7 — Ship it

**Both, morning (joint)**
- Deploy: Postgres on Neon, API on Render or Fly.io, frontend on Vercel. Run migrations + demo seed against production. Smoke-test the entire demo path on the live URL.
- README (structure in §16), architecture diagram (Excalidraw or Mermaid), the fintech-concepts table, the accounting-rules table, the "what we deliberately cut and why" section.

**Both, afternoon**
- **Bug bash**: swap machines and try to break each other's module for 90 minutes. Fix only what breaks the demo; log the rest as GitHub issues (an open issue list is a *positive* signal — it shows you know what is unfinished).
- Capture the eight screenshots from §16.
- **Rehearse the demo three times against the live deployment.** Time it. Record the best take with OBS or Loom, upload unlisted to YouTube, link from the README.
- Tag `v1.0.0`. Write resume bullets while it is fresh.

**Deliverable:** live URL, recorded demo, green CI, README a stranger can follow.

### Dependency map — read this before assigning anything

```
A: schema+triggers ──> posting engine ──> receipts/allocation ──> matching engine
        │                    │                   │                      │
        └── auth/tenancy ────┤                   │                      │
                             └── trial balance ──┴── P&L / BS ──────────┘

B: shell+design ──> auth UI ──> invoice UI ──> receipt UI ──> recon UI ──> reports UI
        └────────── all built against MSW mocks from the Day 1 contract ──────────┘

The ONLY hard blocks:
  · B cannot start real-data screens until A ships auth       (Day 2 morning)
  · B's reconciliation workspace needs real match scores      (Day 5 midday)
Everything else B builds against mocks and swaps to live endpoints in minutes.
```

---

## 12. Developer responsibilities

The conventional split is "backend dev / frontend dev". That is wrong here, because it makes the backend developer the bottleneck for the whole week. Split by **domain**, with B owning a slice of the backend that never touches the ledger.

### Developer A — Ledger & Platform

Owns: `prisma/`, `server/src/db/`, `server/src/accounting/`, `server/src/banking/`, `server/src/auth/`, `server/src/reporting/`, `server/src/middleware/`, `.github/workflows/`, `docker-compose.yml`

- Database schema, migrations, and all three triggers.
- Authentication, tenancy resolution, RBAC, the Prisma tenant extension, idempotency, audit logging.
- **The posting engine and every posting rule.**
- Payment allocation with its locking strategy.
- The reconciliation matching engine.
- All six report queries.
- The full test suite.
- CI and Docker.

Bias: correctness over throughput. If A is behind, A cuts *A's own* stretch items (RLS, AP), never a test.

### Developer B — Product & Experience

Owns: `web/` entirely, `server/src/http/routes/` for masters (parties, accounts read, statement upload endpoint), `docs/`, `scripts/seed-demo.js`

- The entire React application: shell, design system, all screens.
- The API client, error handling, idempotency-key generation, silent refresh.
- The thin CRUD routes for customers and accounts — controllers only, calling A's services. B never writes to `journal_lines`.
- The CSV upload endpoint's HTTP layer (multipart handling, size caps, MIME sniffing); A owns the parser and matcher behind it.
- Demo seed data, screenshots, README, architecture diagram, the recorded demo.

Bias: the demo path over completeness. If B is behind, B ships an uglier screen rather than a missing one — a missing screen breaks the demo, an ugly one does not.

### Shared, edited only by agreement

`packages/shared/` (Zod schemas, shared by client and server), `docs/openapi.yaml`, root config. **Rule: never edit a shared file without saying so in the team chat first.** These three paths cause 90% of merge conflicts on a two-person project.

### Pairing slots — three, deliberately scheduled

1. **Day 1, 16:00–18:00** — the contract freeze.
2. **Day 3, 15:00** — the first real invoice post, both watching. Catches contract drift while it is cheap.
3. **Day 7, afternoon** — bug bash and demo rehearsal.

---

## 13. Git workflow

Trunk-based with short-lived branches. Seven days is far too short for GitFlow; `main` + feature branches merged daily is right.

```
main (protected: PR required, CI must pass, no force-push)
 ├── feat/a-ledger-schema
 ├── feat/a-posting-engine
 ├── feat/b-invoice-ui
 └── chore/docker-compose
```

**Branch naming:** `<type>/<owner>-<slug>` — the owner letter makes it obvious at a glance whose branch it is. Types: `feat`, `fix`, `chore`, `test`, `docs`.

**Commits:** Conventional Commits, scoped by module.
```
feat(accounting): add invoice posting rule with VAT split
fix(recon): statement credit must match a bank-account debit
test(accounting): property test for global debit/credit equality
chore(ci): run migrations before vitest
```
This is not ceremony — a clean, scoped history is one of the few things a reviewer can assess in thirty seconds, and it costs nothing.

**PRs:** small (< 400 lines changed where possible), self-reviewed, one-line description of *why*. Squash-merge into `main`. Given two people and seven days, the other dev **reviews but does not block** — approve within 30 minutes or the author merges. Blocking review is a luxury for teams with slack in the schedule.

**Rhythm:**
- Branch in the morning, merge to `main` by 20:00. **Never carry a branch overnight** — if it isn't done, merge it behind a flag or stub the incomplete part.
- `git pull --rebase origin main` before every push. Linear history, no merge bubbles.
- Migrations are append-only. **Never edit a migration that has been pushed.** If the schema is wrong, write a new migration. A rewritten migration on someone else's machine is a wasted hour.

**Conflict avoidance** — the mechanism, not the hope:
- Directory ownership (§12) means the two of you rarely touch the same file.
- `packages/shared/` is edited only after a message in chat.
- `prisma/schema.prisma` is **A's file**. B requests schema changes verbally; A makes them. A single owner for the schema eliminates the worst conflict class entirely.
- Prettier + ESLint on a pre-commit hook (`lint-staged`), so no conflict is ever about formatting.

**Definition of Done** — a task is done only when *all* of these hold:
1. Code merged into `main`, CI green.
2. Zod validation on every new input boundary.
3. Tenant scoping present on every new query (or provably N/A).
4. A test exists for the happy path and for at least one failure path.
5. New endpoints appear in the OpenAPI spec.
6. Money fields are `Decimal` end to end; all arithmetic goes through `money.js`; no `number` anywhere near currency.
7. Audit log written for any state-changing action.
8. The other developer has seen it work at a checkpoint.

Print that list. Items 3 and 6 are the ones people skip at 23:00 on Day 4, and they are the two that hurt.

---

## 14. Demo scenario

### The company

**Annapurna Trading Pvt. Ltd.** — a Kathmandu-based supplier of outdoor and hospitality equipment.
PAN 601234567 · VAT registered · Base currency NPR · **Fiscal year 2082/83 (17 Jul 2025 – 16 Jul 2026)**

**Users** *(all password `Demo@2026`)*

| Email | Role | Purpose in the demo |
|---|---|---|
| `sunita@annapurnatrading.com.np` | Owner | Full access; the main narrator |
| `rajan@annapurnatrading.com.np` | Accountant | Can post and reconcile |
| `bimala@annapurnatrading.com.np` | Clerk | Can draft, **cannot post** — the RBAC moment |
| `auditor@external.com.np` | Viewer (in **Sherpa Ventures**, a second org) | The tenant-isolation moment |

A second organisation, **Sherpa Ventures Pvt. Ltd.**, exists with its own customers and ledger, purely so isolation is demonstrable rather than merely claimed.

### The data

**Opening balance** — 17 Jul 2025 (`JE-2082-0001`)
```
Dr  1020  Bank — Nabil Bank Current        500,000.00
    Cr  3100  Owner's Capital                          500,000.00
```

**Customers**

| Code | Name | Credit days |
|---|---|---:|
| CUS-001 | Himalayan Trek Supplies Pvt. Ltd. | 30 |
| CUS-002 | Everest Cafe Pvt. Ltd. | 15 |
| CUS-003 | Sagarmatha Hardware Suppliers | 30 |

**Transactions**

| Date | Doc | Detail | Amount |
|---|---|---|---:|
| 2026-01-12 | `INV-2082-0001` | Himalayan Trek — 15 trekking backpacks @ 8,000 → `4100` | 120,000 + VAT 15,600 = **135,600** |
| 2026-01-20 | `JV-2082-0002` | Office rent, Magh, paid from Nabil → `5300` | **25,000** |
| 2026-01-25 | `INV-2082-0002` | Everest Cafe — kitchen equipment installation → `4200` | 45,000 + VAT 5,850 = **50,850** |
| 2026-02-05 | `RCP-2082-0001` | Himalayan Trek, NEFT, allocated to INV-0001 (partial) | **100,000** |
| 2026-02-08 | `RCP-2082-0002` | Everest Cafe, IPS, allocated to INV-0002 (full) | **50,850** |
| 2026-02-18 | `INV-2082-0003` | Sagarmatha Hardware — hand tools consignment → `4100` | 30,000 + VAT 3,900 = **33,900** |
| 2026-02-25 | *(not yet recorded — this is the point)* | Nabil monthly service charge | **1,130** |

**The bank statement CSV** (`nabil-current-jan-feb-2026.csv`, opening 500,000.00, closing 624,720.00):

```csv
Date,Description,Reference,Debit,Credit,Balance
2026-01-20,RENT PAYMENT ANNAPURNA COMPLEX PVT LTD,CHQ 004821,25000.00,,475000.00
2026-02-05,NEFT/HIMALAYAN TREK SUPPLIES/INV-2082-0001,NEFT8834512,,100000.00,575000.00
2026-02-08,IPS/EVEREST CAFE PVT LTD,IPS2210094,,50850.00,625850.00
2026-02-25,MONTHLY SERVICE CHARGE,,1130.00,,624720.00
```

Three lines match. One does not — deliberately.

### The demo script (7–8 minutes)

**[0:00–0:30] Frame it.** "This is Ledgerline — a multi-tenant double-entry accounting platform. Everything you're about to see is derived from a general ledger; no screen reads a stored total. Here's Annapurna Trading, a Kathmandu equipment supplier, mid-way through fiscal year 2082/83."
*Dashboard: Receivables NPR 69,500 · Overdue NPR 35,600 · Cash NPR 624,720 · Revenue YTD NPR 195,000.*

**[0:30–1:15] Customer and invoice.** Create `INV-2082-0003` for Sagarmatha Hardware. 1 × 30,000 to *Sales — Goods*, VAT 13%. Point at the totals: "the browser is displaying these, not calculating them — every figure came back from a server-side recomputation. If I forge the total in devtools, the server ignores it."

**[1:15–2:15] ★ Post it.** Click **Post**. The journal entry panel opens beside the invoice:
```
Dr  1100  Accounts Receivable   Sagarmatha Hardware      33,900.00
    Cr  4100  Sales Revenue — Goods                                 30,000.00
    Cr  2200  VAT Payable (Output)                                   3,900.00
                                          ✓ Balanced  33,900.00 = 33,900.00
```
"One document, one balanced entry. The debit/credit equality isn't checked in JavaScript — it's a deferred constraint trigger in Postgres. Application code physically cannot write an unbalanced entry."

Then the immutability beat: try to edit the posted invoice — the fields are read-only, there is no delete button. Show the API return `409 already_posted`. If you have a terminal open, run the `DELETE FROM journal_entries` and let Postgres refuse it. *(30 seconds, enormous payoff.)*

**[2:15–3:15] Cash application.** Open Receipts → Himalayan Trek → their open invoice appears with 135,600 outstanding → allocate 100,000 → Post.
```
Dr  1020  Bank — Nabil Bank Current        100,000.00
    Cr  1100  Accounts Receivable                    100,000.00
```
Invoice flips to `partially_paid`, outstanding 35,600. Open **AR Aging**: 35,600 in the 1–30 bucket, 33,900 in Current, total 69,500 — "and the line underneath is the Accounts Receivable control account straight from the general ledger. 69,500. The subledger and the general ledger agree, and there's a test that asserts this after every operation in our suite."

**[3:15–5:00] ★ Reconciliation — the centrepiece.** Banking → Nabil Current → upload the CSV. The workspace fills:
- 3 lines auto-matched, joined visually to their ledger entries, confidence 0.97–1.00.
- 1 line — the NPR 1,130 service charge — sits red and unmatched.
- Footer: **Book 625,850 · Bank 624,720 · Difference 1,130.00** in red.

"The bank knows about a charge we never recorded. That's what a reconciliation is *for*." Click **Create entry from line** → account `5500 Bank Charges` → it posts through the same engine, auto-matches, and the difference animates to **0.00** in green. Click **Complete reconciliation**. "The database has a `CHECK` constraint — a reconciliation with a non-zero difference cannot be marked complete."

Optionally hover a suggestion to show the score breakdown: amount exact, date same-day, description matched the invoice number.

**[5:00–6:15] Reports, all from the ledger.**
- **Trial Balance** as of 2026-02-28 → Dr 720,350.00 = Cr 720,350.00, green ✓.
- Click AR's 69,500 → drill into the **General Ledger** → click a row → land on the source invoice. "Every number in every report traces back to a document."
- **P&L**: Revenue 195,000 − Expenses 26,130 = **Net Profit 168,870**.
- **Balance Sheet**: Assets 694,220 = Liabilities 25,350 + Equity 668,870 ✓. "Equity includes 168,870 of *Current Year Earnings* — that's the P&L. It isn't stored anywhere; the report computes it. Without it the balance sheet wouldn't balance, and that's the mistake most home-grown accounting systems make."

**[6:15–7:00] Controls: RBAC, isolation, audit.**
- Log in as **Bimala (Clerk)** — the Post button is gone. `curl` the post endpoint directly → `403 permission_denied`. "Drafting and posting are different privileges. That's separation of duties."
- Log in as the **auditor on Sherpa Ventures** and request an Annapurna invoice by ID → **404, not 403.** "A 403 would confirm the record exists. Cross-tenant reads return 404 uniformly."
- **Audit trail**: filter to today. Every action with actor, IP, request ID, and a before/after diff. Expand the reconciliation completion.

**[7:00–7:30] Close.** "Nothing here was deleted, nothing was edited after posting, and every report is a query over one ledger table. Full test suite, CI, Docker Compose, OpenAPI spec — all in the repo." Show the green CI badge and `70 passed`.

**Optional +45s (only if the AI feature shipped):** drag a supplier bill PDF in → extraction with per-field confidence → correct one low-confidence field → Accept → it becomes a *draft*, which then goes through the identical posting engine. "The model never touches the ledger. It produces a draft a human approves."

---

## 15. Recruiter-facing technical highlights

### What this project proves we know

1. **Double-entry bookkeeping implemented as a system invariant** — every document produces a balanced journal entry, enforced by a deferred Postgres constraint trigger rather than by application code.
2. **Ledger-first architecture** — documents are inputs, `journal_lines` is the record, and all six financial reports are pure queries over it. No denormalised totals, no dual sources of truth.
3. **Immutable financial records with correction-by-reversal** — posted entries cannot be updated or deleted at the database level; errors are corrected by reversing entries and credit notes, preserving a complete history.
4. **Subledger-to-general-ledger reconciliation, proved by test** — AR outstanding always equals the AR control account balance after any sequence of invoices, payments, allocations and credit notes.
5. **Correct money representation** — `NUMERIC(18,4)` throughout, decimal arithmetic end to end, JSON-serialised as strings, with a single documented rounding boundary that prevents the rounding drift between printed document and ledger that plagues accounting software.
6. **Concurrency control where money is at stake** — row-locked gapless document numbering, ordered `SELECT … FOR UPDATE` on allocation targets to prevent over-allocation and deadlock, verified by parallel-request tests.
7. **Payments-grade idempotency** — `Idempotency-Key` persisted in Postgres inside the same transaction as the financial write, so a retried request replays the original response instead of creating a second payment.
8. **Multi-tenant SaaS isolation, enforced twice** — a Prisma client extension that injects the tenant filter structurally, plus optional Postgres Row-Level Security, plus a test suite that attempts cross-tenant access on every resource and asserts 404.
9. **Role-based access control modelling separation of duties** — permission codes on routes plus object-level scope checks; a Clerk may draft an invoice but not post it, and revoking a role takes effect on the next request rather than at token expiry.
10. **A real bank reconciliation engine** — CSV ingestion with content-hash idempotency, a four-pass confidence-scored matcher (exact amount gate, date proximity, reference extraction, `pg_trgm` party-name similarity), greedy bipartite assignment, human-in-the-loop confirmation, and explicit handling of duplicates, partials, timing differences and re-imports.
11. **Financial reporting derived from source data** — Trial Balance, General Ledger, P&L, Balance Sheet, AR Aging and Reconciliation Summary, including a correctly computed current-year-earnings figure that makes the balance sheet balance.
12. **Compliance-grade audit trail** — append-only log with actor, action, before/after JSONB, IP and request ID, written after commit so rolled-back operations leave no false record.
13. **Property-based testing of accounting invariants** — randomised operation sequences asserting global debit/credit equality and the accounting equation, rather than only example-based endpoint tests.
14. **Security engineered for financial data** — Argon2id, refresh-token rotation with reuse detection and family revocation, permissions resolved per request, Zod validation with strict schemas at every boundary, Redis-backed rate limiting, magic-byte MIME validation, CSV formula-injection escaping, and log redaction.
15. **Deliberate, documented scope decisions** — inventory valuation, POS, multi-currency and balance rollups were consciously excluded, each with a stated reason and the threshold at which we would add it.

---

## 16. Portfolio presentation

### Title
**Ledgerline — Double-Entry Accounting & Bank Reconciliation Platform**

### One-line description
> A multi-tenant financial platform where every invoice, payment and bank charge posts to an immutable double-entry general ledger, and every report — Trial Balance, P&L, Balance Sheet, AR Aging — is derived from that ledger rather than stored beside it.

### Resume bullets

Pick three. Every one carries a number or a specific mechanism, because bullets without either are invisible.

- Built a multi-tenant double-entry accounting platform (React, Node/Express, PostgreSQL) where all six financial reports are derived from a single immutable ledger; enforced debit/credit equality with a deferred Postgres constraint trigger and proved it with property-based tests over randomised operation sequences.
- Designed a financial posting engine handling invoices, credit notes, receipts and multi-invoice payment allocation with row-level locking and Postgres-persisted idempotency keys, eliminating duplicate payments and over-allocation under concurrent load (verified by parallel-request integration tests).
- Implemented a bank reconciliation engine that ingests CSV statements and matches them against ledger movements using a four-pass confidence-scored algorithm (exact-amount gating, date proximity, reference extraction, trigram party-name similarity) with greedy bipartite assignment and human-in-the-loop confirmation.
- Enforced tenant isolation at two layers — a Prisma client extension injecting tenant scope into every query and Postgres Row-Level Security — validated by a cross-tenant test suite asserting 404 (not 403) on every resource type.
- Achieved ~70 automated tests including accounting invariants (subledger-to-GL agreement, the accounting equation, posted-record immutability), RBAC, idempotency and concurrency, running against real PostgreSQL in GitHub Actions CI.

### README structure

```
# Ledgerline
> one-line description  ·  [Live demo] [5-min video] [API docs]
  badges: CI · coverage · Node · PostgreSQL · License

## The core idea            ← 4 sentences: documents in, ledger is truth,
                              reports are queries, nothing is ever deleted
## Demo                     ← GIF: post an invoice → the journal entry appears
                              Credentials for all four demo users
## Quick start              ← git clone && docker compose up && npm run seed:demo
                              (three commands, tested from a clean machine)
## Architecture             ← the ASCII/Mermaid diagram + the layering rule
## The accounting engine    ← the posting-rules table + one worked example
                              with real numbers
## Financial integrity      ← the three triggers, with the actual SQL
## Bank reconciliation      ← the scoring formula + the edge-case table
## Multi-tenancy & RBAC     ← the two isolation layers + the permission matrix
## Testing                  ← what the invariant tests assert, and why
                              link straight to the golden E2E test file
## API                      ← Swagger link + the error-code table
## Fintech concepts         ← the §3 mapping table (this is the section
                              recruiters actually read)
## What we deliberately cut ← inventory, POS, multi-currency, balance rollups,
                              each with a reason and a "we'd add it at X scale"
## Tech stack & decisions   ← WHY Prisma, WHY NUMERIC, WHY a modular monolith
## Roadmap / known issues   ← honesty reads as maturity
```

The **"What we deliberately cut"** section is the highest-value paragraph in the whole README. Almost nobody writes one, and it is the fastest way to signal engineering judgement rather than enthusiasm.

### Screenshots to capture (eight, in this order)

1. Invoice detail with the journal-entry panel beside it, totals equal, green check. **This is the hero image.**
2. The reconciliation workspace mid-flow: matched pairs connected, one red unmatched line, the difference showing 1,130.00.
3. The same workspace after resolution: difference 0.00 in green.
4. Trial Balance with `720,350.00 = 720,350.00` and the integrity check.
5. Balance Sheet showing Assets = Liabilities + Equity with the computed current-year earnings highlighted.
6. AR Aging with the "= AR control account" reconciliation line underneath.
7. The audit trail with a before/after diff expanded.
8. Terminal split-screen: `70 passed` on one side, Postgres rejecting `DELETE FROM journal_entries` on the other.

### What to explain in interviews

Have a crisp answer ready for each. These are the questions this project *invites*:

- **"Why is the balance check a database trigger and not application code?"** → Because application code has more than one path to the database (services, migrations, scripts, a future admin tool), and the invariant must hold across all of them. Defence in depth, and the constraint documents itself.
- **"Why NUMERIC and not floats?"** → Binary floating point cannot represent 0.1; errors compound silently across thousands of rows and surface months later as a trial balance that won't foot. Then mention the JSON-as-string detail, because that is the part people forget.
- **"Why reversal instead of deletion?"** → Auditability and referential integrity. A deleted entry breaks every report that was already run against it and every downstream reference; a reversal is a fact about what happened, in the record.
- **"How do you prevent cross-tenant data leaks?"** → Two layers, and — critically — the fact that you tested it, on every resource, and return 404 rather than 403.
- **"What happens if a payment request is retried?"** → Idempotency key in Postgres, in the same transaction. Then explain why *not* Redis: two systems that can disagree about whether money moved.
- **"Two people click Post on the same invoice simultaneously?"** → `SELECT … FOR UPDATE` on the document row, status guard inside the lock, second request gets `409 already_posted`. Reference CONC-2.
- **"Why a monolith?"** → Two developers, seven days, one transactional boundary around the ledger. Distributed transactions across a "ledger service" and an "invoicing service" would have been strictly worse. Then name the seam where you *would* split first.
- **"Why don't you cache report totals?"** → Deliberate. At this scale the aggregation is sub-millisecond; a rollup table introduces backdating-invalidation bugs. Name the threshold (~10⁵ lines/org/year) and the design you'd use.
- **"What would you do differently?"** → Have a real answer. Suggestions: event-sourcing the ledger; adding `pgvector` for description-based match learning; moving `outstanding_amount` from a denormalised column to a computed view once the query cost is measured.

---

## 17. Scope sanity check

Brutal honesty, as requested.

### What is realistically completable in 7 days

The MUST HAVE list, if — and only if — three things hold: the Day 1 contract freeze actually happens, both developers are working roughly 7–8 focused hours a day, and neither of you spends a day "just improving" a screen that already works. That is roughly 95 hours of work against ~105 available. Ten hours of margin for a seven-day project is *thin*. It works only because Day 6 and Day 7 contain no new features.

If you are also learning Prisma or Zod while building, subtract a full day and cut AP and the dashboard immediately.

### What you should absolutely not attempt

- **Inventory / stock valuation / COGS.** The single largest trap in this document. Perpetual weighted-average valuation with backdated transactions is a week of work and a month of bugs. Ship service-and-goods invoicing with no inventory leg and say so proudly.
- **Multi-currency with FX revaluation.** Carry the columns; use NPR at 1.0. Unrealised gain/loss is real accounting depth that you cannot do justice to in seven days, and a half-implementation is worse than a clean absence.
- **PDF generation.** Half a day, for a rectangle. Browser print stylesheet if you must.
- **A custom Chart of Accounts builder.** Seed it. Nobody is impressed by a tree editor.
- **Bikram Sambat date conversion.** Needs a lookup table for correctness. Label the fiscal year as a string and move on.
- **Anything with a real external integration** — banks, email, SMS, IRD. Each is a live-demo failure waiting to happen.
- **Event sourcing / CQRS.** Correct instinct, wrong week. Mention it as future work.
- **Microservices.** Actively worse here. Say why in the interview.

### Likely time sinks — the honest list

| Sink | Why it eats a day | Defence |
|---|---|---|
| **Prisma + raw SQL triggers** | Prisma cannot express deferred constraint triggers; the first `--create-only` migration edit is confusing. | Do it Day 1, first thing, before anything depends on it. Two hours, budgeted. |
| **Decimal handling everywhere** | `Prisma.Decimal` serialises to a JSON object by default, so amounts arrive at the frontend as `{s,e,d}` and nothing renders. | Solve it once on Day 1 with a global `superjson`-style serialiser or an explicit `.toFixed(4)` mapper. Write one `<Money>` component and never think about it again. |
| **Untyped money arithmetic** | `Prisma.Decimal` mixed with a JS number produces a string or `NaN`, silently, and the first symptom is a trial balance that won't foot on Day 5. | The `money.js` module, the ESLint rule, and `assertDecimal()` in every posting rule — all built on Day 1, before the engine exists. |
| **The reconciliation UI** | Two-column linked-pair layouts with connectors are genuinely hard CSS. | Ship a simple stacked list with a "matched to →" label on Day 5. Add visual connectors on Day 7 *only if* everything else is done. |
| **Auth edge cases** | Refresh rotation + reuse detection + silent refresh interacts badly with React StrictMode double-effects and concurrent 401s. | One request-deduplicating refresh promise in the API client. Budget three hours; do not improvise it on Day 6. |
| **Docker on Day 7** | "It works locally" → managed Postgres SSL, migration on boot, CORS origins, cold starts. | Deploy a hello-world API + DB on **Day 2 evening**, 45 minutes. Then Day 7 is a redeploy, not a first deploy. This one tip saves more time than any other in this document. |
| **Chasing pixel polish** | Infinite, and invisible to a recruiter who watches a 5-minute video. | Tabular numerals, right-aligned amounts, consistent spacing. Stop there. |
| **The AI feature** | Prompt iteration is unbounded. | Hard 18:00 stop on Day 6. Delete the branch if it's not working. |

### Highest recruiter ROI, ranked

1. **The invoice → journal entry panel.** Four seconds of screen time, and it communicates the entire architecture. Cheapest signal in the project.
2. **The reconciliation workspace resolving a difference to zero.** The most *product-like* moment; makes the system feel real rather than academic.
3. **The invariant test suite** — specifically INV-2 (property test over random operation sequences) and CONC-1 (parallel over-allocation). This is what separates you from every other candidate with an "accounting app".
4. **Trigger-enforced immutability**, demonstrated by Postgres refusing a `DELETE` on camera.
5. **The tenant-isolation test suite returning 404 not 403.**
6. **The "what we deliberately cut" README section.** Free, and reads as seniority.
7. Balance Sheet with computed current-year earnings.
8. AI extraction. *Genuinely last* — impressive, but the least differentiating, because everyone's 2026 portfolio has an LLM in it. Your ledger does not.

### If you fall behind on Day 4 — cut in this exact order

1. **AI extraction.** Gone. No discussion.
2. **Accounts Payable** (bills, supplier payments) — the mirror-image posting rules stay in the code and the tests; the UI never gets built.
3. **The dashboard.** Replace with a redirect to the invoice list. Costs nothing in the demo.
4. **Postgres RLS.** Keep the Prisma extension; write the RLS design into the README as future work with the reason.
5. **Credit notes UI.** Keep the API and the tests; demo it via Swagger if asked.
6. **CSV export** of reports.
7. **Balance Sheet.** *(Last resort — this hurts, because computed current-year earnings is a strong signal. Trial Balance + P&L + AR Aging still carries the story.)*

**Never cut, at any point, for any reason:** the posting engine, the three triggers, the invariant tests, tenant isolation, or the reconciliation happy path. Those five *are* the project. Everything else is presentation.

### The Day 5 gate — what must be true at 20:00

Run this checklist. If any line fails, cut from the list above until they all pass, then stop adding features.

```
□ Log in, switch between two organisations, see different data in each
□ Create a customer
□ Create an invoice, see server-computed totals
□ Post it; a balanced journal entry appears; the invoice becomes read-only
□ Record a receipt; allocate it partially; outstanding updates correctly
□ Upload the demo CSV; at least 2 lines auto-match
□ Resolve the unmatched line by creating an entry from it
□ Complete the reconciliation with difference = 0.00
□ Trial Balance renders and balances
□ P&L and AR Aging render with correct numbers
□ Audit trail shows the day's actions with actor and timestamp
□ npm test passes (even if the suite is not yet complete)
```

Twelve lines. If all twelve are true at the end of Day 5, you have a strong portfolio project and two clear days to make it look like one. If they are not, Days 6–7 become a rescue operation and the deployment, the tests and the README — the three things recruiters actually check first — get squeezed.

### Final honest assessment

This scope is achievable, but it has no slack for exploration. The two decisions that determine whether it ships are made in the first thirty-six hours: **freeze the API contract on Day 1**, and **get the ledger posting on Day 3**. Everything downstream is assembly.

And if you finish Day 5 with the twelve-line checklist green and nothing else, you already have a better portfolio project than 95% of what crosses a hiring manager's desk. The remaining days are about making sure they can *see* it.
