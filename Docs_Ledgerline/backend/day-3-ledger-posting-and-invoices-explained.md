# Day 3 — The Ledger: The Posting Engine, Invoices, and the Trial Balance

This document explains everything built in the Day 3 session, from zero. It uses the actual
LedgerLine codebase as the source of truth. Every code block below is copied from a real file in
this repository, and every file path is exact.

**Status at time of writing:** this work is **not yet committed**. The last commit on `main` is
`6e66a09 — day 2 documentation update`. Running `git status` shows the Day 3 work as modified and
untracked files:

```
 M backend/prisma/schema.prisma
 M backend/src/app.js
 M backend/src/db/tenant-extension.js
 M backend/src/db/triggers.test.js
 M backend/src/test/helpers.js
?? backend/prisma/migrations/20260814050525_day3_documents_and_posting/
?? backend/prisma/migrations/20260814062857_day3_taxcode_accounts_and_entry_series/
?? backend/src/lib/accounting/
?? backend/src/lib/invoices/
?? backend/src/routes/invoices.js
?? backend/src/routes/invoices.test.js
?? backend/src/routes/journal-entries.js
?? backend/src/routes/reports.js
```

**Test status:** 75 tests passing across 10 test files. Lint clean.

The 7-day plan calls Day 3 "★ The ledger. The most important day of the week." and adds: *"If Day 3
slips, everything after it slips. Protect it."* This document explains why that is true.

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

### Where we started

After Day 2, the backend could answer the question *"who are you, which company are you in, and are
you allowed to do this?"*. It could list accounts and customers. But it could not do the one thing
an accounting system exists to do: **record a financial fact**.

The database had a `JournalEntry` table and a `JournalLine` table with triggers protecting them,
built on Day 1. But nothing in the application ever wrote to them. There was no invoice. There was
no way to turn "we sold 15 backpacks for 8,000 rupees each" into a ledger record.

After this session, that whole path exists and works end to end.

### The core idea you must understand first

Before any code makes sense, you need one accounting concept. It is the thesis of the entire
project, and section 6 explains it more slowly, but here is the short version.

**Documents are inputs. The ledger is the truth.**

An invoice is a piece of paper you send a customer. It is *evidence*. It is not the accounting
record. The accounting record is a **journal entry** — a list of accounts, each with an amount, where
the total of one column exactly equals the total of the other column.

When you "post" an invoice, the system reads the invoice and writes a journal entry. From that
moment the invoice is frozen — you cannot edit it — and every report in the system is computed from
journal entries, never from invoices.

Here is the actual journal entry this system produces for a 15-backpack invoice (this is real output
from the running code, captured during testing):

```
JE-2082-0001   2025-07-20   Sales Invoice INV-2082-0001
────────────────────────────────────────────────────────────────────
  Dr  1100  Accounts Receivable  (party: Himalayan Trek)   135,600.00
      Cr  4100  Sales Revenue                                        120,000.00
      Cr  2200  VAT Payable (Output)                                  15,600.00
────────────────────────────────────────────────────────────────────
                              Σ Dr 135,600.00   Σ Cr 135,600.00   ✓
```

"Dr" means debit, "Cr" means credit. The two columns are equal. That equality is enforced in three
independent places in this codebase, which is what section 4 spends most of its time explaining.

### The seven problems this session solved

**Problem 1 — There was no way to represent an invoice at all.**

The database had no `documents` table, no `document_lines` table. There was nowhere to put "customer
X, dated Y, these five line items". We added four new tables and extended two existing ones.

*Why it matters:* without a document table there is nothing to post *from*. This was the blocking
prerequisite for everything else in the day.

**Problem 2 — Money arithmetic silently corrupts itself.**

In ordinary JavaScript, `0.1 + 0.2` equals `0.30000000000000004`. If you compute an invoice total
that way, the printed invoice and the ledger disagree by a fraction of a paisa, and a trial balance
that should foot to zero foots to 0.0001. Day 1 had already created `dec()` helpers for this. What
was missing was the *rounding policy*: where exactly do you round, and in what order.

We built `line-math.js`, which rounds at each named boundary — discount, then tax, then line total —
and then sums the already-rounded values. Never the other way around.

*Why that solution:* the plan (§6, worked example 2) is emphatic about this. Summing unrounded values
and rounding once at the end produces a document total that disagrees with the sum of the printed
lines. Test INV-9 exists specifically to catch it.

**Problem 3 — Turning a document into ledger lines needed to be testable.**

The rule "an invoice debits Accounts Receivable and credits Revenue and VAT" is business logic. If
that logic is tangled up with database calls, you can only test it by writing to a database, which is
slow and awkward.

We built `posting-rules.js` as **pure functions** — functions that do no database work, read no clock,
and use no randomness. They take a plain object describing a document and return a plain array
describing journal lines. They run in under a millisecond and are trivial to test.

**Problem 4 — Posting must be all-or-nothing, and must never double-post.**

Posting an invoice does six different writes: allocate a document number, allocate an entry number,
create the journal entry, create its lines, update the document status, link the two. If the process
crashes halfway, you must end up with *none* of those, not three of them.

Worse: if a user double-clicks "Post", two requests arrive at almost the same moment. Both read the
invoice as a draft. Both post it. You now have two journal entries for one invoice and your books are
wrong by exactly one invoice.

We built `post-document.js`, which wraps everything in one database transaction and takes a **row
lock** on the invoice as its very first action. Section 4.8 and section 6 explain both concepts from
zero.

**Problem 5 — Invoice numbers must never duplicate.**

The obvious way to number invoices is "find the highest number so far, add one". Under two
simultaneous requests, both read the same highest number, and both produce `INV-2082-0007`. In Nepal
(and most places) duplicate invoice numbers are a **statutory** problem — a legal one, not a cosmetic
bug.

We built `document-numbering.js`, which keeps a counter in a dedicated table row and locks that row
inside the posting transaction.

**Problem 6 — Clients cannot be trusted with totals.**

If the browser sends `grandTotal: 135600` and the server believes it, anyone can edit that number in
their browser's developer tools and post an invoice for one rupee.

We built the invoice service so that the server accepts only quantity, unit price, discount
percentage, and which tax code applies. Every total is recomputed server-side, every time. A test
sends `grandTotal: '1.00'` and asserts the stored value is `135600.00`.

**Problem 7 — There was no way to check that the books balance.**

We built `GET /reports/trial-balance`, which sums every debit and every credit across all posted
journal lines and reports whether they are equal. It is the self-check that every subsequent day gets
tested against.

### Everything created

**The accounting engine** (`backend/src/lib/accounting/`)
- `line-math.js` — the rounding policy: how one invoice line's numbers are computed
- `posting-rules.js` — pure functions turning a document into journal lines
- `errors.js` — typed errors the routes map to HTTP status codes
- `chart-of-accounts.js` — the one hardcoded account code in the system
- `period-lock.js` — "is this accounting month still open?"
- `fiscal-year.js` — "which financial year does this date fall in?"
- `document-numbering.js` — gapless, collision-proof numbering
- `post-document.js` — **the single entry point for posting any document**
- `post-manual-entry.js` — posting a hand-typed journal entry

**The invoice service** (`backend/src/lib/invoices/`)
- `invoice-service.js` — creating and editing invoice drafts, and previewing totals

**HTTP routes** (`backend/src/routes/`)
- `invoices.js` — create, list, read, edit, preview, and post invoices
- `journal-entries.js` — post a manual journal entry, list and read entries
- `reports.js` — the trial balance

**Tests**
- `backend/src/lib/accounting/line-math.test.js` — 5 tests
- `backend/src/lib/accounting/posting-rules.test.js` — 5 tests
- `backend/src/lib/accounting/post-document.test.js` — 7 tests
- `backend/src/lib/invoices/invoice-service.test.js` — 13 tests
- `backend/src/routes/invoices.test.js` — 13 tests

**Migrations**
- `backend/prisma/migrations/20260814050525_day3_documents_and_posting/`
- `backend/prisma/migrations/20260814062857_day3_taxcode_accounts_and_entry_series/`

### Everything modified

- `backend/prisma/schema.prisma` — added `Document`, `DocumentLine`, `DocumentSeries`, `EntrySeries`;
  added `status`, `sourceId`, `postedAt`, `postedById` to `JournalEntry`; added `organizationId` and
  `partyId` to `JournalLine`; added `type`, `outputAccountId`, `inputAccountId` to `TaxCode`
- `backend/src/db/tenant-extension.js` — four new models added to the tenant-scoped list
- `backend/src/app.js` — three new routers mounted
- `backend/src/db/triggers.test.js` — updated for the new required `JournalLine.organizationId`
- `backend/src/test/helpers.js` — `resetDb()` extended to clear the new tables

---

## 2. How it relates to the 7-day plan

This session is **Day 3 — ★ The ledger. The most important day of the week.**
(`ledgerline-7-day-plan_1.md`, line 1453.)

### The plan's Day 3 goals for Developer A (backend)

> - `postDocument()` — the full pipeline from §6 including guards, locked numbering, rule dispatch, balance assertion, single transaction.
> - Posting rules for `invoice` and `manual`.
> - Invoice service: draft create/update (with `version` optimistic concurrency), server-side recomputation of every line, tax and total.
> - Endpoints: `POST /invoices`, `PATCH /invoices/:id` (drafts only), `POST /invoices/:id/post`, `GET /invoices`, `GET /invoices/:id`, `GET /journal-entries`, `GET /journal-entries/:id`, `POST /journal-entries` (manual JV, control accounts blocked).
> - **`GET /reports/trial-balance`** — build it today, so every subsequent day can be sanity-checked against it.
> - Tests: INV-1, INV-6, INV-9, INV-11, PERM-6.

### The plan's Day 3 goals for Developer B (frontend)

> - Invoice list: status pills, outstanding column, filters by party/status/date.
> - Invoice editor: dynamic line rows, per-line account selector, live totals **displayed from a server preview call** (`POST /invoices/preview`) rather than computed in JS — a deliberate, explainable choice.
> - **Invoice detail with the journal-entry panel side by side**: document on the left, `Dr | Cr` table on the right with equal totals and a green balanced check.
> - Post button gated on permission; confirmation modal; status transitions reflected in the UI.
> - Trial Balance screen.

This session covered **Developer A only**. The frontend work is untouched.

### Plan objective → What we built → Why it matters

| Plan objective | What we built | Why it matters |
|---|---|---|
| `postDocument()` with guards, locked numbering, rule dispatch, balance assertion, single transaction | `backend/src/lib/accounting/post-document.js` | The plan (§6) says: *"Every financial document — every one, without exception — goes through `postDocument()`. There is no second code path that writes to `journal_entries`."* One door means one place to enforce every rule. |
| Posting rules for `invoice` and `manual` | `backend/src/lib/accounting/posting-rules.js` | Pure functions, so the business rule "an invoice debits AR" is testable in milliseconds without a database. |
| Invoice service with `version` optimistic concurrency | `backend/src/lib/invoices/invoice-service.js` | Two people editing the same draft must not silently overwrite each other. The second one gets a 409 and is told to reload. |
| Server-side recomputation of every line, tax and total | `resolveLines()` in the same file | Mistake #3 on the plan's danger list: *"Trivial browser edit → an invoice for NPR 1 that posts as 135,600."* |
| The eight endpoints | `routes/invoices.js`, `routes/journal-entries.js` | This is the API surface Developer B builds the invoice editor against. |
| `POST /invoices/preview` | `previewInvoice()` + the preview route | The plan explicitly wants live editor totals to come from the server, not from JavaScript, so there is exactly one implementation of the rounding rules. |
| Manual JV with control accounts blocked | `backend/src/lib/accounting/post-manual-entry.js` | Test PERM-6. A control account like Accounts Receivable must only ever move through document posting, never a hand-typed entry, or the subledger stops agreeing with the ledger. |
| `GET /reports/trial-balance` | `backend/src/routes/reports.js` | The plan: build it today *"so every subsequent day can be sanity-checked against it."* It is the daily proof the books balance. |
| Tests INV-1, INV-6, INV-9, INV-11, PERM-6 | Five test files, 43 new tests | These are the invariant tests — the ones the plan says convert "looks nice" into "this person should be interviewed". |

### The plan's Day 3 checkpoint

> **Checkpoint 20:00 — the pivotal moment:** create an invoice in the browser, click Post, and watch
> the balanced journal entry appear beside it.

The backend half of this is complete and proven by `backend/src/routes/invoices.test.js`, which
performs exactly that sequence over real HTTP against real PostgreSQL and asserts the returned
journal entry balances. The *browser* half is Developer B's work and is not done.

### What is completed

- The full posting pipeline, working end to end over HTTP
- Invoice drafts: create, edit with optimistic concurrency, preview, list, read
- Posting invoices, with all guards enforced
- Manual journal entries with control-account blocking
- The trial balance report, self-verifying
- All five named tests, plus 38 more

### What is intentionally incomplete, and why

| Deferred item | Scheduled for | Why it waits |
|---|---|---|
| Posting rules for `credit_note`, `receipt`, `bill`, `supplier_payment` | Day 4 (receipts, credit notes) and later | Each needs its own permission code and, for receipts, the allocation machinery. Day 3's job was to prove the *engine* works with one document type. |
| `payment_allocations` table | Day 4 | Nothing allocates payments yet, so the table would be dead weight. The plan puts allocation on Day 4. |
| `reverseEntry()` | Day 4 | Needs `reversalOfId` / `reversedById` columns **and** a change to the immutability trigger (see the warning below). |
| `GET /reports/general-ledger` | Day 4 | The plan lists it under Day 4 for Developer A, even though §8.2 is headed "Day 3". Only the trial balance is in the Day 3 task list. |
| `Idempotency-Key` on `POST /invoices` | Day 4 | `backend/src/lib/idempotency/run-idempotent.js` was built on Day 2 but is not yet wired to any route. Tests IDEM-1..3 are Day 4. |
| Property tests INV-2, INV-4 | Day 6 | The plan schedules `fast-check` property testing for the hardening day. |

### One warning for Day 4

The immutability trigger created on Day 1 blocks **every** `UPDATE` to `JournalEntry`
unconditionally. Here is the actual trigger, from
`backend/prisma/migrations/20260811144919_init/migration.sql`:

```sql
CREATE OR REPLACE FUNCTION block_journal_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Journal entries are immutable. Post a reversal entry instead.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journal_entry_immutable
  BEFORE UPDATE OR DELETE ON "JournalEntry"
  FOR EACH ROW
  EXECUTE FUNCTION block_journal_mutation();
```

Day 4 needs `reverseEntry()` to set the original entry's `status` to `reversed` and write a
`reversedById` back-reference. That is an `UPDATE`, so this trigger will refuse it. The plan (§5)
anticipates this and specifies a trigger that permits exactly that one transition and nothing else.
**The trigger will need relaxing on Day 4.** This does not affect any Day 3 functionality — Day 3
only ever inserts journal entries, never updates them.

---

## 3. Files created and modified

This section is a map. Section 4 explains the code itself.

### 3.1 The accounting engine

Everything in `backend/src/lib/accounting/`. This directory is new.

---

**File:** `backend/src/lib/accounting/line-math.js`

**Status:** Created

**Purpose:** Computes the money numbers for one invoice line — discount, taxable amount, tax, and
line total — and adds those numbers up across all lines to produce document totals.

**Why does this file exist?** Because *where you round* changes the answer. This file is the single
place that decides rounding order, so no other file has to think about it.

**What calls it:** `backend/src/lib/invoices/invoice-service.js`.
**What it calls:** `backend/src/lib/money.js` (built on Day 1).

---

**File:** `backend/src/lib/accounting/posting-rules.js`

**Status:** Created

**Purpose:** Converts a document into a list of journal lines. Contains one function per document
type.

**Why does this file exist?** So the accounting rule — "an invoice debits Accounts Receivable for the
total and credits Revenue and VAT" — lives in one readable place, with no database code around it.

**What calls it:** `post-document.js` and `post-manual-entry.js`.
**What it calls:** `backend/src/lib/money.js`. Nothing else. It touches no database.

---

**File:** `backend/src/lib/accounting/errors.js`

**Status:** Created

**Purpose:** Creates error objects tagged with an HTTP status code and a short machine-readable code.

**Why does this file exist?** The business logic needs to say "this is the client's fault, 409
conflict" without knowing anything about Express. These helpers carry that information so the
existing error handler in `app.js` can translate it into an HTTP response.

**What calls it:** every file in the accounting engine, plus `invoice-service.js` and the routes.

---

**File:** `backend/src/lib/accounting/chart-of-accounts.js`

**Status:** Created

**Purpose:** Holds one constant: `AR_ACCOUNT_CODE = '1100'`.

**Why does this file exist?** Posting an invoice must debit Accounts Receivable, so the code has to
know which account that is. Every other account in the system is chosen by the user or looked up
from a tax code. This is the only hardcoded account code, and giving it its own file makes that
obvious rather than burying it in the middle of the posting logic.

---

**File:** `backend/src/lib/accounting/period-lock.js`

**Status:** Created

**Purpose:** Checks that the accounting month containing a given date is still open for posting.

**Why does this file exist?** Accountants "close" a month once it has been reported. After that,
nothing may be posted into it, or last month's published figures would change retroactively.

**What calls it:** `post-document.js`, `post-manual-entry.js`.

---

**File:** `backend/src/lib/accounting/fiscal-year.js`

**Status:** Created

**Purpose:** Finds which financial year a date belongs to.

**Why does this file exist?** Both document numbers and entry numbers restart each fiscal year, so
almost everything needs this lookup. Receipts and bills on later days will need the identical query.

---

**File:** `backend/src/lib/accounting/document-numbering.js`

**Status:** Created

**Purpose:** Allocates the next `INV-2082-0001`-style document number and the next `JE-2082-0001`-style
entry number, safely under concurrency.

**Why does this file exist?** To make duplicate numbers structurally impossible. See Problem 5 above.

**What calls it:** `post-document.js` (both functions), `post-manual-entry.js` (entry numbers only).

---

**File:** `backend/src/lib/accounting/post-document.js`

**Status:** Created

**Purpose:** The single entry point that turns a draft document into a posted journal entry.

**Why does this file exist?** This is the heart of the application. The plan is explicit that there
must be exactly one code path that writes to the journal, because every rule — permission, period
lock, balance, numbering — has to be enforced somewhere that cannot be bypassed.

**What calls it:** `routes/invoices.js`.
**What it calls:** `posting-rules.js`, `document-numbering.js`, `period-lock.js`, `errors.js`,
`chart-of-accounts.js`, `money.js`, and the Prisma client.

---

**File:** `backend/src/lib/accounting/post-manual-entry.js`

**Status:** Created

**Purpose:** Posts a journal entry that a human typed directly, with no source document.

**Why does this file exist?** A manual journal entry has no `Document` row — the `docType` enum in the
schema has no `manual` member, deliberately, because a manual entry *is* the record rather than
evidence for one. So it cannot reuse `postDocument()`, which begins by locking a document row. It
repeats the same guards in the correct order and adds the control-account check.

---

### 3.2 The invoice service

**File:** `backend/src/lib/invoices/invoice-service.js`

**Status:** Created

**Purpose:** Creates and edits invoice drafts, and previews totals without saving.

**Why does this file exist?** To separate "building a document" from "posting a document". Drafts are
freely editable and have no accounting consequence at all. Only posting touches the ledger.

**What calls it:** `routes/invoices.js`.
**What it calls:** `line-math.js`, `fiscal-year.js`, `errors.js`, `money.js`, Prisma.

---

### 3.3 HTTP routes

**File:** `backend/src/routes/invoices.js`

**Status:** Created

**Purpose:** Six HTTP endpoints for the invoice lifecycle.

**What it calls:** `invoice-service.js`, `post-document.js`, the Day 2 middleware chain, and
`serializeJournalEntry` imported from `journal-entries.js`.

---

**File:** `backend/src/routes/journal-entries.js`

**Status:** Created

**Purpose:** Three endpoints for journal entries, plus the two serializer functions that
`invoices.js` reuses.

---

**File:** `backend/src/routes/reports.js`

**Status:** Created

**Purpose:** The trial balance endpoint.

---

### 3.4 Database

**File:** `backend/prisma/schema.prisma`

**Status:** Modified

Four new models (`DocumentSeries`, `Document`, `DocumentLine`, `EntrySeries`), three new enums
(`DocType`, `DocStatus`, `EntryStatus`), one more enum (`TaxCodeType`), and new columns on
`JournalEntry`, `JournalLine`, and `TaxCode`.

---

**Migration:** `backend/prisma/migrations/20260814050525_day3_documents_and_posting/migration.sql`

**Status:** Created, then hand-edited

Prisma generated it; we edited it twice — once to backfill existing rows before making a column
required, once to add `CHECK` constraints and a partial index that Prisma cannot express. Section 4.14
explains both edits.

---

**Migration:** `backend/prisma/migrations/20260814062857_day3_taxcode_accounts_and_entry_series/migration.sql`

**Status:** Created

Added the tax-code account links and the `EntrySeries` table, both of which turned out to be missing
from the plan's schema once we tried to write the posting rule.

---

**File:** `backend/src/db/tenant-extension.js`

**Status:** Modified — four model names added

---

**File:** `backend/src/app.js`

**Status:** Modified — three routers mounted

---

### 3.5 Tests

| File | Status | Tests | Kind |
|---|---|---|---|
| `backend/src/lib/accounting/line-math.test.js` | Created | 5 | Unit — no database |
| `backend/src/lib/accounting/posting-rules.test.js` | Created | 5 | Unit — no database |
| `backend/src/lib/accounting/post-document.test.js` | Created | 7 | Integration — real PostgreSQL |
| `backend/src/lib/invoices/invoice-service.test.js` | Created | 13 | Integration — real PostgreSQL |
| `backend/src/routes/invoices.test.js` | Created | 13 | End-to-end — real HTTP + real PostgreSQL |
| `backend/src/db/triggers.test.js` | Modified | 7 | Integration — unchanged count, updated for new schema |
| `backend/src/test/helpers.js` | Modified | — | Shared setup |

---

## 4. The code explained from zero

This is the longest section. It goes through every file in teaching order — simplest first, building
up to the posting pipeline, which depends on all the others.

### 4.1 File: `backend/src/lib/accounting/line-math.js`

**Status:** Created

**Purpose:** Takes the raw facts about one invoice line — how many, at what price, with what discount
and what tax rate — and produces the four money numbers that line needs. Then adds those numbers up
across all lines.

**Why does this file exist?** Because there is more than one arithmetically defensible way to compute
an invoice, and they give different answers. This file fixes one policy and applies it everywhere.

**How does it connect to other files?** It imports the `Decimal` helpers from
`backend/src/lib/money.js`, which was built on Day 1. It is imported by
`backend/src/lib/invoices/invoice-service.js`. It touches no database and knows nothing about HTTP.

```js
import { add, sub, mul, round2, dec } from '../money.js';

// Pure: no I/O, no clock, no randomness. Round at each named boundary
// (discount, tax, line total), then sum the rounded values — never sum
// unrounded values and round at the end (§6 worked example 2).
export function computeLine({ quantity, unitPrice, discountPct = 0, taxRate = 0 }) {
  const gross = mul(quantity, unitPrice);

  const discountAmount = round2(gross.times(discountPct).dividedBy(100));
  const taxableAmount = round2(sub(gross, discountAmount));
  const taxAmount = round2(mul(taxableAmount, taxRate));
  const lineTotal = round2(add(taxableAmount, taxAmount));

  return { discountAmount, taxableAmount, taxAmount, lineTotal };
}

// Document totals are the sum of already-rounded line values, so grandTotal
// always equals Σ debit on the journal entry, exactly (§6, test INV-11).
export function sumLines(lines) {
  return lines.reduce(
    (totals, line) => ({
      subtotal: add(totals.subtotal, add(line.taxableAmount, line.discountAmount)),
      discountAmount: add(totals.discountAmount, line.discountAmount),
      taxableAmount: add(totals.taxableAmount, line.taxableAmount),
      taxAmount: add(totals.taxAmount, line.taxAmount),
      grandTotal: add(totals.grandTotal, line.lineTotal),
    }),
    { subtotal: dec(0), discountAmount: dec(0), taxableAmount: dec(0), taxAmount: dec(0), grandTotal: dec(0) }
  );
}
```

#### Reading this code from zero

**Concept — why ordinary numbers cannot hold money**

Type this into any browser console:

```js
0.1 + 0.2
// 0.30000000000000004
```

This is not a JavaScript bug. Computers store numbers in binary — base 2 — and the fraction `0.1`
cannot be written exactly in base 2, in the same way `1/3` cannot be written exactly in base 10
(`0.3333...` never terminates). Every arithmetic operation adds a tiny error.

For most programs this is harmless. For accounting it is fatal, because errors accumulate and a trial
balance that must be exactly zero comes out as `0.0000000001`.

The solution is a **decimal type**: a way of storing numbers that keeps track of digits rather than
binary fractions. Prisma ships one, called `Decimal`. Day 1 wrapped it in
`backend/src/lib/money.js`:

```js
export function dec(value) {
  return new Decimal(value);
}
export function add(a, b) {
  return dec(a).plus(dec(b));
}
```

So `add('0.1', '0.2')` gives exactly `0.3`.

The important consequence for reading this file: **you cannot use `+`, `-`, `*` on money here**. You
must call `add`, `sub`, `mul`. Writing `a + b` on two Decimals would convert both to strings and glue
them together, which is a genuinely nasty bug because it produces no error.

---

**Generic syntax — destructuring a parameter object with defaults**

```js
function f({ a, b = 0 }) { ... }
f({ a: 1 });          // b is 0
f({ a: 1, b: 5 });    // b is 5
```

Normally a function receives its arguments in order: `f(1, 5)`. **Destructuring** lets a function
receive one object and pull named values out of it. The `= 0` part supplies a **default** used when
that key is missing or `undefined`.

**In this project:**

```js
export function computeLine({ quantity, unitPrice, discountPct = 0, taxRate = 0 }) {
```

The caller writes:

```js
computeLine({ quantity: 3, unitPrice: '1250.50', discountPct: 5, taxRate: '0.13' })
```

Two benefits over positional arguments. First, the call site is self-documenting — you cannot mix up
which number is the price and which is the discount. Second, lines with no discount and no tax can
simply omit those keys, and the defaults make them zero.

---

**The core of the file — rounding at each boundary**

```js
  const gross = mul(quantity, unitPrice);

  const discountAmount = round2(gross.times(discountPct).dividedBy(100));
  const taxableAmount = round2(sub(gross, discountAmount));
  const taxAmount = round2(mul(taxableAmount, taxRate));
  const lineTotal = round2(add(taxableAmount, taxAmount));
```

`round2` comes from `money.js` and rounds to 2 decimal places using **ROUND_HALF_UP** — meaning
exactly half rounds upward, so `187.575` becomes `187.58`, not `187.57`.

Notice that `round2` appears on **every line**. That is the entire point of the file. Walk through the
plan's worked example — quantity 3 at 1,250.50 with 5% discount and 13% VAT:

```
gross     = 3 × 1250.50            = 3,751.50
discount  = 3751.50 × 0.05         =   187.575    → ROUND HALF-UP 2dp → 187.58
taxable   = 3751.50 − 187.58       = 3,563.92
vat       = 3563.92 × 0.13         =   463.3096   → ROUND HALF-UP 2dp → 463.31
lineTotal = 3563.92 + 463.31       = 4,027.23
```

The critical step is the third line. The tax is computed from `3563.92` — the **already-rounded**
taxable amount — not from the unrounded `3563.925`. If you kept full precision internally and rounded
only at the end, you would get a different final answer, and the number printed on the customer's
invoice would not match the number in the ledger.

`backend/src/lib/accounting/line-math.test.js` asserts these exact four values.

Two calls here use Decimal methods directly rather than the `money.js` wrappers:
`gross.times(discountPct).dividedBy(100)`. This is **method chaining** — `gross.times(...)` returns a
new Decimal, and `.dividedBy(100)` is then called on that result. It reads as one left-to-right
sentence. There is no `div` helper in `money.js`, which is why the raw method is used.

- **Data in:** four values describing a line.
- **Data out:** an object of four `Decimal`s: `{ discountAmount, taxableAmount, taxAmount, lineTotal }`.
- **Who calls it:** `resolveLines()` inside `invoice-service.js`.
- **What it calls:** only `money.js`.

---

**Generic syntax — `reduce`, the accumulator loop**

```js
const total = [1, 2, 3].reduce((runningTotal, item) => runningTotal + item, 0);
// 6
```

`reduce` walks an array and carries a value along. It takes two arguments: a function, and a starting
value. The function receives the value carried so far plus the current item, and whatever it returns
becomes the value carried into the next step.

`0` at the end is the **initial value** — what the running total is before any item is seen.

**In this project:**

```js
export function sumLines(lines) {
  return lines.reduce(
    (totals, line) => ({
      subtotal: add(totals.subtotal, add(line.taxableAmount, line.discountAmount)),
      ...
    }),
    { subtotal: dec(0), discountAmount: dec(0), ... }
  );
}
```

Here the carried value is not a number but an **object holding five running totals**. Each step
returns a brand-new object with each total advanced by one line's contribution.

One piece of syntax that trips up beginners:

```js
(totals, line) => ({ subtotal: ... })
```

The parentheses around `{` are required. Without them, JavaScript reads `{` as the start of a
function body rather than an object, and the function returns nothing. This is a classic silent bug —
`reduce` would produce `undefined` with no error message.

`subtotal` is computed as taxable + discount, which recovers the pre-discount gross figure.

**Why the initial value is `dec(0)` and not `0`:** an earlier version used the string `'0'`. It worked
for every non-empty list, because `add()` converts its arguments anyway. But for an **empty** list
`reduce` never calls the function at all and returns the initial value untouched — so `sumLines([])`
returned raw strings where every caller expected `Decimal` objects. Using `dec(0)` makes the return
type identical in every case.

**What happens at runtime.** When someone saves an invoice with two lines, `resolveLines` calls
`computeLine` once per line, producing two objects of four Decimals each. `sumLines` then walks those
two objects and produces the five document totals. Because it adds up values that were *already*
rounded, the document's `grandTotal` is exactly the sum of the printed line totals — which is what
test INV-11 checks, and what makes the trial balance foot.

---

### 4.2 File: `backend/src/lib/accounting/posting-rules.js`

**Status:** Created

**Purpose:** Turns a document into the list of journal lines that represent it in the ledger.

**Why does this file exist?** This is where the actual accounting rule lives. The plan (§6) describes
`POSTING_RULES` as *"a map from `doc_type` to a pure function `(document) => JournalLine[]`. Pure
means: no I/O, no clock, no randomness — which makes them trivially unit-testable, and that is the
point."*

**How does it connect to other files?** Imported by `post-document.js` and `post-manual-entry.js`.
Imports only `money.js`. It never touches the database — every account ID it needs is handed to it by
its caller.

```js
import { add, dec, isZero } from '../money.js';

// One journal line. Only Dr AR / Dr Bank lines carry partyId — everything
// else is GL-only (§6: "The AR and Bank lines carry party_id").
function line({ accountId, debit = 0, credit = 0, description, partyId = null }) {
  return { accountId, debit: dec(debit), credit: dec(credit), description, partyId };
}

// (document) => JournalLine[]. Pure: no I/O, no clock, no randomness — the
// caller resolves every account id (AR control account, each line's tax
// output account) before calling in. That is what makes this trivially
// unit-testable and is the entire point (§6).
//
// Expected `document` shape:
//   { partyId, grandTotal, arAccountId,
//     lines: [{ accountId, taxableAmount, taxAmount, taxAccountId, description }] }
function invoice(document) {
  const lines = [
    line({
      accountId: document.arAccountId,
      debit: document.grandTotal,
      partyId: document.partyId,
      description: 'Accounts Receivable',
    }),
  ];

  for (const docLine of document.lines) {
    lines.push(
      line({
        accountId: docLine.accountId,
        credit: docLine.taxableAmount,
        description: docLine.description,
      })
    );
  }

  // Multiple document lines can share one tax output account (e.g. every
  // 13%-VAT line posts to the same 2200 account) — group so the entry
  // carries one VAT credit per account, not one per invoice line.
  const taxByAccount = new Map();
  for (const docLine of document.lines) {
    if (!docLine.taxAccountId || isZero(docLine.taxAmount)) continue;
    taxByAccount.set(docLine.taxAccountId, add(taxByAccount.get(docLine.taxAccountId) ?? 0, docLine.taxAmount));
  }
  for (const [taxAccountId, taxAmount] of taxByAccount) {
    lines.push(line({ accountId: taxAccountId, credit: taxAmount, description: 'VAT Payable (Output)' }));
  }

  return lines.map((l, i) => ({ ...l, lineNumber: i + 1 }));
}

// User-supplied lines, passed straight through. Control-account blocking
// (PERM-6) and balance are enforced by the caller/guards and by
// postDocument's own assertion — this rule trusts its input, same as every
// other pure rule.
function manual(document) {
  return document.lines.map((docLine, i) => ({
    accountId: docLine.accountId,
    debit: dec(docLine.debit ?? 0),
    credit: dec(docLine.credit ?? 0),
    partyId: docLine.partyId ?? null,
    description: docLine.description,
    lineNumber: i + 1,
  }));
}

export const POSTING_RULES = { invoice, manual };
```

#### Reading this code from zero

**Concept — debits and credits, without the mysticism**

Every journal line names an account and puts an amount in one of two columns: debit or credit. The
rule for an entry to be valid is simply that the two columns total the same.

For a sales invoice for 135,600 (120,000 of goods plus 15,600 VAT):

- The customer now owes us 135,600 → **debit** Accounts Receivable 135,600
- We earned 120,000 of revenue → **credit** Sales Revenue 120,000
- We collected 15,600 of VAT that we owe the government → **credit** VAT Payable 15,600

One debit of 135,600 against credits of 120,000 + 15,600 = 135,600. Balanced.

Notice the VAT: it never belonged to the business. It was collected on the government's behalf, so it
is a *liability* — money owed — not income. That is why it credits a separate account.

---

**Concept — a pure function**

A **pure function** is one that (a) returns the same output for the same input every time, and
(b) changes nothing outside itself. No database reads, no `Date.now()`, no random numbers, no writing
to files.

Purity is why this file is worth having. Testing `invoice()` requires no database, no server, and no
setup — you hand it an object and check the array that comes back. The test file runs all five of its
cases in about 9 milliseconds.

The cost is that this function cannot look anything up. It does not know which account is Accounts
Receivable, or which account a tax code posts to. So its **caller** must resolve all of that first and
pass the IDs in. That contract is written out in the comment above the function.

---

**Generic syntax — a helper that builds a consistent object**

```js
function line({ accountId, debit = 0, credit = 0, description, partyId = null }) {
  return { accountId, debit: dec(debit), credit: dec(credit), description, partyId };
}
```

Every journal line must have both a `debit` and a `credit` field, because the database column is
`NOT NULL`. A line that is a debit still needs `credit: 0`. This helper means no call site has to
remember that — you supply the one you care about, and the other defaults to zero and is converted to
a `Decimal`.

`{ accountId, debit: ..., }` uses **shorthand property syntax**: writing `accountId` alone is the
same as writing `accountId: accountId`.

`partyId = null` deserves note. Only the Accounts Receivable line carries a customer ID. Why? Because
the AR line is the one that says *this specific customer owes us money*. With `partyId` stored on it,
"show me everything customer X owes" becomes a `WHERE` clause on the journal lines table rather than
a whole separate subsystem. The revenue and VAT lines are not customer-specific — they are just
totals — so they carry `null`.

---

**Building the debit line first**

```js
  const lines = [
    line({
      accountId: document.arAccountId,
      debit: document.grandTotal,
      partyId: document.partyId,
      description: 'Accounts Receivable',
    }),
  ];
```

An array is created containing exactly one line: the AR debit for the whole invoice total. Everything
after this pushes credits onto the same array.

---

**Generic syntax — `for...of` and `push`**

```js
for (const item of arrayOfItems) {
  results.push(transform(item));
}
```

`for...of` walks an array giving you each element in turn. `push` appends to the end of an array.

**In this project:**

```js
  for (const docLine of document.lines) {
    lines.push(
      line({
        accountId: docLine.accountId,
        credit: docLine.taxableAmount,
        description: docLine.description,
      })
    );
  }
```

One credit per invoice line, each to *that line's own* revenue account, for that line's amount
excluding tax.

Those revenue lines are deliberately **not** merged. If an invoice has one line of goods (account
4100) and one line of services (4200), the journal entry keeps them separate. That is what makes the
Profit & Loss report on Day 5 interesting instead of a single lump.

---

**Generic syntax — `Map`, a lookup table**

```js
const m = new Map();
m.set('key', 'value');
m.get('key');            // 'value'
m.get('missing');        // undefined
for (const [k, v] of m) { ... }   // walk every entry
```

A `Map` stores key-value pairs. It is like a plain object but keeps insertion order reliably and
allows any type as a key.

**In this project — the one place tax lines *are* merged:**

```js
  const taxByAccount = new Map();
  for (const docLine of document.lines) {
    if (!docLine.taxAccountId || isZero(docLine.taxAmount)) continue;
    taxByAccount.set(docLine.taxAccountId, add(taxByAccount.get(docLine.taxAccountId) ?? 0, docLine.taxAmount));
  }
```

Reading it piece by piece:

- `if (!docLine.taxAccountId || isZero(docLine.taxAmount)) continue;` — `!x` means "x is missing or
  falsy". `||` means "or". `continue` means "skip the rest of this loop iteration and move to the
  next item". So: lines with no tax account, or with zero tax, are skipped entirely.
- `taxByAccount.get(id) ?? 0` — `??` is the **nullish coalescing operator**: use the left value unless
  it is `null` or `undefined`, in which case use the right. The first time an account is seen,
  `get` returns `undefined`, so the running total starts at `0`.
- The whole line therefore reads: *set this account's running tax total to whatever it was, plus this
  line's tax.*

Then:

```js
  for (const [taxAccountId, taxAmount] of taxByAccount) {
    lines.push(line({ accountId: taxAccountId, credit: taxAmount, description: 'VAT Payable (Output)' }));
  }
```

`const [a, b] of map` is **array destructuring** — each entry of a Map arrives as a two-element array
`[key, value]`, and this pulls them into two named variables.

**Why merge tax but not revenue?** Because a five-line invoice all at 13% VAT would otherwise produce
five separate credits to the same VAT account, all with the same description. That is noise. The
revenue lines carry genuinely different information (different accounts); the tax lines do not. And
the skip-if-zero rule means an exempt line produces no VAT line at all, rather than a meaningless
zero-value row — which matters, because the database has a constraint rejecting lines that are
neither a debit nor a credit.

---

**Generic syntax — `map` with spread, to add a field to every element**

```js
items.map((item, index) => ({ ...item, position: index + 1 }));
```

`map` builds a new array by transforming each element. The second parameter of the callback is the
element's index, counting from 0. `...item` is **spread syntax** — copy every property of `item` into
this new object — and then `position` is added.

**In this project:**

```js
  return lines.map((l, i) => ({ ...l, lineNumber: i + 1 }));
```

Numbers the lines 1, 2, 3 rather than 0, 1, 2, because the database has a
`UNIQUE(journalEntryId, lineNumber)` constraint and humans count from one.

- **Data in:** a document object with `partyId`, `grandTotal`, `arAccountId`, and a `lines` array.
- **Data out:** an array of journal-line objects, always balanced, always numbered from 1.
- **Who calls it:** `post-document.js`.

---

**The `manual` rule**

```js
function manual(document) {
  return document.lines.map((docLine, i) => ({
    accountId: docLine.accountId,
    debit: dec(docLine.debit ?? 0),
    credit: dec(docLine.credit ?? 0),
    ...
  }));
}
```

For a manual journal entry the human has already decided every account and amount, so there is no
rule to apply — the lines pass through, converted to `Decimal` and numbered.

This function trusts its input completely. It does not check the balance and does not check for
control accounts. Both of those are the caller's job, in `post-manual-entry.js`. Keeping the rule
trusting and the guards in the caller is consistent: *every* posting rule in this system is a pure
transformation, and *every* guard lives in the pipeline.

---

**Generic syntax — exporting a lookup object**

```js
export const POSTING_RULES = { invoice, manual };
```

Shorthand again — this is `{ invoice: invoice, manual: manual }`. The caller can now write
`POSTING_RULES[docType](document)` to pick a rule by name at runtime. Adding credit notes on Day 4
means adding one function and one key here.

---

### 4.3 File: `backend/src/lib/accounting/errors.js`

**Status:** Created

**Purpose:** Builds error objects that carry an HTTP status code and a short error code.

**Why does this file exist?** When `postDocument` discovers the invoice is already posted, it needs to
communicate "this is the client's fault, status 409, code `already_posted`". It must do that without
importing Express, because it is business logic, not web code. These helpers attach the information
to the error itself and let the route layer deal with HTTP.

**How does it connect to other files?** Used by every accounting file and every new route. The errors
it produces are consumed by the error handler already present in `backend/src/app.js`.

```js
// Matches the repo convention already used by authenticate/authorize/resolve-tenant:
// a plain Error with .status and .code, not a class hierarchy (app.js's error
// handler reads err.status/err.code/err.message directly).
function taggedError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

export const notFound = (message = 'Not found') => taggedError(404, 'not_found', message);
export const conflict = (code, message) => taggedError(409, code, message);
export const businessRule = (code, message) => taggedError(422, code, message);
export const forbidden = (message = 'Missing required permission') => taggedError(403, 'forbidden', message);
export const internal = (message) => taggedError(500, 'internal_error', message);
```

#### Reading this code from zero

**Concept — what an error is in JavaScript**

`new Error('something went wrong')` creates an error object holding a message and a stack trace.
`throw err` stops the current function immediately and hands the error to the nearest enclosing
`try/catch`. If nothing catches it, the program (or, in Express, the request) fails.

An `Error` is an ordinary object, so you can attach extra properties to it:

```js
  const err = new Error(message);
  err.status = status;
  err.code = code;
```

This is precisely what the Day 2 middleware already did by hand. From
`backend/src/middleware/authorize.js`:

```js
      const err = new Error('Missing required permission');
      err.status = 403;
      err.code = 'forbidden';
```

This file simply stops that pattern being retyped everywhere.

---

**Concept — HTTP status codes, and why 404 vs 409 vs 422 matters**

An HTTP response carries a three-digit number saying what kind of outcome it was:

| Code | Name | Used here for |
|---|---|---|
| 403 | Forbidden | You are logged in, but you lack the permission |
| 404 | Not Found | No such record — *including* records that exist but belong to another company |
| 409 | Conflict | The record is not in a state where this makes sense (already posted; someone else edited it) |
| 422 | Unprocessable Entity | The request was well-formed but breaks a business rule (period locked, control account) |
| 500 | Internal Server Error | The server itself is broken — a bug, not the user's fault |

The 404-versus-403 distinction is a **security** decision inherited from Day 2. If asking for another
company's invoice returned 403 ("forbidden"), that would confirm the invoice exists. An attacker
could enumerate IDs and learn which ones are real. Returning 404 for both "does not exist" and
"belongs to someone else" leaks nothing.

The 409-versus-422 split is about *why* the request cannot proceed. 409 means the target's current
state conflicts with the request. 422 means the request itself violates a rule of the business.

---

**Generic syntax — arrow functions and default parameters**

```js
const double = (n) => n * 2;
```

An **arrow function** is a compact way to write a function. When the body is a single expression with
no braces, that expression is automatically returned.

```js
export const notFound = (message = 'Not found') => taggedError(404, 'not_found', message);
```

`message = 'Not found'` supplies a default, so `notFound()` works with no arguments and
`notFound('Invoice not found')` overrides the text.

Note the shape difference between the helpers: `notFound` and `forbidden` take only a message,
because their error code never varies. `conflict` and `businessRule` take `(code, message)`, because
there are several distinct reasons for each — `already_posted` and `version_conflict` are both 409
but mean different things, and the frontend needs to tell them apart.

**What happens at runtime.** Suppose someone posts an already-posted invoice.
`postDocument` calls `conflict('already_posted', 'Document ... is already posted')`, which returns an
`Error` with `status = 409`. The code throws it. The `throw` aborts the database transaction, so
PostgreSQL rolls back. The route handler's `catch (err)` calls `next(err)`, handing it to Express.
The error handler in `app.js` reads `err.status` and responds:

```json
{ "error": { "code": "already_posted", "message": "...", "requestId": "..." } }
```

with HTTP status 409. Verified live during the audit.

---

### 4.4 File: `backend/src/lib/accounting/chart-of-accounts.js`

**Status:** Created

**Purpose:** Names the one account code the posting engine has to know by heart.

```js
// Fixed by convention across the whole plan (§5 seed set, every worked
// example): the AR control account is always 1100. Nothing else in the
// system hardcodes an account code — tax accounts come from tax_codes,
// everything else from the account the document line names.
export const AR_ACCOUNT_CODE = '1100';
```

#### Reading this code from zero

**Why this exists as a file at all.** The invoice posting rule must debit Accounts Receivable. Every
other account involved is discovered at runtime: each invoice line names its own revenue account, and
the VAT account comes from the tax code's `outputAccountId`. Only AR is fixed by convention.

Putting it in a one-line file with a comment makes that fact visible. If the constant sat inline in
`post-document.js`, a reader would have no way to know whether other codes were hardcoded elsewhere.

**The tradeoff, stated honestly.** This assumes every organization uses `1100` for Accounts
Receivable, which the seed script guarantees but a real product would not. The more flexible design
is a per-organization settings table mapping roles ("the AR account", "the retained earnings
account") to account IDs. That is a reasonable Day 7 improvement; it is not needed to prove the
engine works, and the plan's account numbering is fixed across all its worked examples.

`post-document.js` looks the account up by this code and throws a 500 if it is missing, because an
organization without an AR account is a broken setup, not a user error.

---

### 4.5 File: `backend/src/lib/accounting/period-lock.js`

**Status:** Created

**Purpose:** Refuses to let anything be posted into an accounting month that has been closed.

**Why does this file exist?** Once a month is reported to management or to the tax authority, its
numbers must stop moving. If someone could post a January invoice in March, January's published
profit would silently change.

**How does it connect to other files?** Called by `post-document.js` and `post-manual-entry.js`. It
also returns the period it found, which the callers need — every journal entry stores which period it
belongs to.

```js
import { businessRule } from './errors.js';

// Service-layer check first (for the nice error message), DB trigger second
// (because the service layer can be bypassed). Belt and braces (§6).
export async function assertPeriodOpen(tx, { organizationId, docDate }) {
  // AccountingPeriod has no organizationId column — scope through its parent
  // fiscal year instead, same as GET /periods (masters.js).
  const period = await tx.accountingPeriod.findFirst({
    where: {
      fiscalYear: { organizationId },
      startDate: { lte: docDate },
      endDate: { gte: docDate },
    },
  });

  const dateStr = docDate.toISOString().slice(0, 10);
  if (!period) throw businessRule('no_period', `No accounting period covers ${dateStr}`);
  if (!period.isOpen) throw businessRule('period_locked', `Accounting period containing ${dateStr} is locked`);

  return period;
}
```

#### Reading this code from zero

**Concept — fiscal years and accounting periods**

A **fiscal year** is a business's financial year. In Nepal it runs mid-July to mid-July, and the seed
data uses `2082/83` (a Bikram Sambat year) running 2025-07-16 to 2026-07-15.

Each fiscal year is divided into twelve **accounting periods** — months. The seed names them
`Shrawan`, `Bhadra`, `Ashwin`, and so on. Each period has `isOpen`, a true/false flag. Closing a
period sets it to false.

---

**Concept — `async` and `await`**

Talking to a database takes time — a few milliseconds, but that is an eternity for a CPU. JavaScript
does not sit and wait; it goes off and does other work, then comes back when the answer arrives.

A function marked `async` is allowed to use `await`. `await` means "pause here until this finishes,
then continue with the result". An `async` function always returns a **promise** — an object
representing a result that is not ready yet. The caller either `await`s it in turn or attaches
`.then()`.

```js
export async function assertPeriodOpen(tx, { organizationId, docDate }) {
  const period = await tx.accountingPeriod.findFirst({ ... });
```

Without `await`, `period` would hold a promise object rather than a period, and `period.isOpen` would
be `undefined` — a bug that produces no error and silently skips the check.

---

**The `tx` parameter — why the database handle is passed in**

Every function in the accounting engine takes `tx` as its first argument instead of importing
`prisma` directly. `tx` is a **transaction handle**. Section 6 explains transactions properly; the
short version is that a transaction is a group of database operations that all succeed or all fail
together.

For the period check to be meaningful, it must run *inside the same transaction* as the posting it is
guarding. Passing `tx` in is what guarantees that. This pattern is called **dependency injection** —
the function does not choose its own database connection, it is handed one.

---

**Reading a Prisma query**

```js
  const period = await tx.accountingPeriod.findFirst({
    where: {
      fiscalYear: { organizationId },
      startDate: { lte: docDate },
      endDate: { gte: docDate },
    },
  });
```

Prisma is an **ORM** — a library that lets you query the database with JavaScript objects instead of
writing SQL by hand. `findFirst` returns the first matching row, or `null` if there is none.

- `startDate: { lte: docDate }` — `lte` means "less than or equal to". The period must start on or
  before the document's date.
- `endDate: { gte: docDate }` — `gte` means "greater than or equal to". It must end on or after it.
- Together: find the period that *contains* this date.
- `fiscalYear: { organizationId }` — a filter on a **related** table. `AccountingPeriod` has no
  `organizationId` column of its own; it belongs to a `FiscalYear`, which does. Prisma turns this into
  a SQL join.

That last point matters for security. The Day 2 tenant extension automatically adds
`organizationId` to queries — but only for models that *have* that column. `AccountingPeriod` does
not, so the extension cannot help, and this filter has to be written by hand. The existing
`GET /periods` route in `masters.js` has the same comment for the same reason.

The rough SQL Prisma generates:

```sql
SELECT * FROM "AccountingPeriod" p
JOIN "FiscalYear" fy ON fy.id = p."fiscalYearId"
WHERE fy."organizationId" = $1
  AND p."startDate" <= $2
  AND p."endDate"   >= $2
LIMIT 1;
```

---

**The two failure cases**

```js
  if (!period) throw businessRule('no_period', `No accounting period covers ${dateStr}`);
  if (!period.isOpen) throw businessRule('period_locked', `Accounting period containing ${dateStr} is locked`);
```

Two distinct problems with two distinct codes. *No period at all* usually means the organization has
not set up its calendar for that year. *Period locked* means the calendar exists and the month is
deliberately closed. The frontend should say different things in each case.

`` `...${dateStr}...` `` is a **template literal** — backticks allow embedding values with `${...}`
instead of gluing strings with `+`.

`docDate.toISOString().slice(0, 10)` turns a JavaScript `Date` into `2025-08-20`.
`toISOString()` produces `2025-08-20T00:00:00.000Z`, and `.slice(0, 10)` keeps the first ten
characters.

---

**Belt and braces — the same rule enforced twice**

This service-layer check is not the only defence. Day 1 created a database trigger that enforces the
identical rule, in `backend/prisma/migrations/20260811144919_init/migration.sql`:

```sql
CREATE TRIGGER journal_entry_period_open
  BEFORE INSERT ON "JournalEntry"
  FOR EACH ROW
  EXECUTE FUNCTION assert_period_open();
```

Why have both? The plan answers directly: *"Service-layer check first (for the nice error message),
trigger second (because the service layer can be bypassed)."*

The service check produces `422 period_locked` with a readable message. The trigger produces a raw
PostgreSQL exception. But the trigger cannot be bypassed by *any* route — including a future admin
tool, a migration script, or someone typing SQL by hand. Application code has many paths to the
database; the constraint must hold on all of them.

- **Data in:** a transaction handle, an organization ID, and a date.
- **Data out:** the `AccountingPeriod` row, or a thrown error.
- **Who calls it:** `post-document.js`, `post-manual-entry.js`.

---

### 4.6 File: `backend/src/lib/accounting/fiscal-year.js`

**Status:** Created

**Purpose:** Finds the fiscal year containing a date.

**Why does this file exist?** Document numbers and entry numbers both restart each fiscal year, so
the numbering code needs to know the year before it can allocate. Extracting it avoids repeating the
query in the invoice service, the posting pipeline, and the manual-entry path — and receipts and
bills on later days need the identical lookup.

```js
import { businessRule } from './errors.js';

export async function findFiscalYearForDate(tx, organizationId, date) {
  const fiscalYear = await tx.fiscalYear.findFirst({
    where: { organizationId, startDate: { lte: date }, endDate: { gte: date } },
  });
  if (!fiscalYear) {
    throw businessRule('no_fiscal_year', `No fiscal year covers ${date.toISOString().slice(0, 10)}`);
  }
  return fiscalYear;
}
```

#### Reading this code from zero

Structurally this is the same "find the row whose range contains this date" query as
`period-lock.js`, one level up the hierarchy: an organization has fiscal years, and a fiscal year has
periods.

`FiscalYear` *does* have an `organizationId` column, so the filter is written directly rather than
through a relation. It is also in the tenant extension's list, meaning that when this runs during a
real HTTP request the extension would add the filter anyway. Writing it explicitly is deliberate:
these functions also run in tests where no request context exists, and relying on an invisible filter
for a security boundary is exactly the habit the plan warns against.

`backend/src/lib/invoices/invoice-service.test.js` proves the failure case — creating an invoice
dated `2030-01-01`, far outside the seeded year, returns `422 no_fiscal_year`.

---

### 4.7 File: `backend/src/lib/accounting/document-numbering.js`

**Status:** Created

**Purpose:** Produces the next document number (`INV-2082-0001`) and the next journal entry number
(`JE-2082-0001`), in a way that cannot produce duplicates even when two requests run simultaneously.

**Why does this file exist?** This is danger #7 on the plan's list of twelve classic mistakes:

> **`MAX(doc_no) + 1` numbering** — Duplicate invoice numbers under concurrency — a statutory problem,
> not a cosmetic one.

**How does it connect to other files?** Called by `post-document.js` (both functions) and
`post-manual-entry.js` (entry numbers only). It uses raw SQL rather than Prisma's normal API, for
reasons explained below.

```js
// Locked-counter numbering (§5 document_series): allocate from a row locked
// with SELECT ... FOR UPDATE inside the posting transaction, then increment.
// Never MAX(doc_no)+1 — under concurrency that produces duplicates, and
// duplicate invoice numbers are a statutory problem, not a cosmetic one.

function formatNumber(prefix, yearLabel, number, padding) {
  return `${prefix}-${yearLabel}-${String(number).padStart(padding, '0')}`;
}

// doc_no: one series per (organization, docType, fiscalYear) — INV-2082-0001,
// CN-2082-0001, etc. each count independently.
export async function nextDocNumber(tx, { organizationId, docType, fiscalYearId, prefix, yearLabel }) {
  await tx.$executeRaw`
    INSERT INTO "DocumentSeries" (id, "organizationId", "docType", "fiscalYearId", prefix, padding, "nextNumber")
    VALUES (gen_random_uuid(), ${organizationId}, ${docType}::"DocType", ${fiscalYearId}, ${prefix}, 4, 1)
    ON CONFLICT ("organizationId", "docType", "fiscalYearId") DO NOTHING
  `;
  const [series] = await tx.$queryRaw`
    SELECT * FROM "DocumentSeries"
    WHERE "organizationId" = ${organizationId} AND "docType" = ${docType}::"DocType" AND "fiscalYearId" = ${fiscalYearId}
    FOR UPDATE
  `;
  await tx.$executeRaw`UPDATE "DocumentSeries" SET "nextNumber" = "nextNumber" + 1 WHERE id = ${series.id}`;
  return formatNumber(series.prefix, yearLabel, series.nextNumber, series.padding);
}
```

(The file also contains `nextEntryNumber`, which is identical in shape but keyed on
`(organizationId, fiscalYearId)` only — explained at the end of this section.)

#### Reading this code from zero

**The problem, concretely**

Imagine numbering invoices as "look up the biggest number so far, add one":

```
Time  Request A                          Request B
────────────────────────────────────────────────────────────────
 1    SELECT MAX(doc_no) → 6
 2                                       SELECT MAX(doc_no) → 6
 3    writes INV-2082-0007
 4                                       writes INV-2082-0007   ← duplicate
```

Both read 6 before either wrote 7. Nothing in that sequence is a coding mistake in the ordinary
sense; the logic is simply not safe under concurrency.

---

**Concept — a row lock (`SELECT ... FOR UPDATE`)**

`SELECT ... FOR UPDATE` reads a row **and locks it**. Any other transaction that tries to read that
same row with `FOR UPDATE` is made to wait until the first transaction finishes.

Applied to a counter row:

```
Time  Request A                          Request B
────────────────────────────────────────────────────────────────
 1    SELECT ... FOR UPDATE → 7
 2                                       SELECT ... FOR UPDATE → waits
 3    UPDATE nextNumber = 8
 4    COMMIT (lock released)
 5                                       ...resumes, reads 8
```

Request B physically cannot read the counter until A has finished with it. Duplicates become
impossible rather than unlikely.

**Why not a PostgreSQL sequence?** A sequence is a built-in counter, and it is the usual answer — but
sequences deliberately do **not** roll back. If a posting fails after taking number 7, the sequence
stays at 8 and invoice 7 never exists. For invoice numbering, gaps are a problem: an auditor asking
"where is invoice 7?" deserves an answer. A counter row inside the same transaction rolls back with
everything else, so numbers stay gapless.

---

**Concept — raw SQL, and why it is used here**

Prisma has no way to express `FOR UPDATE`. It is a low-level locking instruction with no equivalent in
the ORM's vocabulary. So this file drops to SQL.

- `tx.$executeRaw` — runs a statement, returns how many rows changed.
- `tx.$queryRaw` — runs a query, returns the rows.

Both are used as **tagged templates**: a backtick string attached directly to the function name, with
values interpolated using `${...}`.

```js
  await tx.$executeRaw`UPDATE "DocumentSeries" SET "nextNumber" = "nextNumber" + 1 WHERE id = ${series.id}`;
```

This looks like ordinary string interpolation, but it is not, and the difference is a security one.
Prisma receives the fixed text and the values *separately*, and sends them to PostgreSQL as a
**parameterised query** — the value can never be interpreted as SQL. This is what prevents **SQL
injection**, where a value like `'; DROP TABLE users; --` would otherwise become executable code.

The dangerous alternative — `$executeRawUnsafe('... WHERE id = ' + id)` — does exactly what its name
warns.

Note also that every table and column name is in double quotes: `"DocumentSeries"`, `"nextNumber"`.
PostgreSQL lower-cases unquoted identifiers, and Prisma created these tables with capital letters, so
the quotes are mandatory.

---

**Step 1 — create the counter row if it does not exist**

```js
  await tx.$executeRaw`
    INSERT INTO "DocumentSeries" (...)
    VALUES (gen_random_uuid(), ${organizationId}, ${docType}::"DocType", ${fiscalYearId}, ${prefix}, 4, 1)
    ON CONFLICT ("organizationId", "docType", "fiscalYearId") DO NOTHING
  `;
```

The very first invoice of a fiscal year has no counter row yet. Rather than "check, then create if
missing" — which has the same race condition all over again — this uses PostgreSQL's
`ON CONFLICT ... DO NOTHING`: try to insert, and if a row with those key values already exists, do
nothing and carry on. One statement, no race.

`gen_random_uuid()` is a PostgreSQL built-in that generates a random unique identifier. It is
available without an extension from PostgreSQL 13 onward; `docker-compose.yml` runs `postgres:16`.

`${docType}::"DocType"` — the `::` is a PostgreSQL **cast**, telling it to treat the text value as
the `DocType` enum type. Without it PostgreSQL refuses to compare text to an enum.

---

**Step 2 — lock and read**

```js
  const [series] = await tx.$queryRaw`
    SELECT * FROM "DocumentSeries"
    WHERE ... FOR UPDATE
  `;
```

`const [series] = ...` is array destructuring again: `$queryRaw` returns an array of rows, and this
takes the first one into a variable named `series`.

From this moment until the transaction ends, no other transaction can touch this counter row.

---

**Step 3 — increment, then format**

```js
  await tx.$executeRaw`UPDATE "DocumentSeries" SET "nextNumber" = "nextNumber" + 1 WHERE id = ${series.id}`;
  return formatNumber(series.prefix, yearLabel, series.nextNumber, series.padding);
```

Read the last line carefully: it returns `series.nextNumber` — the value read in step 2, **before**
the increment. The row now holds the *next* number for the *next* caller. Off-by-one errors here would
mean either two invoices sharing a number or the first number being skipped, so
`backend/src/lib/accounting/post-document.test.js` posts two invoices and asserts the second number
is exactly the first plus one.

---

**The formatter**

```js
function formatNumber(prefix, yearLabel, number, padding) {
  return `${prefix}-${yearLabel}-${String(number).padStart(padding, '0')}`;
}
```

`String(number)` converts `1` to `"1"`. `.padStart(4, '0')` pads it to four characters with zeros:
`"0001"`. Result: `INV-2082-0001`.

Zero-padding is not decoration. It makes numbers sort correctly as text — without it, sorting gives
`INV-1, INV-10, INV-2`.

---

**Two series, two different keys**

The file exports two functions that look almost identical. The difference is what they count *per*:

| Function | Unique key | Effect |
|---|---|---|
| `nextDocNumber` | `(organizationId, docType, fiscalYearId)` | Invoices and credit notes count separately: `INV-2082-0001` and `CN-2082-0001` can both exist |
| `nextEntryNumber` | `(organizationId, fiscalYearId)` | One shared sequence for *all* journal entries, whatever created them |

That second one is a schema addition this session had to invent — the plan's §5 specifies a
`document_series` table but never gives one for journal entry numbers, while every worked example in
§6 shows a single interleaved `JE-####` sequence covering invoice-, receipt-, and manual-sourced
entries. Section 4.14 covers the resulting `EntrySeries` model.

**What happens at runtime**, for the first invoice ever posted in fiscal year 2082/83:

1. `postDocument` opens a transaction and locks the invoice row.
2. It calls `nextDocNumber`.
3. The `INSERT ... ON CONFLICT DO NOTHING` creates a `DocumentSeries` row with `nextNumber = 1`.
4. `SELECT ... FOR UPDATE` reads it and locks it. Any concurrent post now waits here.
5. `UPDATE` sets `nextNumber = 2`.
6. `formatNumber` returns `INV-2082-0001`.
7. The same sequence runs for `nextEntryNumber`, returning `JE-2082-0001`.
8. Posting continues. When the transaction commits, both locks release together.

If step 8 fails — an unbalanced entry, say — the whole transaction rolls back, both counters return to
their previous values, and the numbers are reused by the next attempt. No gap.

---

### 4.8 File: `backend/src/lib/accounting/post-document.js` ★

**Status:** Created

**Purpose:** Turns a draft document into a posted journal entry. This is the most important file in
the project.

**Why does this file exist?** The plan (§6) opens with:

> Every financial document — every one, without exception — goes through `postDocument()`. There is no
> second code path that writes to `journal_entries`.

One door. Every rule — is it already posted, is the company active, is the period open, does this user
have permission, does the entry balance — is enforced at that door. A second door would mean every
rule has to be remembered twice.

**How does it connect to other files?** Called by `POST /invoices/:id/post` in
`backend/src/routes/invoices.js`. It calls `posting-rules.js`, `document-numbering.js`,
`period-lock.js`, `errors.js`, `chart-of-accounts.js`, `money.js`, and Prisma.

```js
import { prisma } from '../../db/client.js';
import { POSTING_RULES } from './posting-rules.js';
import { nextDocNumber, nextEntryNumber } from './document-numbering.js';
import { assertPeriodOpen } from './period-lock.js';
import { notFound, conflict, businessRule, forbidden, internal } from './errors.js';
import { AR_ACCOUNT_CODE } from './chart-of-accounts.js';
import { add, eq, dec } from '../money.js';

// Only invoice is wired today (Day 3 scope) — credit_note/receipt/bill/
// supplier_payment get their own posting rules and permission codes on the
// days that build them (§6 posting rule table).
const DOC_TYPE_RULES = {
  INVOICE: { rulesKey: 'invoice', prefix: 'INV', permission: 'invoice.post', label: 'Sales Invoice' },
};

async function assertPermission(tx, actor, permissionCode) {
  const rolePermission = await tx.rolePermission.findFirst({
    where: { roleId: actor.roleId, permission: { code: permissionCode } },
  });
  if (!rolePermission) throw forbidden(`Missing required permission: ${permissionCode}`);
}
```

The main function follows. It is long, so it is quoted here in the numbered steps the plan defines,
with each step explained immediately after.

#### Step 0 — one transaction wrapping everything

```js
export async function postDocument(documentId, actor) {
  return prisma.$transaction(
    async (tx) => {
      ...
    },
    { isolationLevel: 'ReadCommitted' }
  );
}
```

**Concept — a database transaction**

A transaction groups database operations so that either **all** of them happen or **none** of them do.

Posting an invoice performs six writes: increment two counters, create a journal entry, create its
lines, update the document, link them together. If the server crashed after the third, the database
would hold a journal entry for an invoice still marked as a draft — a corruption that no report could
make sense of.

Inside `prisma.$transaction(async (tx) => { ... })`, PostgreSQL issues a `BEGIN` at the start. If the
function returns normally, it issues `COMMIT` and everything becomes permanent at once. If the
function **throws**, it issues `ROLLBACK` and the database is exactly as it was.

This is why the guards can simply `throw`. Throwing is not just an error report — it is the
instruction that undoes every write made so far.

`{ isolationLevel: 'ReadCommitted' }` sets how strictly this transaction is insulated from others
running at the same time. `ReadCommitted` means it sees other transactions' data only once they have
committed. The plan chooses it deliberately over the stricter `Serializable`:

> `ReadCommitted` + explicit `FOR UPDATE` on contended rows, rather than `Serializable` everywhere.
> `Serializable` would work but converts contention into retry storms you'd then have to handle;
> explicit locks are more predictable and easier to explain.

`actor` is an object `{ userId, organizationId, roleId }` — who is doing this. It is assembled by the
route from the Day 2 middleware's output.

#### Step 1 — lock the document

```js
      // 1. Lock the document. Prevents double-posting under concurrent requests.
      const [doc] = await tx.$queryRaw`
      SELECT * FROM "Document"
      WHERE id = ${documentId} AND "organizationId" = ${actor.organizationId}
      FOR UPDATE
    `;
      if (!doc) throw notFound('Document not found');
```

This is the first thing that happens, and the order is the whole point.

`FOR UPDATE` locks the invoice row. If a user double-clicks Post, two requests arrive nearly
simultaneously:

```
Request A                          Request B
──────────────────────────────────────────────────────────
SELECT ... FOR UPDATE  → gets it
                                   SELECT ... FOR UPDATE → BLOCKS
status is DRAFT ✓
...posts, sets status = POSTED
COMMIT (lock released)
                                   ...unblocks, reads status = POSTED
                                   throws 409 already_posted
```

Request B physically cannot read the row until A has committed — and by then the status has changed,
so B's guard catches it. Without the lock, both would read `DRAFT` and both would post.

Notice `AND "organizationId" = ${actor.organizationId}` is written by hand. The Day 2 tenant extension
does not apply to raw SQL — it works by rewriting Prisma's query objects, and raw SQL has none. This
is one of the few places where forgetting the tenant filter would be possible, which is exactly why
it is spelled out with the actor's organization ID rather than trusting anything from the request.

If no row comes back — wrong ID, or an invoice belonging to another company — the result is `404`, not
`403`, for the enumeration reason described in section 4.3.

#### Step 2 — the guards

```js
      // 2. Guards — each throws an error the route handler maps to HTTP.
      if (doc.status !== 'DRAFT') {
        throw conflict('already_posted', `Document ${doc.id} is already ${doc.status.toLowerCase()}`);
      }

      const org = await tx.organization.findUniqueOrThrow({ where: { id: actor.organizationId } });
      if (!org.isActive) throw businessRule('organization_read_only', 'Organization is read-only');

      const period = await assertPeriodOpen(tx, { organizationId: actor.organizationId, docDate: doc.docDate });

      const config = DOC_TYPE_RULES[doc.docType];
      if (!config) throw internal(`No posting rule wired for document type ${doc.docType}`);

      await assertPermission(tx, actor, config.permission);
```

Four questions, asked in order, each with its own error:

1. **Is it still a draft?** Posting twice is `409 already_posted`.
2. **Is the company active?** A deactivated organization is read-only — `422`.
3. **Is the accounting month open?** Delegated to `period-lock.js` — `422 period_locked`. The period it
   returns is kept, because the journal entry must record which period it belongs to.
4. **Does this user have permission?** `403`.

`DOC_TYPE_RULES` is a lookup table mapping the document type to everything type-specific: which
posting rule, which number prefix, which permission code, what to write in the description. Today it
holds one entry. Adding credit notes on Day 4 means adding one line here plus one function in
`posting-rules.js` — the pipeline itself does not change. A document type with no entry produces a
`500`, because that is a programming mistake, not a user error.

**The permission check happens twice, deliberately.** The route already has
`authorize('invoice.post')` middleware from Day 2. This checks again, inside the transaction. That is
not redundancy by accident: `postDocument` is the single door, and the door must be safe no matter who
knocks — including a future background job or CLI script with no HTTP middleware in front of it.

`assertPermission` reads the permission from the **database** on every call rather than trusting
anything in the login token. That is danger #8 on the plan's list: permissions baked into a JWT keep
working until the token expires, so revoking a dismissed employee's rights would take fifteen minutes
to bite.

#### Step 3 — allocate the numbers

```js
      // 3. Allocate doc_no and entry_no from their locked series rows.
      const fiscalYear = await tx.fiscalYear.findFirstOrThrow({
        where: { id: doc.fiscalYearId, organizationId: actor.organizationId },
      });
      const yearLabel = fiscalYear.label.split('/')[0];

      const docNo = await nextDocNumber(tx, {
        organizationId: actor.organizationId,
        docType: doc.docType,
        fiscalYearId: doc.fiscalYearId,
        prefix: config.prefix,
        yearLabel,
      });
      const entryNumber = await nextEntryNumber(tx, {
        organizationId: actor.organizationId,
        fiscalYearId: doc.fiscalYearId,
        yearLabel,
      });
```

Numbers are allocated **after** the guards, not before. If the period is locked, no number is
consumed. Since the counters are locked rows inside this transaction, this also means the locks are
held for the shortest possible time — a transaction that is going to fail has already failed.

`fiscalYear.label.split('/')[0]` turns `'2082/83'` into `'2082'`. `split('/')` cuts the string at the
slash producing `['2082', '83']`, and `[0]` takes the first piece. That is the year that appears in
`INV-2082-0001`.

#### Step 4 — build the journal lines

```js
      // 4. Build journal lines from the rule set for this document type.
      const docLines = await tx.documentLine.findMany({
        where: { documentId: doc.id },
        include: { taxCode: true },
        orderBy: { lineNo: 'asc' },
      });

      const arAccount = await tx.account.findFirst({
        where: { organizationId: actor.organizationId, code: AR_ACCOUNT_CODE },
      });
      if (!arAccount) throw internal(`Accounts Receivable account (${AR_ACCOUNT_CODE}) not found for this organization`);

      const journalLines = POSTING_RULES.invoice({
        partyId: doc.partyId,
        arAccountId: arAccount.id,
        grandTotal: dec(doc.grandTotal),
        lines: docLines.map((l) => ({
          accountId: l.accountId,
          taxableAmount: l.taxableAmount,
          taxAmount: l.taxAmount,
          taxAccountId: l.taxCode?.outputAccountId ?? null,
          description: l.description,
        })),
      });
```

This is where the pure function from section 4.2 is finally called — and this is the code that does
all the lookups it deliberately cannot do itself.

`include: { taxCode: true }` tells Prisma to fetch each line's related tax code in the same query,
rather than one extra query per line. That pattern — many small follow-up queries — is called the
**N+1 problem**, and `include` is how Prisma avoids it.

`l.taxCode?.outputAccountId ?? null` combines two operators:

- `?.` — **optional chaining**. If `l.taxCode` is `null` (a line with no tax code), the whole
  expression short-circuits to `undefined` instead of throwing "cannot read property of null".
- `?? null` — nullish coalescing, converting that `undefined` into an explicit `null`.

So: *the tax account for this line, or null if it has no tax code.* The posting rule then skips
null-tax-account lines entirely.

`dec(doc.grandTotal)` converts the total to a `Decimal`. It comes from a raw SQL query, so unlike
Prisma's normal results its type is not guaranteed; converting explicitly makes the arithmetic safe.

#### Step 5 — assert the balance in application code

```js
      // 5. Assert balance in application code too — fail fast with a good
      //    message rather than a raw Postgres exception at COMMIT.
      const debits = journalLines.reduce((total, l) => add(total, l.debit), dec(0));
      const credits = journalLines.reduce((total, l) => add(total, l.credit), dec(0));
      if (!eq(debits, credits)) {
        throw internal(`Unbalanced entry for document ${doc.id}: debits ${debits} vs credits ${credits}`);
      }
```

Two `reduce` calls sum the two columns, then `eq` compares them by value.

`eq(a, b)` rather than `a === b` matters: these are `Decimal` **objects**, and `===` on two objects
asks "are these the same object in memory", which is false even for two Decimals both holding
135600.

**Why check at all, when the database already enforces this?** Day 1 created a deferred constraint
trigger that raises at `COMMIT` if debits do not equal credits. The check here does not replace it —
it *improves the error message*. Without this, an unbalanced entry surfaces as a raw PostgreSQL
exception at commit time, with no indication of which document caused it. With it, the failure names
the document and both totals.

The status chosen is `500`, not `422`, and that is deliberate: if the totals do not match, the
*server* has a bug. The client cannot cause this through the API, because the invoice service
recomputes every total. `backend/src/lib/accounting/post-document.test.js` proves the net still
catches it, by writing a document straight to the database with a deliberately wrong `grandTotal` and
asserting the post is refused.

#### Step 6 — write the entry and its lines

```js
      // 6. Write the entry and its lines. The DEFERRED trigger re-checks at COMMIT.
      const entry = await tx.journalEntry.create({
        data: {
          organizationId: actor.organizationId,
          periodId: period.id,
          entryNumber,
          documentType: config.rulesKey,
          entryDate: doc.docDate,
          description: `${config.label} ${docNo}`,
          status: 'POSTED',
          sourceId: doc.id,
          postedAt: new Date(),
          postedById: actor.userId,
          lines: {
            create: journalLines.map((l) => ({
              organizationId: actor.organizationId,
              accountId: l.accountId,
              partyId: l.partyId,
              debit: l.debit,
              credit: l.credit,
              description: l.description,
              lineNumber: l.lineNumber,
            })),
          },
        },
      });
```

**Concept — a nested create**

`lines: { create: [...] }` tells Prisma to insert the parent row and all its child rows together, with
the foreign key filled in automatically. One call, several `INSERT` statements, all inside the
transaction.

`status: 'POSTED'` is what makes the entry visible to reports. Every report filters
`status = 'POSTED'`; a draft entry is invisible to accounting.

`sourceId: doc.id` records which document produced this entry — the link that lets the UI show the
invoice and its journal entry side by side.

**The nested-create gotcha:** every line explicitly sets `organizationId`. The Day 2 tenant extension
injects that automatically for top-level operations, but **not** for nested relation writes. This
caused a real failure in this session; section 7.1 tells that story.

The deferred trigger from Day 1 now runs at `COMMIT`, not immediately — which is what allows the lines
to be inserted one at a time. Halfway through inserting them the entry is momentarily unbalanced, and
a non-deferred check would reject it.

#### Step 7 — update the document

```js
      // 7. Update the document: status, number, journal link, outstanding.
      await tx.document.update({
        where: { id: doc.id },
        data: {
          status: 'POSTED',
          docNo,
          journalEntryId: entry.id,
          outstandingAmount: doc.grandTotal,
          postedAt: new Date(),
          postedById: actor.userId,
          version: { increment: 1 },
        },
      });

      return entry;
```

The document is stamped: its status changes, it finally receives its number, and it points at the
journal entry it produced.

`outstandingAmount: doc.grandTotal` — the moment an invoice is posted, the entire amount is owed. Day
4's receipts will reduce this as payments arrive. It is deliberately **denormalised**, meaning it
duplicates information derivable from elsewhere, for the sake of fast aging reports — and the plan
pairs that shortcut with test INV-3, which continuously proves it still agrees with the ledger.

`version: { increment: 1 }` bumps the optimistic-concurrency counter, so a browser holding the old
draft cannot submit an edit against a stale version.

#### What is deliberately *not* here

The plan's step 8 reads:

> AFTER commit, outside the transaction: audit log, cache bust, webhooks. Never inside — you would
> emit events for transactions that rolled back.

There is no step 8 inside this function, and that is the point. The audit entry is written by the
Day 2 `res.on('finish')` middleware, long after the transaction has committed. This is danger #10 on
the plan's list: a rolled-back invoice must never fire a "posted" webhook, because downstream systems
would then disagree with the ledger forever.

- **Data in:** a document ID and an actor.
- **Data out:** the created `JournalEntry`, or a thrown tagged error.
- **Who calls it:** `POST /invoices/:id/post`.

---

### 4.9 File: `backend/src/lib/accounting/post-manual-entry.js`

**Status:** Created

**Purpose:** Posts a journal entry typed directly by a human, with no source document.

**Why does this file exist?** Accountants need to record things no invoice covers — a depreciation
charge, a correction, an accrual. There is no document to lock, because there is no document: the
schema's `DocType` enum has no `manual` member, deliberately. A manual entry *is* the record rather
than evidence for one.

So it cannot reuse `postDocument`, whose first act is locking a document row. It repeats the same
guards in the same order, minus the ones that do not apply, plus one that only applies here.

```js
export async function postManualEntry(actor, { entryDate, narration, lines: lineInputs }) {
  return prisma.$transaction(async (tx) => {
    if (!lineInputs || lineInputs.length === 0) {
      throw businessRule('empty_entry', 'A journal entry needs at least one line');
    }

    const date = new Date(entryDate);
    const fiscalYear = await findFiscalYearForDate(tx, actor.organizationId, date);
    const period = await assertPeriodOpen(tx, { organizationId: actor.organizationId, docDate: date });

    const accountIds = [...new Set(lineInputs.map((l) => l.accountId))];
    const accounts = await tx.account.findMany({
      where: { organizationId: actor.organizationId, id: { in: accountIds } },
    });
    const accountById = new Map(accounts.map((a) => [a.id, a]));

    for (const line of lineInputs) {
      const account = accountById.get(line.accountId);
      if (!account) throw notFound(`Account ${line.accountId} not found`);
      // PERM-6: control accounts (AR, VAT Payable, ...) are only ever
      // touched by the document-driven posting rules, never a manual JV.
      if (account.isControlAccount) {
        throw businessRule(
          'manual_entry_not_allowed_on_control_account',
          `Account ${account.code} is a control account and cannot be posted to manually`
        );
      }
    }
    ...
```

#### Reading this code from zero

**Concept — a control account, and why this rule exists**

A **control account** is a general-ledger account whose balance is supposed to equal the total of a
detailed list kept elsewhere. Accounts Receivable is the classic case: the balance of account 1100
should always equal the sum of what every individual customer owes.

That agreement is the auditor's basic sanity check, and the plan states it as test INV-3:

```
Σ documents.outstanding_amount WHERE doc_type='invoice'
==
balance of account 1100 Accounts Receivable
```

Now imagine an accountant hand-typing an entry that credits AR by 5,000. The ledger balance drops by
5,000. No customer's invoice changed. The two sides no longer agree, and nothing in the system can
say which customer the 5,000 belonged to. The subledger is broken, permanently, and the only clue is
a report that stops reconciling.

Hence the rule: **control accounts move only through document posting.** Want to reduce what a
customer owes? Issue a credit note or record a receipt — both of which are documents, both of which
update the customer's own record and the control account together.

This is test PERM-6 in the plan, and it is enforced here and only here. `postDocument` has no such
check, because posting *rules* are the legitimate way control accounts move.

---

**Generic syntax — `new Set` for deduplication**

```js
const unique = [...new Set([1, 2, 2, 3])];   // [1, 2, 3]
```

A `Set` holds each value at most once. Wrapping an array in `new Set(...)` drops duplicates, and
`[...spread]` turns it back into an array.

**In this project:**

```js
    const accountIds = [...new Set(lineInputs.map((l) => l.accountId))];
```

A journal entry often touches the same account twice. Deduplicating means one database query for the
distinct accounts rather than repeated lookups for the same one.

```js
      where: { organizationId: actor.organizationId, id: { in: accountIds } },
```

`{ in: [...] }` becomes SQL's `WHERE id IN (...)` — fetch all of them in a single round trip. The
results are then put into a `Map` for instant lookup by ID.

The per-line loop then does two things: rejects unknown accounts as `404` (which also covers accounts
belonging to another company, since the query was tenant-filtered), and rejects control accounts as
`422`.

The remainder of the function mirrors `postDocument` steps 4 to 6: call `POSTING_RULES.manual`, sum
both columns, compare with `eq`, allocate an entry number, create the entry with `status: 'POSTED'`
and `sourceId: null`.

**Why `sourceId` is null:** there is no source document. That single field is what distinguishes a
manual entry from a document-driven one in every later query.

---

### 4.10 File: `backend/src/lib/invoices/invoice-service.js`

**Status:** Created

**Purpose:** Creates and edits invoice drafts, and previews totals without saving anything.

**Why does this file exist?** To keep "building a document" separate from "posting a document".
Drafts have no accounting effect at all — they can be edited freely and are invisible to every
report. Only posting touches the ledger. Mixing the two would mean every draft edit had to worry
about ledger consistency.

**How does it connect to other files?** Called by `backend/src/routes/invoices.js`. Calls
`line-math.js`, `fiscal-year.js`, `errors.js`, `money.js`, and Prisma.

#### The heart of it — `resolveLines`

```js
// Totals are never accepted from the client — only quantity/rate/discount/tax
// code come in; taxableAmount, taxAmount, lineTotal are recomputed here from
// scratch every time, draft create or draft update alike (§6 validation layers).
async function resolveLines(tx, organizationId, lineInputs) {
  if (!lineInputs || lineInputs.length === 0) {
    throw businessRule('empty_invoice', 'An invoice needs at least one line');
  }

  const accountIds = [...new Set(lineInputs.map((l) => l.accountId))];
  const taxCodeIds = [...new Set(lineInputs.filter((l) => l.taxCodeId).map((l) => l.taxCodeId))];

  const [accounts, taxCodes] = await Promise.all([
    tx.account.findMany({ where: { organizationId, id: { in: accountIds } } }),
    taxCodeIds.length ? tx.taxCode.findMany({ where: { organizationId, id: { in: taxCodeIds } } }) : [],
  ]);
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const taxCodeById = new Map(taxCodes.map((t) => [t.id, t]));

  for (const line of lineInputs) {
    // A valid UUID from another organisation must fail as 404, not 403 —
    // revealing existence is itself a leak (§6 validation layers).
    if (!accountById.has(line.accountId)) throw notFound(`Account ${line.accountId} not found`);
    if (line.taxCodeId && !taxCodeById.has(line.taxCodeId)) throw notFound(`Tax code ${line.taxCodeId} not found`);
  }

  return lineInputs.map((input, i) => {
    const taxCode = input.taxCodeId ? taxCodeById.get(input.taxCodeId) : null;
    const computed = computeLine({
      quantity: input.quantity,
      unitPrice: input.unitPrice,
      discountPct: input.discountPct ?? 0,
      taxRate: taxCode?.rate ?? 0,
    });

    return {
      lineNo: i + 1,
      description: input.description,
      accountId: input.accountId,
      quantity: dec(input.quantity),
      unitPrice: dec(input.unitPrice),
      discountPct: dec(input.discountPct ?? 0),
      taxCodeId: input.taxCodeId ?? null,
      ...computed,
    };
  });
}
```

**This function is the answer to danger #3 on the plan's list.** Read the returned object carefully:
`taxableAmount`, `taxAmount`, and `lineTotal` arrive via `...computed` — the output of `computeLine`.
They are **never** read from `input`. Whatever the browser sends for those fields is ignored
completely.

The plan phrases the demo line for this:

> "totals are never accepted from the client — the server recomputes every line, every tax, and every
> total from quantities and rates, then compares. If a client sends a `grand_total`, it is ignored."

`backend/src/lib/invoices/invoice-service.test.js` proves it by sending
`{ ...line, grandTotal: '1.00', taxableAmount: '1.00', taxAmount: '1.00', lineTotal: '1.00' }` and
asserting the stored total is `135600.00`.

Note also the tax rate: `taxRate: taxCode?.rate ?? 0`. The rate comes from the **database**, from the
tax code the line references. There is no `0.13` anywhere in the codebase. The plan is blunt about
this: *"Rates are data. Hard-coding 0.13 anywhere in the codebase is an instant deduction."* When
Nepal changes its VAT rate, that is a row update, not a deployment.

---

**Generic syntax — `Promise.all` for parallel queries**

```js
const [a, b] = await Promise.all([queryA(), queryB()]);
```

Two independent queries would normally run one after the other. `Promise.all` starts both and waits
for both, so the total time is the slower of the two rather than their sum. It works only when
neither query needs the other's result — which is the case here.

The `taxCodeIds.length ? ... : []` part is a **ternary operator** — `condition ? valueIfTrue :
valueIfFalse`. If no line has a tax code, it skips the query entirely and substitutes an empty array.

**Generic syntax — `filter`**

```js
const withTax = lineInputs.filter((l) => l.taxCodeId);
```

`filter` keeps only the elements for which the function returns something truthy. Here: only lines
that actually reference a tax code.

---

#### `createDraftInvoice`

```js
export async function createDraftInvoice(actor, input) {
  return prisma.$transaction(async (tx) => {
    const party = await tx.party.findFirst({ where: { id: input.partyId, organizationId: actor.organizationId } });
    if (!party) throw notFound('Party not found');

    const docDate = new Date(input.docDate);
    const fiscalYear = await findFiscalYearForDate(tx, actor.organizationId, docDate);
    const dueDate = input.dueDate ? new Date(input.dueDate) : addDays(docDate, party.creditDays);

    const lines = await resolveLines(tx, actor.organizationId, input.lines);
    const totals = sumLines(lines);

    return tx.document.create({
      data: {
        organizationId: actor.organizationId,
        fiscalYearId: fiscalYear.id,
        docType: 'INVOICE',
        docDate,
        dueDate,
        partyId: party.id,
        ...
        status: 'DRAFT',
        createdById: actor.userId,
        subtotal: totals.subtotal,
        ...
        grandTotal: totals.grandTotal,
        lines: { create: lines.map(toDocumentLineData) },
      },
      include: { lines: true },
    });
  });
}
```

The due date is the interesting line:

```js
    const dueDate = input.dueDate ? new Date(input.dueDate) : addDays(docDate, party.creditDays);
```

If the client supplies a due date, use it. Otherwise compute it from **that customer's** payment
terms. `creditDays` lives on the party — the seed gives Everest Cafe 15 days and Himalayan Trek 30.

This is not cosmetic: `dueDate` is what the Day 4 aging report buckets by. An invoice with the wrong
due date lands in the wrong overdue bucket. A bug in exactly this logic was found during the audit of
this session — section 7.6.

Note the document is created with **no `docNo`**. The column is nullable precisely so drafts can
exist without a number; the number is allocated at posting time from the locked counter. A draft that
is deleted therefore consumes no number.

`toDocumentLineData` strips one field before writing:

```js
// DocumentLine has no discountAmount column — only discountPct is stored per
// line (§5); discountAmount only exists as a computed value for sumLines'
// document-level aggregation. Strip it before writing a line row.
function toDocumentLineData({ discountAmount: _discountAmount, ...line }) {
  return line;
}
```

This uses destructuring to *remove* a property: pull `discountAmount` out into a variable (renamed
`_discountAmount`, the underscore signalling "deliberately unused" to the linter), and collect
everything else into `line` via the **rest** operator `...`. The returned object is the original
minus that one key. This too came from a real failure — section 7.4.

---

#### `updateDraftInvoice` — optimistic concurrency

```js
    const result = await tx.document.updateMany({
      where: { id: documentId, organizationId: actor.organizationId, version: expectedVersion, status: 'DRAFT' },
      data: {
        ...
        version: { increment: 1 },
      },
    });

    if (result.count === 0) {
      throw conflict('version_conflict', `Invoice ${documentId} was modified by someone else — reload and try again`);
    }
```

**Concept — optimistic concurrency control**

Two people open the same draft invoice. Both edit. Both save. Without protection, the second save
silently overwrites the first, and the first person never learns their work vanished.

There are two ways to prevent this:

- **Pessimistic** — lock the row when someone starts editing. Correct, but a user who opens a draft
  and goes to lunch blocks everyone else.
- **Optimistic** — let everyone edit, but detect the collision at save time. Assume conflicts are
  rare; check rather than prevent.

Optimistic control is implemented with a **version number**. Every document carries one, starting at
0. The client is told the version when it loads the draft and must send it back when saving. The
update says: *change this row, but only if its version is still what I was shown.*

```
Alice loads draft   → version 0
Bob loads draft     → version 0
Alice saves with version 0 → matches → saved, version becomes 1
Bob saves with version 0   → no longer matches → 0 rows updated → 409
```

Bob gets told to reload rather than silently destroying Alice's edit.

`updateMany` is used rather than `update` for a specific reason: `update` throws if it matches
nothing, while `updateMany` returns `{ count: 0 }`. That count is the signal. `count === 0` means the
version did not match — or the status is no longer `DRAFT`, which the same `where` clause also
covers.

The `where` clause carries four conditions, and every one is load-bearing: the right document, the
right company, the expected version, and still a draft.

Lines are then replaced wholesale:

```js
    // Lines are replaced wholesale rather than diffed — simpler, and every
    // draft edit already recomputes every line from scratch anyway.
    await tx.documentLine.deleteMany({ where: { documentId } });
    await tx.documentLine.createMany({ data: lines.map((l) => ({ ...toDocumentLineData(l), documentId })) });
```

Working out which lines changed, which were added and which removed would be considerably more code
for no benefit — every line is recomputed from scratch anyway. Both statements are inside the
transaction, so there is never a visible moment where the invoice has no lines.

---

#### `previewInvoice`

```js
// Live totals for the invoice editor — same recomputation as create/update,
// nothing persisted. Backs POST /invoices/preview.
export async function previewInvoice(actor, { lines: lineInputs }) {
  const lines = await resolveLines(prisma, actor.organizationId, lineInputs);
  return { lines, totals: sumLines(lines) };
}
```

Three lines, and an architectural decision. As the user types quantities into the invoice editor, the
totals must update. The obvious implementation computes them in JavaScript in the browser — but then
the rounding rules exist in two places, in two languages, and the day they drift apart the displayed
total stops matching the saved one.

The plan calls this out as *"a deliberate, explainable choice"*: the editor asks the server. One
implementation of the rounding policy, used by preview, create, update, and posting alike.

Note it passes `prisma` where the others pass `tx`. There is nothing to make atomic — it only reads.

- **Data in:** an actor and a list of line inputs.
- **Data out:** computed lines and totals. Nothing is written.
- **Who calls it:** `POST /invoices/preview`.

---

### 4.11 File: `backend/src/routes/journal-entries.js`

**Status:** Created

**Purpose:** Three HTTP endpoints for journal entries, plus two serializer functions that
`invoices.js` also uses.

**Why does this file exist?** The manual journal entry endpoint is one of the plan's Day 3
deliverables, and the read endpoints are what the frontend's journal-entry panel displays.

```js
const router = Router();

// Every route below is tenant-scoped, same convention as masters.js.
router.use(authenticate, resolveTenant);

const PAGE_SIZE = 20;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function serializeJournalLine(line) {
  return {
    id: line.id,
    accountId: line.accountId,
    partyId: line.partyId,
    debit: line.debit.toFixed(2),
    credit: line.credit.toFixed(2),
    description: line.description,
    lineNumber: line.lineNumber,
  };
}

export function serializeJournalEntry(entry) {
  return {
    id: entry.id,
    entryNumber: entry.entryNumber,
    documentType: entry.documentType,
    entryDate: entry.entryDate.toISOString().slice(0, 10),
    description: entry.description,
    status: entry.status.toLowerCase(),
    sourceId: entry.sourceId,
    postedAt: entry.postedAt,
    lines: entry.lines ? entry.lines.map(serializeJournalLine) : undefined,
  };
}
```

#### Reading this code from zero

**Concept — middleware, and why `router.use` comes first**

**Middleware** is a function that runs before your route handler and can inspect the request, modify
it, or stop it. Day 2 built three:

1. `authenticate` — reads the `Authorization: Bearer ...` header, verifies the token, sets `req.userId`
2. `resolveTenant` — reads `X-Organization-Id`, verifies the user is a member, sets
   `req.organizationId` and `req.roleId`, and opens the request context the tenant extension reads
3. `authorize(code)` — checks the database for a specific permission

```js
router.use(authenticate, resolveTenant);
```

`router.use` applies both to **every** route in this file, in this order. Order is not style: without
`authenticate` there is no `req.userId` for `resolveTenant` to check membership for.

`authorize` is applied per-route instead, because each route needs a different permission.

---

**Concept — serialization, and why money becomes a string**

A **serializer** converts an internal object into the shape sent over the wire as JSON.

```js
    debit: line.debit.toFixed(2),
```

`toFixed(2)` turns a `Decimal` into a string with exactly two decimal places: `"135600.00"`.

Why a string rather than a number? Because JSON numbers are IEEE floating point — the very format that
cannot represent `0.1` exactly. Sending `135600.00` as a JSON number invites the browser to reintroduce
the rounding errors the entire backend was built to avoid. Sending it as text means the browser
displays exactly what the server computed.

`.toFixed(2)` rather than `.toString()` also matters. `toString()` drops trailing zeros, giving
`"135600"` — technically the same value but wrong for a money column. This exact difference broke four
tests in this session; section 7.2 tells the story.

```js
    status: entry.status.toLowerCase(),
```

The database enum is `POSTED`; the API contract says `"posted"`. Translating at the boundary keeps the
external contract stable even if the internal representation changes — the same pattern
`masters.js` already uses for party types.

```js
    lines: entry.lines ? entry.lines.map(serializeJournalLine) : undefined,
```

A ternary. Some queries fetch lines, others do not. When they were not fetched, the key is `undefined`
— and `JSON.stringify` omits `undefined` keys entirely, so the response simply has no `lines` field
rather than a misleading empty array.

Both serializers are `export`ed because `invoices.js` imports `serializeJournalEntry` to include the
journal entry in its post response.

---

**The validation schema**

```js
const manualLineSchema = z.object({
  accountId: z.string().uuid(),
  debit: z.coerce.number().min(0).default(0),
  credit: z.coerce.number().min(0).default(0),
  partyId: z.string().uuid().optional(),
  description: z.string().optional(),
}).strict();

// A journal line is a debit or a credit, never both, never neither (jl_sign_check)
// — so a JV can never balance with fewer than two lines.
const createManualEntrySchema = z.object({
  entryDate: z.string().regex(DATE_RE),
  narration: z.string().min(1),
  lines: z.array(manualLineSchema).min(2),
}).strict();
```

**Concept — Zod, and schema validation**

Zod is a library for describing the shape data must have, then checking it. If the check fails it
throws, and the error handler in `app.js` converts that into a `400` listing which fields were wrong.

- `z.string().uuid()` — must be a string in UUID format
- `z.coerce.number().min(0)` — convert to a number if possible, then require it to be at least zero.
  `coerce` accepts `"100"` as well as `100`, which matters because JSON from a form is often strings
- `.default(0)` — if the key is missing, substitute zero
- `.optional()` — the key may be absent
- `z.array(...).min(2)` — an array with at least two elements
- `.strict()` — **reject unknown keys**. Sending an extra field is an error, not silently ignored.
  That is what makes the "client sends a total" attack fail loudly rather than quietly

`DATE_RE = /^\d{4}-\d{2}-\d{2}$/` is a **regular expression** — a pattern. `^` start, `\d{4}` exactly
four digits, `-`, two digits, `-`, two digits, `$` end. So `2025-07-20` passes and `20/07/2025` does
not. The plan is explicit about rejecting ambiguous date formats rather than guessing.

`.min(2)` on lines encodes a real accounting fact. A journal line must be either a debit or a credit,
never both and never neither — enforced by the `jl_sign_check` database constraint from Day 1. A
single line therefore has a non-zero amount in exactly one column, so a one-line entry can never
balance.

---

**The POST route**

```js
router.post('/journal-entries', authorize('journal.post'), async (req, res, next) => {
  try {
    const input = createManualEntrySchema.parse(req.body);
    const actor = { userId: req.userId, organizationId: req.organizationId, roleId: req.roleId };
    const entry = await postManualEntry(actor, input);

    req.auditEntry = {
      action: 'journal_entry.posted',
      entityType: 'JournalEntry',
      entityId: entry.id,
      before: null,
      after: { entryNumber: entry.entryNumber },
    };

    res.status(201).json(serializeJournalEntry(entry));
  } catch (err) {
    next(err);
  }
});
```

**Concept — `try`/`catch` and `next(err)` in Express**

`try { ... } catch (err) { ... }` runs code and catches anything thrown. `next(err)` hands the error
to Express, which skips every remaining handler and jumps to the error handler in `app.js`.

Every route in this codebase has this identical wrapper. Without it, a thrown error inside an `async`
function would become an unhandled promise rejection and the request would hang until it timed out.

`req.auditEntry = { ... }` does not write anything. It leaves a note. The Day 2 middleware in
`backend/src/middleware/audit-log.js` reads it inside `res.on('finish')` — after the response has been
sent and the transaction has committed — and only if the status code was a success:

```js
export function auditLog(req, res, next) {
  res.on('finish', () => {
    if (!req.auditEntry) return;
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    writeAuditLog({ ... });
  });
  next();
}
```

That is the plan's step 8, and the reason a rolled-back post leaves no audit trail claiming success.

`res.status(201)` — 201 means "created". Verified live: the audit table after a session of posting
contains `invoice.create`, `invoice.posted`, `invoice.update`.

---

### 4.12 File: `backend/src/routes/invoices.js`

**Status:** Created

**Purpose:** Six endpoints covering the whole invoice lifecycle.

```js
router.use(authenticate, resolveTenant);

function actorFrom(req) {
  return { userId: req.userId, organizationId: req.organizationId, roleId: req.roleId };
}
```

`actorFrom` gathers what the middleware chain deposited on the request into the one object every
service function expects. It appears in five handlers; extracting it means the shape is defined once.

#### The endpoints and their permissions

| Method | Path | Permission | What it does |
|---|---|---|---|
| `POST` | `/invoices/preview` | `invoice.create` | Compute totals, save nothing |
| `POST` | `/invoices` | `invoice.create` | Create a draft |
| `GET` | `/invoices` | `report.view` | List, with filters |
| `GET` | `/invoices/:id` | `report.view` | One invoice with its lines |
| `PATCH` | `/invoices/:id` | `invoice.create` | Edit a draft |
| `POST` | `/invoices/:id/post` | `invoice.post` | **Post it to the ledger** |

The permission split is the plan's RBAC design made concrete. A Clerk has `invoice.create` but not
`invoice.post` — they can prepare invoices all day and cannot commit one to the books. That is
separation of duties, and it is tests PERM-1 and PERM-2.

#### The posting route

```js
router.post('/invoices/:id/post', authorize('invoice.post'), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const entry = await postDocument(id, actorFrom(req));
    const [doc, fullEntry] = await Promise.all([
      prisma.document.findUniqueOrThrow({ where: { id }, include: { lines: true } }),
      prisma.journalEntry.findUniqueOrThrow({ where: { id: entry.id }, include: { lines: true } }),
    ]);

    req.auditEntry = {
      action: 'invoice.posted',
      entityType: 'Document',
      entityId: doc.id,
      before: null,
      after: { docNo: doc.docNo, journalEntryId: doc.journalEntryId },
    };

    res.json({ invoice: serializeInvoice(doc), journalEntry: serializeJournalEntry(fullEntry) });
  } catch (err) {
    next(err);
  }
});
```

`req.params.id` is the `:id` from the URL. It is validated as a UUID before being used — a malformed
ID becomes `400` rather than reaching the database.

After posting, both records are re-read **outside** the transaction to build the response. `postDocument`
returns the entry without its lines, and the document as it stood before the update. Re-reading gets
the final state of both.

The response shape is deliberate:

```json
{ "invoice": { ... }, "journalEntry": { "lines": [ ... ] } }
```

Both halves in one response, because that is exactly what the plan's checkpoint screen shows —
document on the left, `Dr | Cr` table on the right. One request, no follow-up round trip.

#### The list route

```js
router.get('/invoices', authorize('report.view'), async (req, res, next) => {
  try {
    const query = z.object({
      status: z.enum(STATUSES).optional(),
      partyId: z.string().uuid().optional(),
      page: z.coerce.number().int().min(1).default(1),
    }).parse(req.query);

    const docs = await prisma.document.findMany({
      where: {
        docType: 'INVOICE',
        ...(query.status ? { status: query.status.toUpperCase() } : {}),
        ...(query.partyId ? { partyId: query.partyId } : {}),
      },
      orderBy: { docDate: 'desc' },
      skip: (query.page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    });

    res.json(docs.map(serializeInvoice));
  } catch (err) {
    next(err);
  }
});
```

**Generic syntax — conditional spread**

```js
{ alwaysHere: 1, ...(condition ? { maybe: 2 } : {}) }
```

Spreading an empty object adds nothing. So this idiom means "include this key only if the condition
holds". It builds an optional filter without `if` statements around the query.

**Concept — pagination**

`skip` and `take` become SQL's `OFFSET` and `LIMIT`. Page 1 skips 0 and takes 20; page 2 skips 20.
Without this, an organization with 50,000 invoices would try to send all of them in one response.

Notice what is **absent**: any mention of `organizationId`. This is a normal Prisma call, so the Day 2
tenant extension injects the filter automatically. The extension's model list was extended this
session to include `Document`:

```js
const TENANT_SCOPED_MODELS = new Set([
  'Membership', 'FiscalYear', 'Account', 'TaxCode',
  'JournalEntry', 'AuditLog', 'IdempotencyKey', 'Party',
  'Document', 'DocumentSeries', 'JournalLine', 'EntrySeries',
]);
```

`DocumentLine` is deliberately *not* in that list — it has no `organizationId` column, exactly like
`AccountingPeriod`. It is reached only through its parent document, which is scoped.

---

### 4.13 File: `backend/src/routes/reports.js`

**Status:** Created

**Purpose:** The trial balance — the report that proves the books balance.

**Why does this file exist?** The plan wants it built on Day 3 specifically so every later day has a
self-check to test against.

```js
// Every report is a pure function of journal_lines WHERE status = 'posted'
// (§8) — no cached total, no denormalised balance, no invoice's own numbers.
router.get('/reports/trial-balance', authorize('report.view'), async (req, res, next) => {
  try {
    const query = z.object({
      asOf: z.string().regex(DATE_RE).optional(),
      from: z.string().regex(DATE_RE).optional(),
    }).parse(req.query);

    const asOf = query.asOf ?? new Date().toISOString().slice(0, 10);
    const from = query.from ?? '1900-01-01';

    const rows = await prisma.$queryRaw`
      SELECT a.code, a.name, a.type,
             SUM(jl.debit)  AS total_debit,
             SUM(jl.credit) AS total_credit
      FROM "JournalLine" jl
      JOIN "JournalEntry" je ON je.id = jl."journalEntryId"
      JOIN "Account" a       ON a.id = jl."accountId"
      WHERE jl."organizationId" = ${req.organizationId}
        AND je.status = 'POSTED'
        AND je."entryDate" BETWEEN ${from}::date AND ${asOf}::date
      GROUP BY a.id, a.code, a.name, a.type
      HAVING SUM(jl.debit) <> 0 OR SUM(jl.credit) <> 0
      ORDER BY a.code
    `;
```

#### Reading this code from zero

**Concept — what a trial balance is**

A trial balance lists every account with a balance, showing its total debits and total credits. Its
purpose is one arithmetic check: **across all accounts, total debits must equal total credits.** If
they do not, something is wrong with the books.

Because every journal entry balances individually, the sum of all of them must balance too. So a
trial balance that does not foot means an entry got in without balancing — which the triggers should
have made impossible. It is the system auditing itself.

**Concept — reading this SQL**

- `FROM "JournalLine" jl` — start from the lines; `jl` is a short alias
- `JOIN "JournalEntry" je ON je.id = jl."journalEntryId"` — attach each line's parent entry, needed
  for the date and the status
- `JOIN "Account" a ON a.id = jl."accountId"` — attach the account, needed for its code and name
- `WHERE jl."organizationId" = ${req.organizationId}` — this company only
- `AND je.status = 'POSTED'` — **draft entries are invisible to accounting**
- `AND je."entryDate" BETWEEN ... AND ...` — the date range
- `GROUP BY a.id, ...` — collapse many lines per account into one row per account
- `SUM(jl.debit)` — total the debits within each group
- `HAVING SUM(jl.debit) <> 0 OR SUM(jl.credit) <> 0` — drop accounts with no activity. `HAVING` is
  like `WHERE` but filters *after* grouping, so it can test the sums
- `ORDER BY a.code` — accounting order: 1000s assets, 2000s liabilities, 4000s revenue

`${from}::date` casts the text `'2025-07-21'` to a PostgreSQL date. Still parameterised, still
injection-safe.

Why raw SQL here rather than Prisma? Prisma can group and sum, but this query joins three tables,
aggregates, filters on the aggregate with `HAVING`, and sorts — expressing that through the ORM would
be longer and harder to read than the SQL it generates. Reports are the one place raw SQL is clearer.

**The critical line, restated:** `AND je.status = 'POSTED'`. This is what makes the plan's rule real —
*"every report is a pure function of `journal_lines WHERE status = 'posted'`"*. The report does not
read `Document.grandTotal`, or any cached total. It reads the ledger. If someone tampered with an
invoice's stored total, the trial balance would not change, because the ledger is the truth.

#### The integrity envelope

```js
    let totalDebit = dec(0);
    let totalCredit = dec(0);

    const serializedRows = rows.map((r) => {
      const debit = dec(r.total_debit);
      const credit = dec(r.total_credit);
      totalDebit = add(totalDebit, debit);
      totalCredit = add(totalCredit, credit);

      return {
        code: r.code,
        name: r.name,
        type: r.type,
        totalDebit: debit.toFixed(2),
        totalCredit: credit.toFixed(2),
        debitBalance: (debit.gt(credit) ? sub(debit, credit) : dec(0)).toFixed(2),
        creditBalance: (credit.gt(debit) ? sub(credit, debit) : dec(0)).toFixed(2),
      };
    });

    const difference = sub(totalDebit, totalCredit);

    // The response carries its own integrity proof — the UI renders
    // integrity.balanced as a green check beside the totals (§8.1).
    res.json({
      asOf,
      rows: serializedRows,
      totals: { debit: totalDebit.toFixed(2), credit: totalCredit.toFixed(2) },
      integrity: { balanced: isZero(difference), difference: difference.toFixed(2) },
    });
```

`let` rather than `const` because these two are reassigned on every row — `const` forbids
reassignment.

`debit.gt(credit) ? sub(debit, credit) : dec(0)` — `gt` is "greater than". An account has either a
debit balance or a credit balance, never both. Assets normally sit on the debit side, liabilities and
revenue on the credit side. Showing only the side that applies is how a trial balance is conventionally
presented.

The `integrity` block is the part worth pointing at in a demo. The response does not merely provide
data — it states whether it is internally consistent, and by how much it is off if not. The UI renders
that as a green check. Verified live: `{"balanced":true,"difference":"0.00"}`.

---

### 4.14 Database changes

**File:** `backend/prisma/schema.prisma` — **Modified**

#### Concept — what a Prisma schema is

`schema.prisma` describes the database's tables in a compact language. It is the single source of
truth for the database's shape. From it, Prisma does two things:

1. **Generates a migration** — SQL statements that change a real database to match
2. **Generates a client** — the typed JavaScript API (`prisma.document.findMany(...)`)

`npx prisma migrate dev` does both.

#### The new enums

```prisma
enum DocType {
  INVOICE
  CREDIT_NOTE
  RECEIPT
  BILL
  SUPPLIER_PAYMENT
}

enum DocStatus {
  DRAFT
  POSTED
  PARTIALLY_PAID
  PAID
  REVERSED
}

enum EntryStatus {
  DRAFT
  POSTED
  REVERSED
}
```

An **enum** is a column that may hold only one of a fixed list of values. The database itself rejects
anything else — a typo like `'POSTD'` fails at insert time rather than silently creating a status no
query matches.

`DocType` has all five values now even though only `INVOICE` is used today. Adding an enum value later
requires a migration; listing them upfront costs nothing and means Day 4's receipts need no schema
change.

Note `DocType` has **no `MANUAL`** member. That is the deliberate design decision that forced
`post-manual-entry.js` to exist as a separate path: a manual journal entry has no document.

#### `Document` and `DocumentLine`

Key fields and why they exist:

| Field | Why |
|---|---|
| `docNo String?` | Nullable — drafts have no number until posted |
| `status DocStatus @default(DRAFT)` | The lifecycle state |
| `outstandingAmount` | Denormalised for the aging report's speed; INV-3 guards it |
| `version Int @default(0)` | Optimistic concurrency |
| `journalEntryId String? @unique` | Links to the entry it produced; `@unique` means one entry per document |
| `parentDocumentId String?` | Self-reference — links a credit note to the invoice it corrects (Day 4) |
| `@@unique([organizationId, docType, fiscalYearId, docNo])` | **No duplicate invoice numbers, ever** |

That last one deserves emphasis. Even if every line of application logic were wrong, the database
would refuse a second `INV-2082-0001`. The locked counter makes duplicates unlikely; this constraint
makes them impossible.

On `DocumentLine`, one relation differs from every other in the codebase:

```prisma
  document Document @relation(fields: [documentId], references: [id], onDelete: Cascade)
```

`onDelete: Cascade` means deleting a document deletes its lines. Everywhere else this project uses
`onDelete: Restrict` — refuse the delete if anything references the row — because destroying financial
records breaks the audit trail. Lines are the one exception: a draft document may be hard-deleted, and
its lines have no independent meaning.

#### Changes to existing models

```prisma
model JournalEntry {
  ...
  status         EntryStatus @default(DRAFT)
  sourceId       String?
  postedAt       DateTime?
  postedById     String?
```

`status` is the important one — every report filters on it.

```prisma
model JournalLine {
  ...
  organizationId String
  partyId        String?
```

`organizationId` was added so the tenant extension can protect journal lines and so the trial balance
can filter without a join. `partyId` is what turns a customer statement into a `WHERE` clause.

#### The two schema gaps the plan did not cover

Writing the posting rule exposed two omissions in the plan's §5 schema.

**Gap 1 — `TaxCode` had no account links.** The plan's §5 specifies
`output_account_id` and `input_account_id`, but the Day 2 implementation had only `code`, `name`,
`rate`. Without `outputAccountId` the posting rule cannot know which account VAT credits. Added:

```prisma
enum TaxCodeType {
  VAT
  EXEMPT
  ZERO
}

model TaxCode {
  ...
  type            TaxCodeType @default(VAT)
  outputAccountId String?
  inputAccountId  String?
```

**Gap 2 — nothing numbered journal entries.** §5 gives a `document_series` table for document numbers,
but every worked example in §6 shows a single `JE-####` sequence shared across invoice-, receipt- and
manual-sourced entries. Document numbers are per type; entry numbers are not, so one table cannot
serve both. Added:

```prisma
// journal_entries.entry_no is one shared sequence per (org, fiscal year)
// across every source type — invoice-, receipt- and manual-sourced entries
// interleave in the same JE-#### series (§6 worked examples). doc_no above
// is per doc_type instead, which is why it needs its own table.
model EntrySeries {
  id             String @id @default(uuid())
  organizationId String
  fiscalYearId   String
  prefix         String @default("JE")
  padding        Int    @default(4)
  nextNumber     Int    @default(1)
  ...
  @@unique([organizationId, fiscalYearId])
}
```

#### Migration 1 — two hand edits

`backend/prisma/migrations/20260814050525_day3_documents_and_posting/migration.sql`

Prisma generated this file, and warned:

```
  - Added the required column `organizationId` to the `JournalLine` table without a default value.
    This is not possible if the table is not empty.
```

**Concept — why adding a required column to a populated table fails**

`NOT NULL` means every row must have a value. Adding such a column to a table that already has rows
is a contradiction: the existing rows have nothing to put there. PostgreSQL refuses.

The lazy fix is to wipe the development database. That works locally and would fail in production. The
correct fix is a three-step migration, hand-written into the generated file:

```sql
-- AlterTable
ALTER TABLE "JournalLine" ADD COLUMN     "organizationId" TEXT,
ADD COLUMN     "partyId" TEXT;

-- Backfill from the parent entry before enforcing NOT NULL below.
UPDATE "JournalLine" jl
SET "organizationId" = je."organizationId"
FROM "JournalEntry" je
WHERE je.id = jl."journalEntryId";

ALTER TABLE "JournalLine" ALTER COLUMN "organizationId" SET NOT NULL;
```

Add the column as nullable → fill it from each line's parent entry → *then* make it required. This is
the standard pattern for adding a required column to live data, and it works on an empty database too.

The second edit adds things Prisma cannot express. Prisma has no `@@check` attribute, so `CHECK`
constraints are appended by hand:

```sql
-- CheckConstraint: negatives are expressed as credit notes, not sign flips (§5).
ALTER TABLE "Document" ADD CONSTRAINT "doc_grand_total_nonneg"
  CHECK ("grandTotal" >= 0);

-- CheckConstraint: the seatbelt against over-allocation, independent of the service layer (§5, §6).
ALTER TABLE "Document" ADD CONSTRAINT "doc_outstanding_range"
  CHECK ("outstandingAmount" >= 0 AND "outstandingAmount" <= "grandTotal");

-- CheckConstraint
ALTER TABLE "DocumentLine" ADD CONSTRAINT "docline_qty_price"
  CHECK ("quantity" > 0 AND "unitPrice" >= 0);

-- Partial index: the AR aging report's hot path (§5).
CREATE INDEX "doc_open_by_party" ON "Document" ("organizationId", "partyId")
  WHERE "outstandingAmount" > 0;
```

**Concept — a `CHECK` constraint** is a rule the database enforces on every write. `doc_outstanding_range`
is the one that matters most: it makes it physically impossible for an invoice to be over-paid. Day 4's
allocation service will check this in application code too — but if that code has a bug, the database
still refuses. The plan calls it "the seatbelt".

**Concept — a partial index.** An index makes lookups fast. A **partial** index covers only rows
matching a condition — here, only invoices with money still owed. Since the aging report only ever asks
about unpaid invoices, the index stays small and fast no matter how many years of settled invoices
accumulate.

---

### 4.15 Other modified files

**File:** `backend/src/app.js` — **Modified**

```js
import invoicesRouter from './routes/invoices.js';
import journalEntriesRouter from './routes/journal-entries.js';
import reportsRouter from './routes/reports.js';
...
app.use('/api/v1', mastersRouter);
app.use('/api/v1', invoicesRouter);
app.use('/api/v1', journalEntriesRouter);
app.use('/api/v1', reportsRouter);
```

All three mount at the same prefix. Express tries each router in turn until one has a matching path, so
several routers can share a prefix as long as their paths differ.

Position matters: these are mounted **after** `express.json()`, so `req.body` is populated by the time
a handler runs. Mounting a router above the body parser was one of the Day 2 bugs.

**File:** `backend/src/test/helpers.js` — **Modified**

```js
    TRUNCATE
      "DocumentLine", "Document", "DocumentSeries", "EntrySeries",
      "JournalLine", "JournalEntry", "Account", "TaxCode", "Party",
      ...
    CASCADE
```

Four new table names added to the shared reset helper. Without this, tests creating documents would
leave rows behind and interfere with each other.

`TRUNCATE` rather than `DELETE` for a subtle reason recorded in the file's comment: the immutability
trigger blocks row-level `DELETE` on journal entries, but `TRUNCATE` does not fire row-level triggers.

---

### 4.16 The tests

**Concept — the three kinds of test here**

- **Unit test** — one function in isolation, no database. Milliseconds.
- **Integration test** — real PostgreSQL, calling service functions directly.
- **End-to-end test** — real HTTP through the whole Express app, via `supertest`.

The plan insists on real PostgreSQL rather than an in-memory substitute, and the reason is specific:
*"never SQLite — you are testing triggers, `NUMERIC`, `FOR UPDATE`, and deferred constraints; SQLite
has none of them."* A test suite on SQLite would pass while the real system was broken.

| File | Kind | Proves |
|---|---|---|
| `line-math.test.js` | Unit | The rounding boundary: `187.575 → 187.58`. INV-9 |
| `posting-rules.test.js` | Unit | Every generated entry balances; VAT merging; zero-tax omission. INV-1 |
| `post-document.test.js` | Integration | The whole pipeline plus every guard |
| `invoice-service.test.js` | Integration | Server-side recomputation; version conflicts; due dates |
| `invoices.test.js` | End-to-end | The Day 3 checkpoint over real HTTP; PERM-1..4, PERM-6 |
| `triggers.test.js` | Integration | The database refuses unbalanced and immutable writes. INV-6 |

Two tests are worth quoting, because they test something subtler than "does it work".

**The tampered-total test** (`post-document.test.js`) writes a document straight to the database with a
`grandTotal` that does not match its lines, then tries to post it:

```js
  it('rejects a document whose stored grandTotal does not match its lines', async () => {
    const doc = await makeDraftInvoice({
      docDate: new Date('2025-07-22'),
      lineInputs: [{ quantity: 1, unitPrice: '1000.00', discountPct: 0, taxRate: '0.13' }],
      grandTotalOverride: '1.00', // tampered/stale total
    });

    await expect(postDocument(doc.id, actor)).rejects.toThrow(/unbalanced/i);
  });
```

The API cannot produce this state — the invoice service always recomputes. The test bypasses the
service to prove the balance assertion in step 5 is a real safety net and not decoration.

**The client-total test** (`invoice-service.test.js`) proves danger #3 is closed:

```js
  it('ignores client-supplied totals entirely — only qty/rate/discount/tax feed the computation', async () => {
    const doc = await createDraftInvoice(actor, {
      partyId: party.id,
      docDate: '2025-07-20',
      lines: [{ ...line(), grandTotal: '1.00', taxableAmount: '1.00', taxAmount: '1.00', lineTotal: '1.00' }],
    });

    expect(doc.grandTotal.toFixed(2)).toBe('135600.00'); // computed, not the '1.00' the client sent
  });
```

---

## 5. The complete request flow

This section traces the three important journeys end to end. Every component named here is explained
in section 4 or section 6.

### 5.1 Creating a draft invoice

```
Browser
  │  POST /api/v1/invoices
  │  Authorization: Bearer eyJhbGci...
  │  X-Organization-Id: 7d7b2624-...
  │  { partyId, docDate, lines: [ { accountId, quantity, unitPrice, taxCodeId } ] }
  ▼
Express (backend/src/app.js)
  │  request-ID middleware  → req.id = a fresh UUID
  │  auditLog middleware    → registers a res.on('finish') listener, calls next()
  │  helmet, cors, express.json  → req.body is now a JavaScript object
  ▼
invoicesRouter (backend/src/routes/invoices.js)
  │  authenticate    → verifies the JWT, sets req.userId
  │  resolveTenant   → verifies membership, sets req.organizationId + req.roleId,
  │                    opens the AsyncLocalStorage context
  │  authorize('invoice.create')  → database lookup: does this role have it?
  ▼
Route handler
  │  createInvoiceSchema.parse(req.body)   → Zod; unknown keys rejected
  ▼
createDraftInvoice()  (backend/src/lib/invoices/invoice-service.js)
  │  BEGIN transaction
  │  ├─ find the party (tenant-filtered)          → 404 if not ours
  │  ├─ findFiscalYearForDate()                   → 422 if no year covers the date
  │  ├─ dueDate = docDate + party.creditDays
  │  ├─ resolveLines()
  │  │    ├─ load accounts and tax codes in parallel
  │  │    ├─ 404 any ID not in this organization
  │  │    └─ computeLine() per line   ← line-math.js does the rounding
  │  ├─ sumLines()                    → the five document totals
  │  └─ document.create({ ..., lines: { create: [...] } })
  │  COMMIT
  ▼
Response 201  { id, status: "draft", docNo: null, grandTotal: "135600.00", lines: [...] }
  ▼
res.on('finish') fires  → writeAuditLog({ action: 'invoice.create', ... })
```

Nothing has touched the ledger. No number has been allocated. The draft can be edited or deleted
freely.

### 5.2 Posting an invoice — the important one

```
Browser
  │  POST /api/v1/invoices/6942685e-.../post
  ▼
authenticate → resolveTenant → authorize('invoice.post')
  │     (a Clerk stops here with 403 — PERM-2)
  ▼
postDocument(id, actor)   (backend/src/lib/accounting/post-document.js)
  │
  │  BEGIN TRANSACTION  (isolation: ReadCommitted)
  │
  │  1. SELECT * FROM "Document" WHERE id=? AND organizationId=? FOR UPDATE
  │        ← row is now LOCKED. A second click blocks right here.
  │        → 404 if no row
  │
  │  2. GUARDS
  │     ├─ status must be DRAFT            → 409 already_posted
  │     ├─ organization must be active     → 422 organization_read_only
  │     ├─ assertPeriodOpen()              → 422 period_locked / no_period
  │     └─ assertPermission()              → 403  (checked again, inside the transaction)
  │
  │  3. NUMBERING  (after the guards, so a failed post consumes no number)
  │     ├─ nextDocNumber()    → locks the DocumentSeries row → "INV-2082-0001"
  │     └─ nextEntryNumber()  → locks the EntrySeries row    → "JE-2082-0001"
  │
  │  4. BUILD LINES
  │     ├─ load DocumentLines with their tax codes
  │     ├─ look up account 1100 (Accounts Receivable)
  │     └─ POSTING_RULES.invoice({ ... })   ← the pure function
  │            Dr AR 135,600 (partyId set)
  │            Cr Sales 120,000
  │            Cr VAT 15,600
  │
  │  5. ASSERT BALANCE in JavaScript
  │        Σ debit == Σ credit ?           → 500 if not (a server bug)
  │
  │  6. INSERT JournalEntry + JournalLines   (status = POSTED)
  │
  │  7. UPDATE Document
  │        status = POSTED, docNo, journalEntryId,
  │        outstandingAmount = grandTotal, version + 1
  │
  │  COMMIT  ← the deferred balance trigger runs NOW, in the database
  │             all row locks release together
  ▼
Route re-reads both records, builds the response
  ▼
Response 200
  { "invoice":      { "status": "posted", "docNo": "INV-2082-0001", ... },
    "journalEntry": { "entryNumber": "JE-2082-0001",
                      "lines": [ Dr 135600.00, Cr 120000.00, Cr 15600.00 ] } }
  ▼
res.on('finish') → audit row 'invoice.posted'   ← AFTER commit, never inside
```

**If anything throws at any step**, PostgreSQL rolls back: no journal entry, no number consumed, the
document still a draft, and no audit entry claiming success.

### 5.3 The trial balance

```
Browser
  │  GET /api/v1/reports/trial-balance
  ▼
authenticate → resolveTenant → authorize('report.view')
  │     (every role has report.view — even a Viewer. PERM-4)
  ▼
One raw SQL query
  │  JournalLine ⋈ JournalEntry ⋈ Account
  │  WHERE organizationId = ? AND je.status = 'POSTED' AND entryDate BETWEEN ? AND ?
  │  GROUP BY account
  ▼
JavaScript sums the two columns using Decimal arithmetic
  ▼
Response
  { "rows": [ { "code": "1100", "debitBalance": "135600.00" },
              { "code": "2200", "creditBalance": "15600.00" },
              { "code": "4100", "creditBalance": "120000.00" } ],
    "totals":    { "debit": "135600.00", "credit": "135600.00" },
    "integrity": { "balanced": true, "difference": "0.00" } }
```

The report reads **only** journal lines. It never reads an invoice's stored total. That is what makes
it an independent check rather than an echo.

---

## 6. New concepts introduced

Only concepts that actually appear in this session's code.

**Double-entry bookkeeping.** Every financial event is recorded twice — once as a debit, once as a
credit — and the two must be equal. It is a 500-year-old error-detection scheme: if the totals do not
match, something was recorded wrong. This system enforces it in three independent places (the posting
rule constructs balanced lines, the service asserts before writing, the database trigger re-checks at
commit).

**Debit and credit.** The two columns of a journal entry. They do not mean "increase" and "decrease" —
what they mean depends on the account type. For this session it is enough that: money owed to us
(Accounts Receivable) is debited when it increases; revenue and liabilities are credited when they
increase.

**Journal entry / journal line.** The entry is the header — date, number, description. The lines are
the individual account amounts. Together they are the accounting record.

**Document vs ledger.** A document (invoice, receipt) is an *input* — evidence. The ledger is the
*record*. Posting is the act of reading a document and writing a ledger entry. Once posted, the
document is frozen; corrections happen by issuing another document, never by editing.

**Chart of accounts.** The list of accounts a business uses, each with a code. `1100` Accounts
Receivable, `4100` Sales Revenue, `2200` VAT Payable. Codes are grouped by type: 1000s assets, 2000s
liabilities, 3000s equity, 4000s revenue, 5000s expenses.

**Control account.** A ledger account whose balance must equal the total of a detailed list kept
elsewhere. Accounts Receivable is one: its balance must equal the sum of what all customers owe. This
is why manual entries are forbidden from touching them (test PERM-6) — a hand-typed entry would break
the agreement with no way to trace it.

**Subledger.** The detailed list behind a control account — here, the per-invoice `outstandingAmount`
values. Test INV-3 continuously proves the subledger and the ledger agree.

**Fiscal year and accounting period.** The financial year (here `2082/83`, mid-July to mid-July) and
its twelve months. Periods can be *closed*, after which nothing may be posted into them, so published
figures cannot change retroactively.

**Trial balance.** A report listing every account's debit and credit totals, whose purpose is to prove
they are equal overall.

**Decimal arithmetic.** Storing money as exact decimal digits rather than binary floating point.
`0.1 + 0.2` is `0.30000000000000004` in ordinary JavaScript numbers and exactly `0.3` in Decimal. Money
must always use the latter.

**ROUND_HALF_UP.** A rounding rule where exactly half rounds upward: `187.575` → `187.58`. Chosen so
the arithmetic matches what an accountant does by hand.

**Rounding boundary.** A named point in a calculation where the result is rounded before being used
further. This system rounds at discount, tax, and line total, then sums already-rounded values. Where
you round changes the answer.

**Pure function.** A function that returns the same output for the same input and changes nothing
outside itself — no database, no clock, no randomness. The posting rules are pure, which is why they
test in milliseconds.

**Database transaction.** A group of operations that all succeed or all fail. `BEGIN` starts it,
`COMMIT` makes it permanent, `ROLLBACK` undoes everything. In this code, throwing an error is what
triggers the rollback.

**Isolation level.** How strictly concurrent transactions are insulated from each other.
`ReadCommitted` — used here — means a transaction sees only data other transactions have committed.

**Row lock (`SELECT ... FOR UPDATE`).** Reads a row and prevents any other transaction from reading it
the same way until yours finishes. Used on the invoice being posted (so it cannot be posted twice) and
on the numbering counters (so two invoices cannot get the same number).

**Pessimistic vs optimistic concurrency.** Pessimistic locks the row up front and makes others wait —
used for posting. Optimistic lets everyone proceed and detects the collision at save time via a
version number — used for draft editing. Locking a draft while a user thinks would block everyone
else; detecting a rare collision afterwards is better.

**Version number / optimistic concurrency control.** A counter on each row. The client must send back
the version it was shown; the update only applies if the version still matches. Zero rows updated
means someone else got there first — HTTP 409.

**Deferred constraint trigger.** A database check that runs at `COMMIT` rather than on each statement.
Essential for the balance rule: while lines are being inserted one at a time, the entry is temporarily
unbalanced, and an immediate check would reject it.

**`CHECK` constraint.** A rule the database enforces on every write, such as
`outstandingAmount >= 0`. It holds regardless of which application code did the writing.

**Partial index.** An index covering only rows matching a condition — here, only invoices with money
outstanding. Keeps the index small and the aging report fast.

**Denormalisation.** Deliberately storing a value that could be computed, for speed.
`Document.outstandingAmount` is denormalised; the price is that a test must continuously prove it
still agrees with the ledger.

**Gapless numbering.** Document numbers with no missing values in the sequence. Achieved with a
counter row locked inside the same transaction, so a failed posting returns the number. A PostgreSQL
sequence would be simpler but leaves gaps, since sequences do not roll back.

**Enum.** A column restricted to a fixed list of values, enforced by the database.

**Raw SQL and parameterised queries.** Prisma's `$queryRaw` sends the query text and the values
separately, so a value can never be executed as SQL. This is what prevents **SQL injection**. The
`Unsafe` variants concatenate strings and do not have this protection.

**N+1 query problem.** Fetching a list, then making one extra query per item. Prisma's `include`
avoids it by fetching related rows in the same query.

**Serialization.** Converting internal objects into the JSON shape sent to clients. Money is
serialized as a *string* (`"135600.00"`) so JSON's floating-point numbers cannot reintroduce rounding
errors.

**Separation of duties.** A control where the person who prepares a document is not the person who
commits it. Here, a Clerk has `invoice.create` but not `invoice.post`.

---

## 7. Errors and debugging

Every problem below actually happened during this session. None are hypothetical.

### 7.1 The tenant extension does not reach nested writes

**What happened.** After adding `organizationId` to `JournalLine` and running the test suite, four
previously-passing tests in `backend/src/db/triggers.test.js` failed.

**The error message.**

```
PrismaClientValidationError:
Invalid `prisma.journalEntry.create()` invocation

    lines: {
      create: [
        { accountId: "9cd5ff9b-...", debit: "25.00", credit: "0", lineNumber: 1 },
        ...
      ]
    }

Argument `organization` is missing.
```

**Why it happened.** The Day 2 tenant extension automatically fills in `organizationId`. Reading its
code shows exactly how far that reaches:

```js
        async $allOperations({ model, operation, args, query }) {
          const organizationId = requestContext.getStore()?.organizationId;
          if (!organizationId || !TENANT_SCOPED_MODELS.has(model)) {
            return query(args);
          }
          ...
          if (operation === 'create') {
            args.data = { ...args.data, organizationId };
          }
```

It hooks **operations on a model**. `prisma.journalEntry.create(...)` is an operation on
`JournalEntry`, so the entry gets its `organizationId`. But the lines are created through
`lines: { create: [...] }` *nested inside* that same operation — they are not a separate
`journalLine.create` call, so the extension never sees them. `JournalLine.organizationId` was now
required, and nothing was supplying it.

The error message is confusing on first reading. It says `Argument \`organization\` is missing` —
naming the *relation*, not the column. Prisma reports the missing relation because from its point of
view every created row must connect to an `Organization` somehow.

**How we diagnosed it.** The test output pointed at the `create` call but not at which part. Running a
single test in isolation and reading the full data payload Prisma echoed back showed the nested lines
had no `organizationId` while the parent entry did. That asymmetry was the clue.

**The fix.** Pass it explicitly in every nested write. In `backend/src/db/triggers.test.js`:

```js
        lines: {
          create: [
            { organizationId: org.id, accountId: cash.id, debit: '100.00', credit: '0', lineNumber: 1 },
            { organizationId: org.id, accountId: revenue.id, debit: '0', credit: '100.00', lineNumber: 2 },
          ],
        },
```

The same applies in production code — `post-document.js` step 6 sets `organizationId` on every nested
line for exactly this reason.

**The lesson.** Know the limits of your automatic protections. The tenant extension is excellent, but
it guards top-level operations only. Any nested relation write must set the tenant column by hand. It
is worth remembering that this is a *safety* boundary, not just a convenience one — a nested write is
a place where the automatic filter is absent.

---

### 7.2 `Decimal.toString()` silently drops trailing zeros

**What happened.** Three assertions in the new `line-math.test.js` failed on what looked like
identical values.

**The error message.**

```
AssertionError: expected '120000' to be '120000.00' // Object.is equality

Expected: "120000.00"
Received: "120000"
```

**Why it happened.** `Decimal.toString()` produces the shortest exact representation. The *value* is
120000.00, but trailing zeros carry no numerical information, so `toString()` omits them. For money
that is wrong presentationally — a total should always show two decimal places.

**How we diagnosed it.** The message says it plainly once you notice the values are numerically equal
and differ only in formatting. The mistake was in the test's expectation, not in `round2`.

**The fix.** `.toFixed(2)` instead of `.toString()` wherever a money value is compared or serialized:

```js
    expect(line.taxableAmount.toFixed(2)).toBe('120000.00');
```

`toFixed(2)` always produces exactly two decimal places.

**The lesson.** Distinguish a value from its representation. `round2` was correct — it returned a
Decimal rounded to two places. What was wrong was asking for a string in a format that does not
preserve them. This is why every serializer in this session uses `toFixed(2)`, and why money crosses
the API as a string.

---

### 7.3 A test expectation that was simply wrong arithmetic

**What happened.** A `posting-rules.test.js` case failed.

**The error message.**

```
AssertionError: expected [ 1, 2, 3, 4 ] to deeply equal [ 1, 2, 3 ]
```

**Why it happened.** The test built an invoice with two lines on **different revenue accounts**, both
using the same VAT code, and expected three journal lines. The correct answer is four: one AR debit,
**two** revenue credits (different accounts are never merged), and one merged VAT credit. The
implementation was right and the expectation was wrong.

**How we diagnosed it.** By counting what the posting rule should produce, from its own rules: revenue
lines stay separate, tax lines merge by account.

**The fix.** Correct the expectation and record the reasoning so the next reader does not repeat the
confusion:

```js
    expect(lines.map((l) => l.lineNumber)).toEqual([1, 2, 3, 4]); // AR + 2 revenue lines + 1 merged VAT line
```

**The lesson.** A failing test does not prove the code is wrong. It proves code and test disagree.
Work out which one is right from first principles before changing either — and when the answer is
non-obvious, leave the reasoning in a comment.

---

### 7.4 Writing a computed field that has no column

**What happened.** Six tests failed the moment `invoice-service.js` first tried to save a draft.

**The error message.**

```
PrismaClientValidationError:
Invalid `tx.document.create()` invocation

               discountPct: new Prisma.Decimal("0"),
               taxCodeId: "d81db5ef-...",
               discountAmount: new Prisma.Decimal("0"),
               ...

Unknown argument `discountAmount`. Available options are marked with ?.
```

**Why it happened.** `computeLine()` returns four values: `discountAmount`, `taxableAmount`,
`taxAmount`, `lineTotal`. `resolveLines` spread all four into the object handed to Prisma:

```js
    return {
      lineNo: i + 1,
      ...
      ...computed,      // ← all four, including discountAmount
    };
```

But `DocumentLine` has no `discountAmount` column. The schema (following the plan's §5) stores
`discountPct` per line; the *amount* exists only as an intermediate value that `sumLines` needs for
the document-level total. Prisma correctly refused to write a field that does not exist.

**How we diagnosed it.** The error names the offending key precisely. Cross-checking `schema.prisma`
confirmed the column genuinely is not there — and that this was intentional, not an oversight.

**The fix.** A small helper that removes the key just before writing, leaving it available everywhere
else:

```js
function toDocumentLineData({ discountAmount: _discountAmount, ...line }) {
  return line;
}
```

**The lesson.** Spreading a computed object straight into a database call couples the shape of your
calculation to the shape of your table. They are related but not identical, and the difference is
where bugs live. An explicit conversion at the boundary makes the mismatch visible.

---

### 7.5 A missing import surfacing as a confusing type error

**What happened.** One `post-document.test.js` assertion failed with an error that mentioned neither
imports nor the real problem.

**The error message.**

```
TypeError: Cannot read properties of undefined (reading 'plus')
 ❯ src/lib/accounting/post-document.test.js:154:49
    const totalDebit = lines.reduce((t, l) => t.plus(l.debit), sales.debit.constructor(0));
```

**Why it happened.** The test needed a zero `Decimal` as the starting value for `reduce`, and had not
imported `dec`. The improvised substitute `sales.debit.constructor(0)` tried to reach the Decimal
class through an existing instance — but calling a class without `new` returns `undefined`, so the
accumulator started as `undefined` and `undefined.plus(...)` threw.

**How we diagnosed it.** The message points at `.plus` on something undefined. Since `l.debit` is
clearly defined, the only other candidate was the initial value.

**The fix.** Import the helper that already exists:

```js
import { dec } from '../money.js';
...
    const totalDebit = lines.reduce((t, l) => t.plus(l.debit), dec(0));
```

**The lesson.** When you find yourself reaching for a value through `.constructor`, stop — you are
working around a missing import. `money.js` exists precisely so nothing else has to improvise a
Decimal.

---

### 7.6 The due-date bug — found by audit, not by tests

This is the most instructive failure of the session, because every test passed while it was present.

**What happened.** During a post-implementation audit, driving the real API with a customer on 15-day
payment terms produced the wrong due date after an edit:

```
=== PATCH changing docDate WITHOUT partyId — due date recompute ===
draft2 dueDate (create): "2025-08-04"
patched dueDate — should be 2025-08-16 (docDate + party 15 days): "2025-08-31"
```

`2025-08-31` is `2025-08-01` plus **30** days, not 15.

**Why it happened.** `updateDraftInvoice` only loaded the party when the request supplied a `partyId`.
Otherwise it invented a placeholder:

```js
    let party = { id: existing.partyId, creditDays: 30 };
    if (input.partyId) {
      const found = await tx.party.findFirst({ ... });
      party = found;
    }
```

The `30` was a plausible-looking default that silently overrode the customer's real terms whenever an
edit changed the document date without also changing the customer — the most common kind of edit.

**Why the tests did not catch it.** Every existing test used a party whose `creditDays` was 30. The
placeholder and the truth agreed, so the bug was invisible. The tests were not weak in an obvious
way; they simply never varied the one value that mattered.

**Why it matters more than it looks.** `dueDate` is what the Day 4 aging report buckets by. Every
edited invoice would have landed in the wrong overdue bucket, and the report would have looked
entirely plausible while being wrong.

**How we diagnosed it.** By writing a temporary probe script that drove the real HTTP API with a party
deliberately given `creditDays: 15` — a value no test used — and printing what came back. The
discrepancy was immediately visible.

**The fix.** Always load the real party, and be explicit about when a due date should be recomputed:

```js
    // Always load the real party — its creditDays drives the due date, so
    // assuming a default here would silently write the wrong one.
    const partyId = input.partyId ?? existing.partyId;
    const party = await tx.party.findFirst({ where: { id: partyId, organizationId: actor.organizationId } });
    if (!party) throw notFound('Party not found');
    ...
    // An explicit dueDate always wins. Otherwise recompute only when one of
    // its two inputs actually changed — so an unrelated edit never silently
    // overwrites a due date the user set by hand earlier.
    const dueDateChanged = input.docDate || (input.partyId && input.partyId !== existing.partyId);
```

Two regression tests were added — one using a 15-day party (so the 30-day default could never pass
again), one proving a hand-set due date survives an unrelated edit.

**The lesson.** Two lessons, actually. First: **a hardcoded default in place of a real lookup is a
bug waiting for the right data to expose it.** If a value comes from a record, load the record.
Second: **tests that all use the same fixture value cannot detect a bug in that value.** Deliberately
vary the data that drives a calculation, especially away from the defaults.

---

### 7.7 A test whose name promised more than it tested

**What happened.** During the same audit, a test in `invoices.test.js` named
`"reflects VAT and rounds at each boundary when a tax code is used"` turned out never to send a tax
code at all. Its own body admitted it:

```js
    // No taxCodeId sent this time either — exercise the discount boundary without tax.
    expect(created.body.taxAmount).toBe('0.00');
```

**Why it happened.** The shared `invoiceBody()` helper set `taxCodeId: undefined`, and the test was
written against that helper without overriding it. The assertions were all correct — they just tested
discount rounding, not VAT.

**Why it matters.** VAT was well covered at the unit and service level, but the *HTTP* path — where a
`taxCodeId` travels through Zod validation, gets resolved to a rate, and ends up crediting the right
account — had no coverage. A misleading name is worse than no test, because it makes a reader believe
the gap is filled.

**How we diagnosed it.** Reading the test bodies rather than the test names while auditing coverage,
then confirming with the probe script that VAT genuinely did work end to end:

```
journal lines: [{"acct":"AR","debit":"135600.00","credit":"0.00"},
                {"acct":"SALES","debit":"0.00","credit":"120000.00"},
                {"acct":"VAT","debit":"0.00","credit":"15600.00"}]
```

**The fix.** Rename the existing test to what it actually does
(`"rounds the discount boundary correctly with no tax code"`) and add a real one that sends a tax code
and asserts the VAT account is credited `15600.00`.

**The lesson.** A test name is a claim about coverage. When auditing, read what tests *do*, not what
they are called. Green does not mean covered.

---

### 7.8 The migration that would have failed on real data

Not a failure, but a trap avoided — worth recording because it is the kind that only bites in
production.

Prisma's generated migration contained this warning:

```
  - Added the required column `organizationId` to the `JournalLine` table without a default value.
    This is not possible if the table is not empty.
```

The tempting response is `npx prisma migrate reset` — wipe the development database and move on. It
works locally, and it would fail the first time the migration met a database with real rows in it.

The migration was instead hand-edited into add-nullable → backfill → set-NOT-NULL, as shown in section
4.14. It now works on an empty database *and* on one with data.

**The lesson.** A migration is code that runs exactly once against data you cannot afford to lose.
When a tool warns that a change is impossible on a non-empty table, the fix is to write the three-step
version, not to empty the table.

---

## 8. Final understanding check

If any of these do not come readily, the linked section is worth re-reading.

### On what we built

1. What does "post an invoice" actually mean? Name every database row that changes.
2. Why does a draft invoice have no `docNo`? When is the number allocated, and what happens to the
   number if posting fails?
3. What are the three journal lines produced by a 135,600 invoice with 13% VAT, and which one carries
   the customer ID? Why that one and not the others?
4. Why is there a separate `post-manual-entry.js` instead of routing manual entries through
   `postDocument()`?

### On the accounting reasoning

5. Why is VAT credited to a liability account rather than counted as revenue?
6. What is a control account, and why is a manual journal entry forbidden from touching one? What
   specifically breaks if that rule is removed?
7. Why does the invoice posting rule merge VAT lines that share an account, but never merge revenue
   lines?
8. Why does a zero-tax line produce no VAT journal line at all, rather than one for 0.00?

### On money and rounding

9. Why can money not be stored in an ordinary JavaScript number? Give the concrete example.
10. Walk through `computeLine` for quantity 3 at 1,250.50 with 5% discount and 13% VAT. At which
    points does rounding happen, and what would change if you rounded only at the end?
11. Why does the API send `"135600.00"` as a string rather than the number `135600`?
12. Why did four tests fail with `expected '120000' to be '120000.00'`, and what was actually wrong?

### On concurrency and safety

13. A user double-clicks Post. Trace exactly what each of the two requests does. Which line of code
    prevents a double post, and what would happen without it?
14. Why is `MAX(doc_no) + 1` numbering dangerous? Why is a PostgreSQL sequence also rejected here?
15. What is the difference between the optimistic concurrency on draft editing and the pessimistic
    lock used when posting? Why is each the right choice for its situation?
16. `updateDraftInvoice` uses `updateMany` rather than `update`. Why does that choice matter?
17. Why must the balance trigger be *deferred*? What would break if it ran on every row insert?

### On architecture

18. Why are the posting rules pure functions? What does that buy, and what does it cost?
19. `postDocument` checks permission even though `authorize('invoice.post')` middleware already ran.
    Why is that not pointless duplication?
20. Why is the audit log written in `res.on('finish')` rather than inside the posting transaction?
21. Why does every accounting function take `tx` as a parameter instead of importing `prisma`
    directly?
22. The trial balance query includes `AND je.status = 'POSTED'`. What would the report show without
    it, and why does that matter?
23. Why does `POST /invoices/preview` exist at all, when the browser could compute totals itself?

### On security

24. Requesting another company's invoice returns 404 rather than 403. Why is that a security decision
    and not just a style choice?
25. What stops a user editing `grandTotal` in their browser and posting an invoice for one rupee?
    Name the exact function that prevents it.
26. Why does `assertPermission` query the database instead of reading permissions from the JWT?
27. The raw SQL in `document-numbering.js` interpolates values with `${...}`. Why is that not SQL
    injection? What would make it dangerous?

### On the request lifecycle

28. Trace `POST /api/v1/invoices/:id/post` from browser to database and back, naming every middleware
    and every guard in order.
29. At which exact point does a Clerk's post attempt stop, and with what status code?
30. If `assertPeriodOpen` throws, what has already happened in the database, and what happens to it?

### On debugging

31. Why did adding `organizationId` to `JournalLine` break tests that create journal entries? What is
    the limit of the tenant extension that this exposed?
32. The due-date bug passed every test. Explain why, and what kind of test data would have caught it
    sooner.
33. A test is named "reflects VAT" but sends no tax code. Why is that worse than having no test at
    all?
34. Why was the `JournalLine.organizationId` migration hand-edited instead of resetting the database?

### On the development plan

35. Which Day 3 objectives are complete, and which parts of the accounting engine are deliberately
    left for Day 4?
36. Two schema gaps were found during this session that the plan's §5 did not specify. What were they,
    and why did each only become visible when writing the posting rule?
37. What must change about the Day 1 immutability trigger before `reverseEntry()` can be built, and
    why does that not affect anything in Day 3?

---

## Quick reference

**Start the database**
```
docker compose up -d
```

**Run the backend**
```
cd backend
npm run dev
```

**Run all tests** (this truncates the database)
```
cd backend
npm test
npm run seed     # restore demo data afterwards
```

**Run one test file**
```
npx vitest run src/lib/accounting/post-document.test.js
```

**Apply a schema change**
```
npx prisma migrate dev --name describe_the_change
npx prisma generate
```

**Create a migration without applying it** (needed when you must hand-edit the SQL)
```
npx prisma migrate dev --name describe_the_change --create-only
```

### The Day 3 endpoints

| Method | Path | Permission |
|---|---|---|
| `POST` | `/api/v1/invoices/preview` | `invoice.create` |
| `POST` | `/api/v1/invoices` | `invoice.create` |
| `GET` | `/api/v1/invoices?status=&partyId=&page=` | `report.view` |
| `GET` | `/api/v1/invoices/:id` | `report.view` |
| `PATCH` | `/api/v1/invoices/:id` | `invoice.create` |
| `POST` | `/api/v1/invoices/:id/post` | `invoice.post` |
| `POST` | `/api/v1/journal-entries` | `journal.post` |
| `GET` | `/api/v1/journal-entries?page=` | `report.view` |
| `GET` | `/api/v1/journal-entries/:id` | `report.view` |
| `GET` | `/api/v1/reports/trial-balance?from=&asOf=` | `report.view` |

### Error codes introduced this session

| Code | HTTP | Meaning |
|---|---|---|
| `already_posted` | 409 | The document has already been posted |
| `version_conflict` | 409 | Someone else edited this draft first |
| `not_draft` | 409 | Only drafts can be edited |
| `period_locked` | 422 | The accounting month is closed |
| `no_period` | 422 | No accounting period covers that date |
| `no_fiscal_year` | 422 | No fiscal year covers that date |
| `organization_read_only` | 422 | The organization is deactivated |
| `empty_invoice` | 422 | An invoice needs at least one line |
| `empty_entry` | 422 | A journal entry needs at least one line |
| `manual_entry_not_allowed_on_control_account` | 422 | PERM-6 |

### The accounting engine at a glance

```
routes/invoices.js
   │
   ├── invoice-service.js ──── line-math.js ──── money.js
   │      (drafts)              (rounding)       (Decimal)
   │
   └── post-document.js ─┬── posting-rules.js   (pure: document → lines)
        (the one door)   ├── document-numbering.js (locked counters)
                         ├── period-lock.js        (is the month open?)
                         ├── fiscal-year.js        (which year?)
                         └── chart-of-accounts.js  (AR is 1100)

routes/journal-entries.js ── post-manual-entry.js ── posting-rules.js
routes/reports.js ────────── raw SQL over JournalLine WHERE status = 'POSTED'
```
