# Day 4 — Cash: Receipts, Allocation, Credit Notes, Reversal, and AR Reporting

This document explains everything built in the Day 4 backend session, from zero. It uses the actual
LedgerLine codebase as the source of truth. Every code block below is copied from a real file in
this repository, and every file path is exact.

Commit: `17b69f9 — Day 4 backend: receipts, allocation, credit notes, reversal, period lock, AR/GL reports`
(23 files changed, 1922 insertions, 61 deletions)

Test count: **88 → 108 tests**, all passing. Lint clean.

**Scope note.** This session covered the *backend half* of Day 4 only (Developer A's slice in the
plan). The Day 4 frontend work — receipt screen, AR aging screen, general ledger drill-down,
dashboard v1 — was deliberately not started. Section 2 explains exactly what that leaves open.

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

Before this session, LedgerLine could do exactly one financial thing end to end: **create an invoice
and post it to the ledger**.

In plain language, "post to the ledger" means: take a business document (an invoice) and turn it
into a permanent, balanced accounting record. Day 3 built that. You could create a draft invoice,
click post, and the system would write a *journal entry* — the accounting record — saying "the
customer now owes us 135,600, of which 120,000 is revenue and 15,600 is VAT we collected for the
government."

You could also type a manual journal entry by hand, and you could run a trial balance report.

**But money could only ever flow in one direction.** There was no way to record that a customer
actually *paid*. The invoice sat there saying "owed: 135,600" forever. There was no way to correct
a mistake either — no way to say "the customer returned two items, reduce what they owe" and no way
to say "I posted that to the wrong account, undo it."

That is what this session built.

### The six problems we solved

---

**Problem 1 — There was no way to record a customer payment.**

*What was wrong before:* An invoice was posted and the customer owed money. The customer wires the
money to your bank. Nothing in the system could record this. The invoice's `outstandingAmount`
column existed and was set when posting, but nothing ever decreased it.

*Why it matters:* An accounting system that cannot record cash coming in is not an accounting
system. Every report — how much are we owed, who owes it, how old is the debt — depends on knowing
what has been paid.

*What we built:* `backend/src/lib/accounting/receipt-service.js` — a `postReceipt()` function that
records the cash and writes a journal entry (bank goes up, amount owed goes down), plus
`POST /api/v1/receipts` to call it over HTTP.

*Why this solution:* It funnels through the same pattern as invoice posting — locked document
number, balance assertion, one database transaction — rather than being a special case. The plan is
explicit that documents are *inputs* and the ledger is the *record*; a receipt is just another
document type.

---

**Problem 2 — One payment can settle several invoices, and that is where naive systems break.**

*What was wrong before:* Nothing existed at all. But the naive version people build is: put a
`paidAmount` column on the invoice and add to it. That version breaks the moment a customer sends
one payment of NPR 90,000 covering three different invoices, or sends 100,000 against an invoice
that only owes 35,600.

*Why it matters:* This is called **payment allocation** (also "cash application"), and the plan
calls it out as the place naive implementations fall over. The dangerous failure is
*over-allocation* — applying more money to an invoice than it owes, which silently corrupts every
downstream report and, in the worst case, means you tell a customer they are paid up when they are
not.

*What we built:* A new database table `PaymentAllocation` — a many-to-many link between a payment
document and the invoices it settles, with an amount on each link. Plus the allocation logic inside
`postReceipt()`, which locks each target invoice row before touching it and refuses any allocation
larger than what the invoice actually owes.

*Why this solution:* Three layers of defence, deliberately. The service checks the amount; the rows
are locked so two simultaneous payments cannot both read "35,600 outstanding" and both succeed; and
if both of those ever failed, the plan's `outstandingAmount >= 0` design still holds the line.
Section 4.2 explains the locking in detail.

---

**Problem 3 — A retried payment request could create two payments.**

*What was wrong before:* Day 2 built a helper called `runIdempotent` designed to prevent exactly
this, but **nothing in the codebase ever called it**. It was dead code. Worse, when we finally wired
it up, we discovered it did not actually work (see section 7.3).

*Why it matters:* Imagine the browser sends "record a payment of 100,000", the payment is recorded,
and then the network drops before the response gets back. The browser retries. Without protection,
you have now recorded 200,000. In payments this is the classic bug, and the plan flags it as a
mistake that must not happen.

*What we built:* Wired `runIdempotent` into `POST /api/v1/receipts`, and fixed a real bug in it
involving Postgres transaction semantics.

*Why this solution:* The key design decision (inherited from Day 2) is that the "I have already
seen this request" record lives in Postgres, written *inside the same transaction* as the payment
itself. Section 4.3 explains why that matters and why Redis would be worse.

---

**Problem 4 — A posted invoice cannot be edited, so how do you correct one?**

*What was wrong before:* Day 1 built database triggers that physically refuse to change a posted
journal entry. That is correct and deliberate. But it left a gap: when a customer returns two of
the fifteen backpacks they bought, what do you do?

*Why it matters:* You cannot edit the invoice — the database will not let you, and in real
accounting you should not want to. The invoice is a historical fact: on that date, you billed them
135,600. The correction is a *second document*.

*What we built:* `backend/src/lib/accounting/credit-note-service.js` — a credit note is a document
that references the original invoice via `parentDocumentId` and posts the exact mirror image of the
invoice's journal entry. Plus `POST /api/v1/credit-notes`.

*Why this solution:* Both documents survive in the record, which is how real accounting systems
work and what an auditor expects to see. The invoice's own `grandTotal` is never touched — only its
`outstandingAmount` drops.

---

**Problem 5 — There was no way to undo a posting mistake.**

*What was wrong before:* Nothing could ever be undone. If you posted a manual journal entry to the
wrong expense account, it stayed wrong forever.

*Why it matters:* A credit note corrects a *commercial* fact ("the customer returned goods"). A
reversal corrects a *posting* fact ("I typed the wrong account"). They are different things and
real systems need both.

*What we built:* `backend/src/lib/accounting/reverse-entry.js` — creates a new journal entry with
every debit and credit swapped, so the two entries net to exactly zero, then marks the original as
reversed. It also **cascades**: reversing a receipt gives the invoice its outstanding balance back
and deletes the allocation rows; reversing a credit note restores what the invoice owed.

*Why this solution:* Nothing is deleted, ever. Both entries stay in the ledger. That is the whole
philosophy of the system, and it is enforced by the database, not by good intentions.

This one required a **database migration to modify an existing trigger**, because Day 1's
immutability trigger was unconditional — it blocked *every* update to a posted entry, including the
one status change a reversal legitimately needs. Section 4.5 covers this in depth.

---

**Problem 6 — Two reports the plan requires did not exist, and closing a period was impossible.**

*What was wrong before:* Only the trial balance existed. There was no way to answer "who owes us
money and how overdue is it" (AR aging) or "show me every transaction that hit this one account"
(general ledger). Separately, the period-locking *enforcement* worked perfectly since Day 3 — but
there was no API endpoint to actually lock a period, so it could never be triggered in real use.

*What we built:*
- `GET /api/v1/reports/ar-aging` — who owes what, bucketed by how overdue
- `GET /api/v1/reports/general-ledger` — every line hitting one account, with a running balance
- `PATCH /api/v1/periods/:id` — the endpoint that actually closes or reopens an accounting period
- A **fix** to the trial balance query that was needed once reversal existed (section 4.6)

*Why this solution:* Both reports are computed live from the ledger, never from a stored total.
That is the central thesis of the whole project.

### Everything created

**Accounting services** (`backend/src/lib/accounting/`)
- `receipt-service.js` — records a customer payment and allocates it across invoices
- `credit-note-service.js` — posts a credit note against an existing invoice
- `reverse-entry.js` — reverses a journal entry and cascades to its source document
- `document-lines.js` — shared line/tax computation, extracted so credit notes can reuse it

**HTTP routes** (`backend/src/routes/`)
- `receipts.js` — `POST /receipts`, `GET /receipts/:id`
- `credit-notes.js` — `POST /credit-notes`, `GET /credit-notes/:id`

**Database**
- `backend/prisma/migrations/20260815065649_day4_receipts_credit_notes_reversal/migration.sql`

**Tests**
- `backend/src/lib/accounting/receipt-service.test.js` — 5 tests (INV-7, CONC-1, happy paths)
- `backend/src/lib/accounting/credit-note-service.test.js` — 2 tests
- `backend/src/lib/accounting/reverse-entry.test.js` — 4 tests (INV-8, cascade)
- `backend/src/routes/receipts.test.js` — 4 tests (IDEM-1, IDEM-2, IDEM-3, INV-3)
- `backend/src/routes/reports.test.js` — 4 tests (AR aging, GL, INV-10)

### Everything modified

- `backend/prisma/schema.prisma` — added the `PaymentAllocation` model and
  `JournalEntry.reversalOfId`
- `backend/src/lib/accounting/posting-rules.js` — added the `receipt` and `creditNote` rules
- `backend/src/lib/invoices/invoice-service.js` — now imports the shared line resolution instead of
  defining its own copy (60 lines deleted, no behaviour change)
- `backend/src/lib/idempotency/run-idempotent.js` — **bug fix**: added a Postgres savepoint
- `backend/src/routes/journal-entries.js` — added `POST /journal-entries/:id/reverse`
- `backend/src/routes/masters.js` — added `PATCH /periods/:id`
- `backend/src/routes/reports.js` — added two reports; fixed the trial balance status filter
- `backend/src/db/tenant-extension.js` — added `PaymentAllocation` to the tenant-scoped model list
- `backend/src/test/helpers.js` — added `PaymentAllocation` to the test database reset
- `backend/src/app.js` — mounted the two new routers
- `backend/src/lib/accounting/post-document.test.js` — added the CONC-2 concurrency test

---

## 2. How it relates to the 7-day plan

This session is **Day 4 — Cash: receipts, allocation, aging** (`ledgerline-7-day-plan_1.md`,
line 1477).

### The plan's Day 4 goals for Developer A (backend)

> - Receipt posting rule; receipt service with allocation (row-locked in ID order, sum-constrained).
> - Credit note posting rule + `parent_document_id` linkage.
> - `reverseEntry()` with cascade to source documents.
> - Period lock enforcement wired to the API.
> - `GET /reports/ar-aging`, `GET /reports/general-ledger`.
> - Tests: INV-3, INV-7, INV-8, INV-10, IDEM-1..3, **CONC-1, CONC-2**.

### The plan's Day 4 goals for Developer B (frontend)

> - Receipt screen: pick customer → open invoices load with outstanding amounts → allocate across several → live "unallocated remainder" indicator.
> - Invoice detail: payment history section, outstanding recalculated.
> - AR Aging screen with the bucket table **and the AR-control-account reconciliation line underneath**.
> - General Ledger / account drill-down with running balance; clickable rows into source documents.
> - Dashboard v1: total receivables, overdue, revenue this period, cash at bank.

**None of the Developer B items were built this session.** This was a deliberate scope choice made
at the start of the session, not an oversight.

### Plan → What we built → Why it matters

| Plan objective | What we built | Why it matters |
|---|---|---|
| Receipt posting rule | `POSTING_RULES.receipt` in `posting-rules.js` | A pure function, unit-testable with no database, same shape as the Day 3 invoice rule. Proves the posting engine is genuinely document-type agnostic. |
| Receipt service, row-locked in ID order, sum-constrained | `lib/accounting/receipt-service.js` | Locking in ID order is what stops two simultaneous receipts from deadlocking. Sum-constrained is what stops over-allocation. |
| Credit note rule + `parent_document_id` | `POSTING_RULES.creditNote`, `lib/accounting/credit-note-service.js` | Correction without mutation — the invoice survives untouched, and the link back to it is a real foreign key. |
| `reverseEntry()` with cascade | `lib/accounting/reverse-entry.js` + migration | Correcting a posting mistake without deleting anything. The cascade is what keeps documents and ledger in agreement. |
| Period lock wired to the API | `PATCH /periods/:id` in `routes/masters.js` | The *enforcement* already existed from Day 3; what was missing was any way to actually lock a period. |
| `GET /reports/ar-aging` | `routes/reports.js` | Credit-risk reporting, computed live from open invoices, self-checked against the AR control account. |
| `GET /reports/general-ledger` | `routes/reports.js` | Account drill-down with a running balance, each row linked to its source document. |
| Tests INV-3, INV-7, INV-8, INV-10 | 4 new test files | The accounting invariants — subledger equals ledger, no over-allocation, reversal nets to zero, period lock enforced. |
| Tests IDEM-1..3 | `routes/receipts.test.js` | Proves a retried payment does not become two payments. Found a real bug doing it. |
| Tests CONC-1, CONC-2 | `receipt-service.test.js`, `post-document.test.js` | The plan says "CONC-1 is the test that makes experienced reviewers stop scrolling." |

### What is completed

Every Developer A objective above is implemented and tested. The full backend suite is 108 tests,
all passing, lint clean, and `npm run seed` still works unchanged.

### What is incomplete, and why

**The entire Day 4 frontend.** The five Developer B items listed above are not started. The backend
endpoints they need all exist and are tested, so this is genuinely "the UI has not been written",
not "the feature is missing".

The plan's own Day 4 checkpoint is:

> receive a partial payment, see the invoice flip to `partially_paid`, see AR aging update, see the
> trial balance still balance.

The *data* half of that checkpoint is proven by automated test — `receipts.test.js` posts a partial
payment and asserts the invoice flips and the AR control account still agrees with the invoice
subledger. The *"see"* half needs the frontend.

**Deliberately deferred beyond Day 4** (these are not Day 4 items; the plan schedules them later):

- **CONC-3** (two concurrent allocations touching the same two invoices in opposite order → no
  deadlock). The plan lists CONC-1 and CONC-2 as the Day 4 tests and CONC-3 separately. The
  ordered-lock rule that would make it pass *is* implemented — it is the `.sort()` in
  `receipt-service.js` — but the test proving it is not written.
- **INV-2 and INV-4** — property tests over random operation sequences. Plan schedules these Day 6
  (line 1523), and they need the `fast-check` library, which is not installed.
- **The golden end-to-end test** — Day 6, and it needs the Day 5 bank reconciliation to exist first.
- **Accounts Payable** (bills, supplier payments) — a "SHOULD HAVE", not a MUST. `BILL` and
  `SUPPLIER_PAYMENT` already exist in the `DocType` enum but nothing is wired to them.
- **Refunding a credit note against a fully-paid invoice.** We deliberately refuse this with a
  `credit_exceeds_outstanding` error. Explained in section 3.4.

### How this prepares the next days

**Day 5 (banking and reconciliation)** needs to match bank statement lines against ledger
movements. Every receipt now writes a journal line hitting a bank account with a date and an amount
— which is exactly what the matching engine will search. Day 5 also needs to create a journal entry
directly from an unmatched statement line (a bank charge); `reverseEntry`'s "build lines, assert
balance, write entry" shape is the pattern to copy.

**Day 5 reports** (P&L, balance sheet) will be written into `routes/reports.js` alongside the two
added here, and must use the same `status IN ('POSTED', 'REVERSED')` filter — section 4.6 explains
why getting this wrong silently breaks every report.

**Day 6 (hardening)** will write the property tests that stress everything built here.

**One constraint to carry forward:** `postReceipt` accepts an optional transaction parameter so it
can run inside the idempotency wrapper. Any future service that needs idempotency (supplier
payments, for example) must follow the same shape. Section 4.3 explains why.

---

## 3. Files created and modified

### 3.1 Database schema and migration

---

**File:** `backend/prisma/schema.prisma`

**Status:** Modified

**Purpose:** This one file describes every table in the database. Prisma reads it and generates
both the SQL to create those tables and the JavaScript code we use to query them.

**Why does this file change?** Two new things need to be stored permanently: the link between a
payment and the invoices it settles, and the link between a reversal entry and the entry it
reverses. Neither could be expressed with the existing tables.

**How does it connect to other files?** Everything. `backend/src/db/client.js` generates a client
from it; every service queries through that client.

#### Change 1 — the `PaymentAllocation` model

```prisma
// A receipt (paymentDocument) applied against one or more open invoices
// (targetDocument) — many-to-many, partial (§5 payment_allocations). One
// receipt settling three invoices, or three receipts settling one.
model PaymentAllocation {
  id                String   @id @default(uuid())
  organizationId    String
  paymentDocumentId String
  targetDocumentId  String
  amount            Decimal  @db.Decimal(18, 4)
  allocatedAt       DateTime @default(now())
  createdById       String?

  organization    Organization @relation(fields: [organizationId], references: [id], onDelete: Restrict)
  paymentDocument Document     @relation("AllocationPaymentDocument", fields: [paymentDocumentId], references: [id], onDelete: Restrict)
  targetDocument  Document     @relation("AllocationTargetDocument", fields: [targetDocumentId], references: [id], onDelete: Restrict)

  @@unique([paymentDocumentId, targetDocumentId])
  @@index([organizationId, targetDocumentId])
}
```

#### Reading this code from zero

**What is a database table?** A table is a grid. Each row is one record; each column is one piece
of information about it. A `PaymentAllocation` row means: "NPR 50,000 of receipt X was applied to
invoice Y."

**What is a model in Prisma?** A `model` block describes one table. The name becomes the table name,
and each line inside becomes a column.

**Reading the columns:**

```prisma
  id                String   @id @default(uuid())
```

`id` is the column name. `String` is the type — text. `@id` marks it the **primary key**, the
column that uniquely identifies each row; no two rows may share one. `@default(uuid())` means if we
do not supply a value, generate a UUID — a long random identifier like
`3f2a9c14-8b7e-4d1a-9f03-2c5e7a8b1d64`.

**Why UUIDs and not 1, 2, 3?** The plan is explicit (§5 conventions): sequential integers leak
business volume (a competitor seeing invoice #4,182 learns how many invoices you have issued) and
invite *IDOR probing* — typing `/invoices/5` to see if someone else's invoice loads. A UUID cannot
be guessed.

```prisma
  amount            Decimal  @db.Decimal(18, 4)
```

`Decimal` is a number type that stores digits exactly. `@db.Decimal(18, 4)` means: up to 18 total
digits, 4 of them after the decimal point.

**Why not a normal number?** Because computers store ordinary decimal numbers (called *floats*) in
binary, and some decimal values have no exact binary form — exactly like 1/3 has no exact decimal
form. In JavaScript, `0.1 + 0.2` gives `0.30000000000000004`. In money that is a lost paisa, and
lost paisa are what make a trial balance fail to balance. `Decimal` avoids this by storing the
digits themselves rather than an approximation.

```prisma
  createdById       String?
```

The `?` means **optional** — this column may be empty (`NULL` in database terms). Every other
column here is required.

**Reading the relations:**

```prisma
  paymentDocument Document     @relation("AllocationPaymentDocument", fields: [paymentDocumentId], references: [id], onDelete: Restrict)
  targetDocument  Document     @relation("AllocationTargetDocument", fields: [targetDocumentId], references: [id], onDelete: Restrict)
```

A **relation** (or *foreign key*) is a pointer from a row in one table to a row in another. Here,
`paymentDocumentId` holds the id of a row in the `Document` table.

**Why two named relations?** Both point at the *same* table, `Document` — one at the receipt, one at
the invoice. Prisma cannot tell which is which without a label, so each gets an explicit name
(`"AllocationPaymentDocument"`, `"AllocationTargetDocument"`). Without the names, Prisma refuses to
generate.

`onDelete: Restrict` means: **refuse to delete the Document if allocations point at it.** The
database physically blocks it. This is the plan's rule that nothing financial is ever deleted.

```prisma
  @@unique([paymentDocumentId, targetDocumentId])
```

A **unique constraint** across two columns together: the same receipt may not be allocated to the
same invoice twice. You can allocate receipt X to invoice A and to invoice B, but not to invoice A
twice — that would be a double-count. The database enforces this even if the service layer has a
bug.

```prisma
  @@index([organizationId, targetDocumentId])
```

An **index** is a lookup shortcut. Without one, answering "which allocations point at invoice Y?"
means scanning every row in the table. With one, the database jumps straight to the answer. This
particular index is what makes the reversal cascade fast.

**Why does `organizationId` come first?** LedgerLine is *multi-tenant* — several companies share one
database. Every query is filtered by company, so the company column belongs at the front of every
index. This is the convention from §5 of the plan.

#### Change 2 — `reversalOfId` on `JournalEntry`

```prisma
model JournalEntry {
  ...
  sourceId       String?
  reversalOfId   String?
  ...
  reversalOf   JournalEntry?  @relation("EntryReversal", fields: [reversalOfId], references: [id], onDelete: Restrict)
  reversals    JournalEntry[] @relation("EntryReversal")
}
```

This is a **self-relation**: a journal entry pointing at another journal entry in the same table.
When we reverse entry A by creating entry B, entry B's `reversalOfId` holds A's id.

`reversals JournalEntry[]` is the other side of the same link — the `[]` means "many". From entry A
you can ask "what reversed me?"; from entry B you can ask "what did I reverse?"

**Why is there no `reversedById` column?** It would be the mirror pointer (A pointing forward at B).
We deliberately left it out: "has this entry been reversed?" is already answered by its `status`
column becoming `REVERSED`. Storing the same fact twice invites the two copies disagreeing. The
plan's test INV-8 only requires `reversal.reversalOfId == original.id`, which this satisfies.

---

**File:** `backend/prisma/migrations/20260815065649_day4_receipts_credit_notes_reversal/migration.sql`

**Status:** Created

**Purpose:** The actual SQL commands that change the real database to match the new schema.

**Why does this file exist?** Editing `schema.prisma` only changes a description. A **migration** is
the set of instructions that changes the live database, and it is saved as a file so that every
developer's database and the production database all get exactly the same changes in the same order.

**How does it connect to other files?** Generated from `schema.prisma` by
`npx prisma migrate dev --create-only`, then hand-edited (see below), then applied by
`npx prisma migrate dev`.

The first 33 lines are generated by Prisma and are the direct translation of the schema changes —
create the table, add the column, add the indexes and foreign keys. The interesting part is what we
added by hand:

```sql
-- Prisma can't express a CHECK constraint in schema.prisma — hand-written,
-- same convention as the Day 1 balance/sign/immutability triggers.
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_amount_check" CHECK ("amount" > 0);
```

#### Reading this code from zero

**What is a CHECK constraint?** A rule the database itself enforces on every insert and update. If
the rule is violated, the write is rejected — no matter what code attempted it.

Here the rule is `amount > 0`: you may not allocate zero, and you may not allocate a negative
amount. A negative allocation would *increase* what an invoice owes while looking like a payment —
a great way to hide fraud.

**Why not just check it in JavaScript?** We do, at two levels — Zod validation rejects it at the
HTTP boundary, and the service checks it too. The database constraint is the last line of defence,
and the only one that also applies to somebody typing SQL by hand. The plan's philosophy is that
the database enforces accounting, not the application.

**Why can't Prisma express it?** `schema.prisma` has no syntax for arbitrary CHECK constraints. So
the workflow is `--create-only` (generate the migration but do not run it), hand-edit the SQL, then
apply. The plan explicitly anticipates this (§5 conventions, "Triggers").

#### The trigger change — the hard part of this migration

```sql
CREATE OR REPLACE FUNCTION block_journal_entry_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.status = 'POSTED' AND NEW.status = 'REVERSED'
     AND NEW."entryNumber" = OLD."entryNumber"
     AND NEW."entryDate" = OLD."entryDate"
     AND NEW.description IS NOT DISTINCT FROM OLD.description
     AND NEW."documentType" = OLD."documentType"
     AND NEW."sourceId" IS NOT DISTINCT FROM OLD."sourceId"
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Journal entries are immutable. Post a reversal entry instead.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER "journal_entry_immutable" ON "JournalEntry";
CREATE TRIGGER "journal_entry_immutable"
  BEFORE UPDATE OR DELETE ON "JournalEntry"
  FOR EACH ROW
  EXECUTE FUNCTION block_journal_entry_mutation();
```

**What is a trigger?** A piece of code stored *inside the database* that runs automatically whenever
something happens to a table. Nobody calls it; the database calls it. `BEFORE UPDATE OR DELETE ON
"JournalEntry" FOR EACH ROW` means: before any row of `JournalEntry` is updated or deleted, run this
function first, once per affected row.

**What is PL/pgSQL?** The programming language Postgres uses for this code. `$$ ... $$` is just
Postgres's way of quoting a block of it.

**What were `OLD` and `NEW`?** Inside a trigger, `OLD` is the row as it exists now, and `NEW` is the
row as it would be after the update. Comparing them is how you detect exactly what changed.

**What was the problem?** Day 1 created a function that took no arguments and always did this:

```sql
CREATE OR REPLACE FUNCTION block_journal_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Journal entries are immutable. Post a reversal entry instead.';
END;
$$ LANGUAGE plpgsql;
```

`RAISE EXCEPTION` throws an error, which aborts the write. Unconditionally. That correctly blocked
every edit to a posted entry — but it also blocked the one edit a reversal needs: flipping `status`
from `POSTED` to `REVERSED`.

**What the new version does, line by line:**

`IF TG_OP = 'UPDATE'` — `TG_OP` is a built-in variable holding which operation fired the trigger.
A `DELETE` never matches, so deletes stay blocked absolutely.

`AND OLD.status = 'POSTED' AND NEW.status = 'REVERSED'` — the *only* status transition allowed. You
cannot flip a reversed entry back to posted, and you cannot use this path to change anything about
a draft.

The next five lines check that every other meaningful field is **unchanged**. If someone tries to
sneak a change to the amount date or narration through alongside the status flip, the condition
fails and the exception fires.

**What is `IS NOT DISTINCT FROM`?** In SQL, `NULL` means "unknown", and comparing two unknowns with
`=` gives `NULL` rather than `true` — so `NULL = NULL` is *not* true. `IS NOT DISTINCT FROM` is the
version that treats two NULLs as equal. `description` and `sourceId` are both nullable, so plain `=`
would wrongly fail whenever they are empty.

`RETURN NEW` — for a `BEFORE` trigger, returning the row means "allow this write to proceed".
Falling through to `RAISE EXCEPTION` means "reject it".

**Why a separate function instead of adding a `TG_TABLE_NAME` guard to the old one?** This is
explained in the migration's own comment, and it cost us a failed test run to discover — see
section 7.1. Briefly: the same function was attached to *both* `JournalEntry` and `JournalLine`.
PL/pgSQL resolves field references like `NEW."entryNumber"` against the actual table when the
function first runs for that table — even inside an `IF` branch that would never be reached. Since
`JournalLine` has no `entryNumber` column, the function failed to compile there. So `JournalEntry`
got its own function, and `JournalLine` keeps the original unconditional one.

The net effect: **journal lines remain absolutely immutable, forever.** Only the parent entry's
status column has a single, narrow, verified exception.

---

### 3.2 Shared document line resolution

---

**File:** `backend/src/lib/accounting/document-lines.js`

**Status:** Created

**Purpose:** Takes the raw line items a user typed (account, quantity, price, discount, tax code),
checks they refer to real things owned by this company, and computes the tax and totals for each
line.

**Why does this file exist?** This logic already existed — but it was written *inside*
`backend/src/lib/invoices/invoice-service.js` as a private function. A credit note needs the exact
same computation: same tax rules, same rounding, same existence checks. Rather than copy 40 lines,
we moved the original here unchanged and had both callers import it.

This is the second rung of the "lazy" ladder — reuse what exists before writing anything new.

**How does it connect to other files?** Imported by `lib/invoices/invoice-service.js` (invoices) and
`lib/accounting/credit-note-service.js` (credit notes). It calls `lib/accounting/line-math.js` for
the arithmetic.

```js
import { computeLine } from './line-math.js';
import { notFound, businessRule } from './errors.js';
import { dec } from '../money.js';

export function toDocumentLineData({ discountAmount: _discountAmount, ...line }) {
  return line;
}

export async function resolveLines(tx, organizationId, lineInputs) {
  if (!lineInputs || lineInputs.length === 0) {
    throw businessRule('empty_invoice', 'A document needs at least one line');
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

#### Reading this code from zero

**Generic syntax — `import` and `export`**

```js
import { thing } from './other-file.js';
export function myThing() { }
```

A JavaScript file is a **module** — a private world. Nothing inside it is visible elsewhere unless
`export`ed, and nothing from elsewhere is visible inside unless `import`ed. `export function` makes
a function available to other files; `import { name }` pulls a specific one in. The `./` means "a
file in this same folder".

**Generic syntax — destructuring with rest**

```js
function f({ a: _a, ...others }) { return others; }
```

**Destructuring** unpacks properties out of an object into variables. `{ a }` pulls out the property
named `a`. `a: _a` pulls it out but names the variable `_a`. `...others` is the **rest** pattern —
"put every remaining property into a new object called `others`".

**In this project:**

```js
export function toDocumentLineData({ discountAmount: _discountAmount, ...line }) {
  return line;
}
```

This is a deliberate way to *remove* one property. `computeLine` returns `discountAmount` because
the document-level total needs it, but the `DocumentLine` database table has no such column —
writing it would crash. So this pulls it out into a variable nobody uses (the leading underscore is
the convention for "intentionally unused") and returns everything else.

**Generic syntax — `new Set()` and the spread operator**

```js
const unique = [...new Set([1, 2, 2, 3])];   // [1, 2, 3]
```

A `Set` is a collection that automatically discards duplicates. `[...someSet]` — the **spread**
operator — turns it back into a normal array.

**In this project:**

```js
  const accountIds = [...new Set(lineInputs.map((l) => l.accountId))];
```

`.map()` transforms every element of an array. Here it turns an array of line objects into an array
of just their account ids. If an invoice has five lines all posting to "Sales Revenue", that gives
five copies of the same id. The `Set` collapses them to one, so we ask the database for each
account once rather than five times.

**Generic syntax — `Promise.all` and `async`/`await`**

```js
const [a, b] = await Promise.all([slowThing(), otherSlowThing()]);
```

Talking to a database takes time. JavaScript does not sit and wait — it registers what to do when
the answer arrives and gets on with other work. A **Promise** represents "an answer that will exist
later". `await` means "pause this function until that answer arrives". A function containing `await`
must be marked `async`.

`Promise.all([...])` starts several operations **at the same time** and waits for all of them.
Awaiting them one after another would take the sum of their durations; this takes the longest one.

**In this project:**

```js
  const [accounts, taxCodes] = await Promise.all([
    tx.account.findMany({ where: { organizationId, id: { in: accountIds } } }),
    taxCodeIds.length ? tx.taxCode.findMany({ ... }) : [],
  ]);
```

Two independent lookups — the accounts and the tax codes — run concurrently.

`tx.account.findMany` is a **Prisma query**: `tx` is the database connection, `account` is the
table, `findMany` means "return every matching row". `where: { id: { in: accountIds } }` translates
to SQL's `WHERE id IN (...)` — match any of these ids.

**The security-critical part:** `where: { organizationId, ... }`. This restricts the search to
accounts owned by *this* company. If a user sends a perfectly valid account id belonging to a
different company, it will not be found here.

`taxCodeIds.length ? ... : []` is the **ternary operator** — `condition ? valueIfTrue : valueIfFalse`.
If no line uses a tax code, skip the query entirely and use an empty array.

**Generic syntax — `Map`**

```js
const byId = new Map(items.map((i) => [i.id, i]));
byId.get('abc');     // the item, or undefined
byId.has('abc');     // true or false
```

A `Map` is a lookup table from key to value. Building one from an array of `[key, value]` pairs
turns "search the array every time" into "jump straight to it".

**In this project:**

```js
  const accountById = new Map(accounts.map((a) => [a.id, a]));
```

We are about to check every line against the accounts we found. Without the Map, each check would
scan the whole array.

**The existence check and why the error type matters:**

```js
  for (const line of lineInputs) {
    if (!accountById.has(line.accountId)) throw notFound(`Account ${line.accountId} not found`);
```

`for (const x of array)` loops over every element. `!` means "not". So: if this line's account was
not among the ones we found for this company, stop.

**Why `notFound` (404) rather than `forbidden` (403)?** This is a security decision from the plan's
§6 validation layers. If we answered 403 "you are not allowed to see that account", we would be
confirming *the account exists* — just in someone else's company. An attacker could map out a
competitor's chart of accounts by watching which ids return 403 and which return 404. Answering 404
for both reveals nothing.

**Generic syntax — optional chaining and nullish coalescing**

```js
obj?.prop        // undefined instead of crashing, if obj is null/undefined
value ?? fallback // use fallback only if value is null or undefined
```

**In this project:**

```js
      discountPct: input.discountPct ?? 0,
      taxRate: taxCode?.rate ?? 0,
```

If the user did not send a discount, use 0. If there is no tax code at all, `taxCode?.rate` is
`undefined` rather than a crash, so the `?? 0` kicks in and the line is untaxed.

**Why `??` and not `||`?** `||` treats *any* falsy value as missing — including `0` and `""`. For a
discount of `0`, `0 || 5` would give 5. `??` only falls back on `null` and `undefined`, which is
what we actually mean.

**What happens at runtime**

For a credit note with one line, 2 units at 8,000 with VAT 13%:

1. The route validates the request body with Zod and calls the credit note service.
2. The service calls `resolveLines(tx, organizationId, lines)`.
3. Two queries run concurrently: fetch that account, fetch that tax code — both scoped to this
   company.
4. The account exists and belongs to us → no error.
5. `computeLine` runs: 2 × 8,000 = 16,000 taxable; 16,000 × 0.13 = 2,080 tax; line total 18,080.
6. An array of one fully computed line comes back, ready to be summed and written.

**What calls this file:** `lib/invoices/invoice-service.js`, `lib/accounting/credit-note-service.js`.
**What this file calls:** `lib/accounting/line-math.js`, `lib/accounting/errors.js`, `lib/money.js`.

---

**File:** `backend/src/lib/invoices/invoice-service.js`

**Status:** Modified (60 lines deleted, behaviour unchanged)

The two functions above used to live here. Now the file imports them:

```js
import { prisma } from '../../db/client.js';
import { sumLines } from '../accounting/line-math.js';
import { resolveLines, toDocumentLineData } from '../accounting/document-lines.js';
import { findFiscalYearForDate } from '../accounting/fiscal-year.js';
import { notFound, conflict } from '../accounting/errors.js';
```

Nothing else about invoices changed. The existing invoice tests passing unchanged after this move is
what proves it was a pure refactor — a **refactor** being a change in structure with no change in
behaviour.

---

### 3.3 The posting rules

---

**File:** `backend/src/lib/accounting/posting-rules.js`

**Status:** Modified — two new rules added

**Purpose:** Holds one pure function per document type that converts a document into the journal
lines it should produce. This is the heart of the accounting engine.

**Why does this file exist?** The plan's central architectural idea: *documents are inputs, the
ledger is the record.* Every document type — invoice, receipt, credit note — has different
accounting rules, but they all produce the same output shape. Keeping those rules as small pure
functions in one file means the rules can be read side by side and tested without a database.

**What does "pure" mean?** A pure function does nothing but turn its inputs into a return value. No
database, no clock, no randomness, no writing to anything. Give it the same input and it always
gives the same output. That makes it trivially testable — no setup, no cleanup.

**How does it connect to other files?** Called by `post-document.js` (invoices), `receipt-service.js`,
`credit-note-service.js`, and `post-manual-entry.js`. It calls only `lib/money.js`.

#### The receipt rule

```js
// Dr Bank/Cash (amount) / Cr AR (amount, carries partyId) — §6 posting rule
// table. Receipts have no per-line tax; the whole thing is one amount.
//
// Expected shape: { depositAccountId, arAccountId, partyId, amount }
function receipt(document) {
  const lines = [
    line({ accountId: document.depositAccountId, debit: document.amount, description: 'Customer receipt' }),
    line({ accountId: document.arAccountId, credit: document.amount, partyId: document.partyId, description: 'Accounts Receivable' }),
  ];
  return lines.map((l, i) => ({ ...l, lineNumber: i + 1 }));
}
```

#### Reading this code from zero

**What are debits and credits?** This is double-entry bookkeeping, and it is simpler than its
reputation. Every transaction is recorded twice — once as a **debit**, once as a **credit** — and
the two must be equal. That is the entire mechanism. If they are equal, the books balance; if
somebody fat-fingers an amount, they stop being equal and the error is visible immediately.

What debit and credit *mean* depends on the account:

- For an **asset** (something you own — cash, bank, money owed to you): a debit **increases** it, a
  credit **decreases** it.
- For a **liability** (something you owe) or **income**: it is the other way round.

**Reading the receipt rule as accounting:** a customer pays you 100,000.

- Your bank account (an asset) goes **up** by 100,000 → debit the bank account.
- The money the customer owes you — "Accounts Receivable", also an asset — goes **down** by
  100,000 → credit Accounts Receivable.

Debits: 100,000. Credits: 100,000. Balanced.

Notice what this does *not* touch: revenue. The sale was already recorded as revenue when the
invoice was posted. Recording it again on payment would double-count it. This is the difference
between *accrual* accounting (record the sale when you make it) and *cash* accounting (record it
when you get paid) — LedgerLine does accrual, as real businesses must.

**What is `line(...)`?** A small helper defined at the top of this file (from Day 3):

```js
function line({ accountId, debit = 0, credit = 0, description, partyId = null }) {
  return { accountId, debit: dec(debit), credit: dec(credit), description, partyId };
}
```

`debit = 0` is a **default parameter** — if the caller omits `debit`, it is 0. So each line
specifies only the side it uses, and the other silently becomes zero. `dec()` converts to the exact
Decimal type.

**What is `partyId` and why only on one line?**

A **party** is a customer or supplier. The AR line carries the customer's id; the bank line does
not. The reason is in the plan: it is what makes a per-customer statement ("show me everything
Himalayan Trek owes") a simple `WHERE partyId = ...` filter rather than a whole new subsystem. The
bank line does not need it because a bank account balance is not per-customer.

**Generic syntax — spread in an object literal**

```js
const updated = { ...original, extra: 1 };
```

`...original` copies every property of `original` into the new object; properties listed afterwards
are added or override.

**In this project:**

```js
  return lines.map((l, i) => ({ ...l, lineNumber: i + 1 }));
```

`.map((l, i) => ...)` gives both the element `l` and its **index** `i` (0 for the first, 1 for the
second). This copies each line and adds a `lineNumber`, counting from 1 rather than 0 because
accountants number lines from 1.

**Why the extra parentheses in `({ ...l })`?** Without them, JavaScript reads `{` after an arrow as
the start of a function *body*, not an object. Wrapping in `(...)` forces it to be read as an
object.

#### The credit note rule

```js
function creditNote(document) {
  const lines = [];

  for (const docLine of document.lines) {
    lines.push(line({ accountId: docLine.accountId, debit: docLine.taxableAmount, description: docLine.description }));
  }

  const taxByAccount = new Map();
  for (const docLine of document.lines) {
    if (!docLine.taxAccountId || isZero(docLine.taxAmount)) continue;
    taxByAccount.set(docLine.taxAccountId, add(taxByAccount.get(docLine.taxAccountId) ?? 0, docLine.taxAmount));
  }
  for (const [taxAccountId, taxAmount] of taxByAccount) {
    lines.push(line({ accountId: taxAccountId, debit: taxAmount, description: 'VAT Payable (Output) reversal' }));
  }

  lines.push(
    line({
      accountId: document.arAccountId,
      credit: document.grandTotal,
      partyId: document.partyId,
      description: 'Accounts Receivable',
    })
  );

  return lines.map((l, i) => ({ ...l, lineNumber: i + 1 }));
}
```

**Reading it as accounting.** Compare with the Day 3 invoice rule, which does the opposite:

| | Invoice | Credit note |
|---|---|---|
| Accounts Receivable | **Debit** grand total | **Credit** grand total |
| Sales Revenue | **Credit** taxable amount | **Debit** taxable amount |
| VAT Payable | **Credit** tax amount | **Debit** tax amount |

It is the exact mirror image. The invoice says "the customer owes us more, we earned revenue, we owe
VAT to the government". The credit note says "the customer owes us less, that revenue is cancelled,
we owe less VAT".

**The VAT grouping loop, explained:**

```js
  const taxByAccount = new Map();
  for (const docLine of document.lines) {
    if (!docLine.taxAccountId || isZero(docLine.taxAmount)) continue;
    taxByAccount.set(docLine.taxAccountId, add(taxByAccount.get(docLine.taxAccountId) ?? 0, docLine.taxAmount));
  }
```

`continue` skips to the next iteration of the loop. So lines with no tax code, or with zero tax, are
ignored — writing a zero line would be rejected by Day 1's sign-check constraint, which requires
every line to be either a debit or a credit but not neither.

`||` here means "or": skip if there is no tax account **or** the tax is zero.

The `Map` accumulates: for each tax account, keep a running total. `taxByAccount.get(id) ?? 0` reads
the total so far, defaulting to 0 the first time. `add(...)` is the money-safe addition from
`lib/money.js`.

**Why group at all?** A credit note might have three lines, all taxed at 13%, all posting VAT to
account 2200. Without grouping you would write three separate small VAT lines. With grouping you
write one. The journal reads the way an accountant expects, and it matches the invoice rule's
behaviour exactly.

**Why is the AR line pushed last?** Purely for readability — the resulting journal entry lists what
changed (revenue, VAT) and then the balancing total. Order does not affect correctness; the sum is
what matters.

```js
export const POSTING_RULES = { invoice, manual, receipt, creditNote };
```

The four rules, exported as one object. A caller writes `POSTING_RULES.receipt(...)`. Day 3 had two
entries here; Day 4 doubled it, and this is the file that demonstrates "one code path, four rule
sets" from the plan.

---

### 3.4 The receipt service — the centrepiece of Day 4

---

**File:** `backend/src/lib/accounting/receipt-service.js`

**Status:** Created

**Purpose:** Records that a customer paid money, decides which invoices that money settles, writes
the journal entry, and updates every affected invoice — all as one indivisible operation.

**Why does this file exist?** This is the most dangerous operation in the system. It moves money,
it touches several rows at once, and two people can do it simultaneously. Every guard in this file
exists because of a specific way it could go wrong.

**How does it connect to other files?** Called by `routes/receipts.js`. It calls the posting rule,
the document numbering helper, the period lock check, the fiscal year lookup, the error helpers, and
the money helpers.

Because this file is long, it is explained in seven parts, in execution order.

#### Part 1 — the function signature and the optional transaction

```js
export async function postReceipt(actor, input, tx = prisma) {
  const run = async (tx) => {
    ...
  };

  return tx === prisma ? prisma.$transaction(run, { isolationLevel: 'ReadCommitted' }) : run(tx);
}
```

**What is a database transaction?** A group of database changes treated as one indivisible unit.
Either **all** of them happen, or **none** of them do. If anything fails part-way — an error, a
crash, a power cut — everything already done is undone automatically. This is called a **rollback**.

Why that matters here: a receipt writes a document row, a journal entry, two journal lines, one
allocation row per invoice, and an update to each invoice. If the process died after writing four
of those seven, the database would be permanently inconsistent — an invoice marked paid with no
payment behind it. The transaction makes that impossible.

**What is `actor`?** An object `{ userId, organizationId, roleId }` — who is doing this, in which
company, with what role. Passing it explicitly means the service never has to know anything about
HTTP.

**What is `tx = prisma`?** A **default parameter**. If the caller does not pass a transaction, use
the normal client. This one small detail is what lets the same function work in two situations:

- **Called without an idempotency key:** `tx` is `prisma`, so `tx === prisma` is true, and the
  function opens *its own* transaction with `prisma.$transaction(run, ...)`.
- **Called from inside `runIdempotent`:** the caller passes the already-open transaction, so
  `tx === prisma` is false and `run(tx)` executes directly inside the caller's transaction.

**Why does that matter so much?** Because the idempotency record and the payment must be in the
*same* transaction. If they were in two, a crash between them would leave "we recorded that we
handled this request" with no payment behind it — or a payment with no record, so a retry creates a
second one. Section 4.3 covers this fully.

**What is `isolationLevel: 'ReadCommitted'`?** How strictly this transaction is insulated from other
simultaneous transactions. `ReadCommitted` means: this transaction only ever sees data that other
transactions have finished committing — never their half-finished work. It is Postgres's default and
the same level the Day 3 posting engine uses. The row locks (Part 3) are what provide the extra
safety on top.

#### Part 2 — unpacking the input and validating the references

```js
    const { partyId, docDate: docDateStr, depositAccountId, amount: amountInput, referenceNo, notes, allocations: allocationInputs = [] } = input;

    const docDate = new Date(docDateStr);
    const amount = dec(amountInput);

    const [party, depositAccount] = await Promise.all([
      tx.party.findFirst({ where: { id: partyId, organizationId: actor.organizationId } }),
      tx.account.findFirst({ where: { id: depositAccountId, organizationId: actor.organizationId } }),
    ]);
    if (!party) throw notFound('Party not found');
    if (!depositAccount) throw notFound('Deposit account not found');

    const fiscalYear = await findFiscalYearForDate(tx, actor.organizationId, docDate);
    const period = await assertPeriodOpen(tx, { organizationId: actor.organizationId, docDate });
```

**Destructuring with renaming and defaults:** `docDate: docDateStr` pulls out the property `docDate`
but calls the variable `docDateStr` — because it arrives as a *string* like `"2025-07-25"` and we
immediately convert it to a real `Date`. Naming it `...Str` prevents confusing the two.
`allocations: allocationInputs = []` renames *and* defaults to an empty array, so a receipt with no
allocations (a customer advance) works without extra handling.

**`dec(amountInput)`** converts the incoming number to the exact Decimal type. From here on, every
arithmetic operation uses the money helpers, never JavaScript's `+`.

**The two lookups** run concurrently and are both scoped by `organizationId` — the same 404-not-403
rule explained in section 3.2.

**`findFiscalYearForDate`** finds the accounting year that contains this date. A **fiscal year** is
the 12-month window a business reports on; in Nepal it runs mid-July to mid-July, labelled like
"2082/83". If no fiscal year covers the date, it throws `no_fiscal_year`. This is the check that
caught us out in testing — see section 7.5.

**`assertPeriodOpen`** checks the month-sized **accounting period** containing this date is still
open. Once a month is closed ("locked"), nothing may be posted into it — that is how accountants
stop the past from changing after they have reported on it. It returns the period, which the journal
entry needs to reference.

#### Part 3 — locking the target invoices

```js
    // Lock every target invoice in id order (not input order) — the same
    // rule payment_allocations follows in §5, so two concurrent receipts
    // touching the same two invoices in opposite order never deadlock.
    const invoiceIds = [...new Set(allocationInputs.map((a) => a.invoiceId))].sort();
    let invoicesById = new Map();
    if (invoiceIds.length > 0) {
      const locked = await tx.$queryRaw`
        SELECT * FROM "Document"
        WHERE id IN (${Prisma.join(invoiceIds)}) AND "organizationId" = ${actor.organizationId}
        ORDER BY id
        FOR UPDATE
      `;
      invoicesById = new Map(locked.map((d) => [d.id, d]));
      for (const id of invoiceIds) {
        if (!invoicesById.has(id)) throw notFound(`Invoice ${id} not found`);
      }
    }
```

This is the most important paragraph of code in the session.

**What is a row lock?** When a transaction locks a row, any *other* transaction that tries to touch
that row waits until the first one finishes. `SELECT ... FOR UPDATE` means "read these rows and lock
them for me until I commit".

**Why is a lock needed at all?** Consider an invoice owing 35,600 and two payments of 30,000
arriving at the same moment:

```
Without locking:
  Request A reads outstanding = 35,600     Request B reads outstanding = 35,600
  A checks 30,000 <= 35,600  → OK          B checks 30,000 <= 35,600  → OK
  A writes outstanding = 5,600             B writes outstanding = 5,600
  Result: 60,000 allocated against a 35,600 invoice. Money invented.
```

Both requests read the *old* value before either wrote. This is a **race condition** — the outcome
depends on timing. With `FOR UPDATE`, request B blocks at the read until A commits, then reads the
*new* 5,600 and correctly rejects. This is exactly what test CONC-1 proves.

**Why `.sort()`?** This prevents a **deadlock** — the situation where two transactions each hold
what the other needs and neither can proceed:

```
Receipt A allocates to invoices [X, Y]     Receipt B allocates to invoices [Y, X]
  A locks X                                  B locks Y
  A waits for Y  ────────── stuck ─────────  B waits for X
```

Neither can finish. Postgres eventually detects this and kills one with an error, but the request
has already failed. Sorting the ids means **every** transaction always locks in the same order —
X before Y, always — so the cycle can never form. B simply waits for X, then proceeds. The cost is
one function call; the benefit is that a whole class of production failure cannot occur.

`ORDER BY id` in the SQL reinforces the same ordering at the database level.

**What is `$queryRaw`?** An escape hatch for writing SQL directly, because Prisma's normal query API
has no way to express `FOR UPDATE`.

**Is raw SQL dangerous here?** Not the way it is written. This is a **tagged template literal** —
the backtick string with `${...}` holes, passed to the `$queryRaw` function. Prisma does *not* paste
the values into the SQL text. It sends the SQL with numbered placeholders and the values separately,
so the database treats them strictly as data, never as commands. That is what prevents **SQL
injection** — an attack where hostile input smuggles in extra SQL. Writing the same query by gluing
strings together with `+` would be genuinely dangerous.

**What is `Prisma.join`?** `IN (...)` needs a comma-separated list of placeholders, and the number
depends on how many invoices there are. `Prisma.join(invoiceIds)` builds that safely — still
parameterised, still injection-proof.

**The existence check afterwards:** the query filters by `organizationId`, so an invoice belonging to
another company simply will not come back. Comparing what we asked for against what we got and
throwing `notFound` is what turns a cross-tenant attempt into a 404. This is test ISO-2 from the
plan's isolation suite.

#### Part 4 — the over-allocation guards

```js
    let allocatedTotal = dec(0);
    for (const a of allocationInputs) {
      const invoice = invoicesById.get(a.invoiceId);
      const allocAmount = dec(a.amount);
      if (invoice.docType !== 'INVOICE') {
        throw businessRule('not_an_invoice', `Document ${invoice.id} is not an invoice`);
      }
      if (!['POSTED', 'PARTIALLY_PAID'].includes(invoice.status)) {
        throw businessRule('invoice_not_open', `Invoice ${invoice.id} is not open for allocation (status ${invoice.status})`);
      }
      if (allocAmount.gt(invoice.outstandingAmount)) {
        throw businessRule('over_allocation', `Allocation ${allocAmount} exceeds invoice ${invoice.id} outstanding ${invoice.outstandingAmount}`);
      }
      allocatedTotal = add(allocatedTotal, allocAmount);
    }
    if (allocatedTotal.gt(amount)) {
      throw businessRule('over_allocation', `Total allocations ${allocatedTotal} exceed receipt amount ${amount}`);
    }
```

Four guards, each blocking a different mistake:

1. **`not_an_invoice`** — you cannot allocate a payment against another payment, or against a credit
   note. The id must point at an actual invoice.
2. **`invoice_not_open`** — only a posted or partly-paid invoice can receive money. A `DRAFT` invoice
   is not yet a real debt; a `PAID` one owes nothing; a `REVERSED` one has been undone.
3. **`over_allocation` (per invoice)** — the core rule. `.gt()` is Decimal's "greater than". You may
   not apply more to an invoice than it owes. **This is test INV-7.**
4. **`over_allocation` (per receipt)** — you cannot hand out more money than the customer sent.
   Allocating 90,000 of a 50,000 receipt is nonsense.

**Why `throw` instead of returning an error?** Throwing inside a transaction is what makes it roll
back. Every write attempted before the throw is undone. That is why INV-7's assertion that
"outstanding is *still* 35,600 and no receipt row exists" holds — the failed attempt left nothing
behind at all.

**Note the deliberate gap:** `allocatedTotal` may be *less* than `amount`. That is legal — the
remainder is a **customer advance**, money received but not yet applied to any particular invoice.
It sits on the receipt itself as its own `outstandingAmount`, to be allocated later. The plan notes
that supporting this costs nothing and shows you know advances exist.

**What are these error helpers?** From `lib/accounting/errors.js` (Day 3). `businessRule(code, msg)`
creates an ordinary `Error` object with `status = 422` and a machine-readable `code` attached. The
global error handler in `app.js` reads those two properties and shapes the HTTP response. **422**
means "I understood your request, but it breaks a business rule" — as opposed to 400 ("malformed"),
403 ("not allowed"), or 500 ("my fault").

#### Part 5 — numbering, the posting rule, and the balance assertion

```js
    const arAccount = await tx.account.findFirst({ where: { organizationId: actor.organizationId, code: AR_ACCOUNT_CODE } });
    if (!arAccount) throw internal(`Accounts Receivable account (${AR_ACCOUNT_CODE}) not found for this organization`);

    const yearLabel = fiscalYear.label.split('/')[0];
    const docNo = await nextDocNumber(tx, {
      organizationId: actor.organizationId, docType: 'RECEIPT', fiscalYearId: fiscalYear.id, prefix: 'RCP', yearLabel,
    });
    const entryNumber = await nextEntryNumber(tx, { organizationId: actor.organizationId, fiscalYearId: fiscalYear.id, yearLabel });

    const journalLines = POSTING_RULES.receipt({
      depositAccountId: depositAccount.id, arAccountId: arAccount.id, partyId: party.id, amount,
    });

    const debits = journalLines.reduce((total, l) => add(total, l.debit), dec(0));
    const credits = journalLines.reduce((total, l) => add(total, l.credit), dec(0));
    if (!eq(debits, credits)) {
      throw internal(`Unbalanced receipt entry: debits ${debits} vs credits ${credits}`);
    }
```

**`AR_ACCOUNT_CODE`** is the string `'1100'`, from `lib/accounting/chart-of-accounts.js`. Accounts
Receivable is the one account whose code is fixed by convention across the whole plan. Every other
account is looked up from data.

**`fiscalYear.label.split('/')[0]`** — `.split('/')` cuts the string `"2082/83"` at the slash giving
`["2082", "83"]`, and `[0]` takes the first. So document numbers read `RCP-2082-0001`.

**`nextDocNumber` and `nextEntryNumber`** (from Day 3) allocate the next number from a counter row
that they lock with `SELECT ... FOR UPDATE` — the same locking idea as Part 3. The plan is emphatic
about why: **never `MAX(number) + 1`**. Under concurrency, two requests both read the same maximum
and both produce the same next number, and duplicate invoice numbers are a legal problem, not just a
bug. Test CONC-2 proves the locked counter holds under ten simultaneous posts.

Note the two different series: document numbers are per document type (receipts count separately
from invoices), while journal entry numbers are one shared sequence for the whole company.

**`.reduce()`** collapses an array into a single value. It takes a function and a starting value:

```js
const debits = journalLines.reduce((total, l) => add(total, l.debit), dec(0));
```

Start at `dec(0)`; for each line, add its debit to the running total. Note it uses `add()` from the
money module, not `+` — the plan bans `+` on money because on Decimals it silently produces a
*string* instead of a number.

**Why assert balance here when the database already enforces it?** Day 1 installed a deferred
constraint trigger that rejects any unbalanced entry at commit time. This check is redundant — on
purpose. It fails *early*, with a message naming the actual amounts, instead of surfacing as a raw
Postgres exception at the end of the transaction. Belt and braces; the same pattern Day 3's
`postDocument` uses.

**`internal(...)`** produces a 500 error. That is correct here: a receipt whose two lines do not
match is not the user's fault, it is a bug in our own rule. This should never fire.

#### Part 6 — writing the document and the journal entry

```js
    const outstandingOnReceipt = sub(amount, allocatedTotal);

    const document = await tx.document.create({
      data: {
        organizationId: actor.organizationId, fiscalYearId: fiscalYear.id,
        docType: 'RECEIPT', docNo, docDate, partyId: party.id,
        referenceNo: referenceNo ?? null, notes: notes ?? null,
        grandTotal: amount, allocatedAmount: allocatedTotal, outstandingAmount: outstandingOnReceipt,
        status: 'POSTED', createdById: actor.userId, postedAt: new Date(), postedById: actor.userId,
      },
    });

    const journalEntry = await tx.journalEntry.create({
      data: {
        organizationId: actor.organizationId, periodId: period.id, entryNumber,
        documentType: 'receipt', entryDate: docDate, description: `Customer Receipt ${docNo}`,
        status: 'POSTED', sourceId: document.id, postedAt: new Date(), postedById: actor.userId,
        lines: {
          create: journalLines.map((l) => ({
            organizationId: actor.organizationId, accountId: l.accountId, partyId: l.partyId,
            debit: l.debit, credit: l.credit, description: l.description, lineNumber: l.lineNumber,
          })),
        },
      },
      include: { lines: true },
    });
```

**`sub(amount, allocatedTotal)`** — money-safe subtraction. What is left over is the unapplied
advance.

**`tx.document.create({ data: {...} })`** inserts one row and returns it.

**`docNo,`** on its own is JavaScript **shorthand** — when the property name and variable name are
identical, `docNo: docNo` can be written `docNo`.

**Why `status: 'POSTED'` immediately?** Invoices have a draft phase — a clerk types one, an
accountant reviews and posts it. Receipts do not: cash arriving is a fact, not a proposal. So a
receipt creates and posts in one step, exactly like a manual journal entry.

**Nested `create`** writes the journal entry and its lines together in one operation, and the
database treats them as one insert. `include: { lines: true }` asks for the created lines back in
the result.

**`sourceId: document.id`** is the link from the ledger back to the document that caused it. Together
with `documentType: 'receipt'`, this is what the reversal cascade later reads to know what kind of
document it is undoing.

#### Part 7 — the allocations and invoice updates

```js
    const allocations = [];
    for (const a of allocationInputs) {
      const invoice = invoicesById.get(a.invoiceId);
      const allocAmount = dec(a.amount);
      const newOutstanding = sub(invoice.outstandingAmount, allocAmount);

      await tx.paymentAllocation.create({
        data: {
          organizationId: actor.organizationId, paymentDocumentId: document.id, targetDocumentId: invoice.id,
          amount: allocAmount, createdById: actor.userId,
        },
      });

      await tx.document.update({
        where: { id: invoice.id },
        data: {
          outstandingAmount: newOutstanding,
          allocatedAmount: add(invoice.allocatedAmount, allocAmount),
          status: isZero(newOutstanding) ? 'PAID' : 'PARTIALLY_PAID',
          version: { increment: 1 },
        },
      });

      allocations.push({ invoiceId: invoice.id, amount: allocAmount.toFixed(2), invoiceOutstandingAfter: newOutstanding.toFixed(2) });
    }

    return { document, journalEntry, allocations };
```

For each invoice being paid: write the link row, then update the invoice.

**`status: isZero(newOutstanding) ? 'PAID' : 'PARTIALLY_PAID'`** — if nothing is left owing, the
invoice is fully paid; otherwise it is partly paid. This is the status change the plan's Day 4
checkpoint asks you to demonstrate.

**`version: { increment: 1 }`** — Prisma shorthand for "add 1 to the existing value". The `version`
column powers **optimistic concurrency** on draft edits: a client sends back the version it last
read, and if the number has moved on, someone else edited it first and the update is rejected with
a 409 conflict. Bumping it here keeps that mechanism honest.

**`.toFixed(2)`** converts a Decimal to a string with exactly 2 decimal places. **Money leaves this
system as a string, never a number.** JavaScript numbers cannot faithfully represent more than about
15 significant digits, so a large amount could come back subtly altered. A string cannot be
corrupted, and the frontend formats it for display without ever doing arithmetic on it.

**What happens at runtime — a receipt of 90,000 split across two invoices**

1. Route validates the body, calls `postReceipt`.
2. `prisma.$transaction` opens. **BEGIN** is sent to Postgres.
3. Party and deposit account are verified as belonging to this company.
4. Fiscal year found; accounting period confirmed open.
5. Both invoice ids are sorted and locked with `SELECT ... FOR UPDATE`. Any competing receipt
   touching them now waits here.
6. Guards run against the freshly locked values. Suppose both pass; 70,000 total allocated.
7. `RCP-2082-0004` and `JE-2082-0009` are allocated from their locked counter rows.
8. The posting rule produces two lines: Dr Bank 90,000 / Cr AR 90,000. Balance asserted.
9. The receipt document is written: grand total 90,000, allocated 70,000, outstanding 20,000
   (the advance).
10. The journal entry and its two lines are written.
11. Two `PaymentAllocation` rows are written; both invoices are updated, one to `PAID`, one to
    `PARTIALLY_PAID`.
12. **COMMIT.** Every lock releases. Any waiting request now proceeds and reads the new values.
13. If anything above threw, **ROLLBACK** instead — nothing is written and the locks release.

**What calls this file:** `backend/src/routes/receipts.js`.
**What this file calls:** `posting-rules.js`, `document-numbering.js`, `period-lock.js`,
`fiscal-year.js`, `chart-of-accounts.js`, `errors.js`, `money.js`, `db/client.js`.

---

### 3.5 The credit note service

---

**File:** `backend/src/lib/accounting/credit-note-service.js`

**Status:** Created

**Purpose:** Issues a credit note against a posted invoice — reducing what the customer owes without
altering the original invoice.

**Why does this file exist?** Because a posted invoice is immutable. When a customer returns goods,
the correction must be a second document that references the first.

**How does it connect to other files?** Called by `routes/credit-notes.js`. It shares
`document-lines.js` with the invoice service and uses the same numbering, period, and money helpers
as the receipt service.

Most of its structure mirrors `receipt-service.js`, so this section covers only what differs.

#### Locking the parent invoice and the scope guard

```js
    const [invoice] = await tx.$queryRaw`
      SELECT * FROM "Document"
      WHERE id = ${invoiceId} AND "organizationId" = ${actor.organizationId}
      FOR UPDATE
    `;
    if (!invoice || invoice.docType !== 'INVOICE') throw notFound('Invoice not found');
    if (!['POSTED', 'PARTIALLY_PAID'].includes(invoice.status)) {
      throw businessRule('invoice_not_open', `Invoice ${invoice.id} is not open for a credit note (status ${invoice.status})`);
    }

    const docDate = new Date(docDateStr);
    const resolved = await resolveLines(tx, actor.organizationId, lineInputs);
    const totals = sumLines(resolved);

    if (totals.grandTotal.gt(invoice.outstandingAmount)) {
      throw businessRule('credit_exceeds_outstanding', `Credit note ${totals.grandTotal} exceeds invoice outstanding ${invoice.outstandingAmount}`);
    }
```

**`const [invoice] = await tx.$queryRaw...`** — array destructuring taking the first result. Raw
queries always return an array even when at most one row can match.

**`resolveLines` and `sumLines`** are exactly what an invoice uses. This is the payoff from
extracting `document-lines.js`: a credit note's tax and rounding behaviour is *identical* to an
invoice's by construction, not by two implementations happening to agree.

**The `credit_exceeds_outstanding` guard is a deliberate scope decision, and worth understanding.**

It refuses to credit more than the invoice currently owes. Consider an invoice of 10,000 the
customer has already paid in full — outstanding is 0. They return goods worth 2,000. In a complete
system you would credit 2,000 and then *refund* them 2,000 in cash. We do not build refunds on
Day 4, so we refuse instead.

Refusing is the safe failure. Allowing it would drive `outstandingAmount` negative — meaning "the
customer owes minus 2,000", which the schema's own `outstanding >= 0` design forbids and which would
quietly corrupt the AR aging report. Blocking a legitimate-but-unsupported case is recoverable;
corrupting the ledger is not.

Relaxing it later is a one-line change once refunds exist.

#### Writing the credit note and re-reading its lines

```js
    const creditNote = await tx.document.create({
      data: {
        ...
        docType: 'CREDIT_NOTE', docNo, docDate, partyId: invoice.partyId, parentDocumentId: invoice.id,
        ...
        grandTotal: totals.grandTotal, outstandingAmount: 0,
        status: 'POSTED', ...
        lines: { create: resolved.map(toDocumentLineData) },
      },
    });

    const creditNoteLines = await tx.documentLine.findMany({
      where: { documentId: creditNote.id }, include: { taxCode: true }, orderBy: { lineNo: 'asc' },
    });
```

**`parentDocumentId: invoice.id`** is the link the plan requires. From the credit note you can always
reach the invoice it corrects, and from the invoice you can list its corrections.

**`outstandingAmount: 0`** — a credit note does not carry its own receivable balance. It *reduces*
the parent's. Giving it a balance of its own would double-count it in the aging report.

**Why re-read the lines that were just written?** The posting rule needs each line's *tax output
account* — the account VAT is posted to. `resolveLines` returns the `taxCodeId` but not the account
the tax code points at. Re-reading with `include: { taxCode: true }` follows that link and gives us
the account. This is the identical two-step `postDocument` performs for invoices, deliberately kept
the same so both paths behave alike.

#### Updating the parent invoice

```js
    const newOutstanding = sub(invoice.outstandingAmount, totals.grandTotal);
    const updatedInvoice = await tx.document.update({
      where: { id: invoice.id },
      data: {
        outstandingAmount: newOutstanding,
        status: isZero(newOutstanding) ? 'PAID' : 'PARTIALLY_PAID',
        version: { increment: 1 },
      },
    });
```

**Notice what is absent: `grandTotal` is never touched.** This is the whole point, and it matches
worked example 4 in the plan exactly. The invoice still says it was for 135,600 — because it *was*.
Only what remains owed changes. Both documents exist; an auditor can see the original bill, the
credit note, and the resulting balance.

#### What happens at runtime — crediting 2 returned backpacks on a 135,600 invoice

1. The parent invoice is located and locked. It is `POSTED`, outstanding 135,600.
2. The credit note's own lines are resolved: 2 × 8,000 = 16,000 taxable, +13% VAT = 2,080, total
   18,080.
3. 18,080 ≤ 135,600, so the scope guard passes.
4. The credit note's date is checked against an open period.
5. `CN-2082-0001` and the next journal entry number are allocated.
6. The document and its lines are written, linked to the invoice.
7. Lines are re-read with their tax accounts; the posting rule produces:
   Dr Sales Revenue 16,000 / Dr VAT Payable 2,080 / Cr Accounts Receivable 18,080. Balanced.
8. The journal entry is written.
9. The invoice's outstanding drops 135,600 → 117,520; status becomes `PARTIALLY_PAID`; grand total
   unchanged.
10. Commit.

---

### 3.6 Reversal

---

**File:** `backend/src/lib/accounting/reverse-entry.js`

**Status:** Created

**Purpose:** Undoes a posted journal entry by creating an equal and opposite entry, then marks the
original reversed and repairs whatever document it came from.

**Why does this file exist?** A credit note corrects a *commercial* fact. A reversal corrects a
*posting* fact — you hit the wrong account, or recorded a payment that never arrived. Nothing is
deleted; the correction is additive.

**How does it connect to other files?** Called by `POST /journal-entries/:id/reverse` in
`routes/journal-entries.js`.

#### Part 1 — lock and guard

```js
export async function reverseEntry(entryId, { reason, reversalDate }, actor) {
  return prisma.$transaction(async (tx) => {
    const [original] = await tx.$queryRaw`
      SELECT * FROM "JournalEntry"
      WHERE id = ${entryId} AND "organizationId" = ${actor.organizationId}
      FOR UPDATE
    `;
    if (!original) throw notFound('Journal entry not found');
    if (original.status !== 'POSTED') {
      throw conflict('already_reversed', `Journal entry ${original.id} is not posted (status ${original.status.toLowerCase()})`);
    }

    const date = reversalDate ? new Date(reversalDate) : new Date();
    const fiscalYear = await findFiscalYearForDate(tx, actor.organizationId, date);
    const period = await assertPeriodOpen(tx, { organizationId: actor.organizationId, docDate: date });
```

**`conflict(...)`** produces a **409 Conflict** — "the thing you asked for contradicts the current
state". Reversing an entry that is already reversed is not a malformed request (400) and not a
permission problem (403); the request is fine, the state is wrong. Checking `status !== 'POSTED'`
covers both "already reversed" and "still a draft" in one guard.

**The reversal date defaults to today** — `reversalDate ? new Date(reversalDate) : new Date()`. That
default is what tripped up our first test run (section 7.5): today's real date fell outside the test
fixture's fiscal year.

**Why is the reversal dated separately from the original?** Because you usually discover the mistake
later, possibly in a different month. Backdating a reversal into a closed period would change a
month you have already reported on — so the reversal gets its own date and its own period check.

#### Part 2 — the swap

```js
    const originalLines = await tx.journalLine.findMany({
      where: { journalEntryId: original.id },
      orderBy: { lineNumber: 'asc' },
    });

    // Mechanical debit<->credit swap, not a POSTING_RULES entry — this isn't
    // a rule keyed by document type, it's the same transform for every entry.
    const swappedLines = originalLines.map((l) => ({
      accountId: l.accountId, partyId: l.partyId, description: l.description,
      debit: l.credit, credit: l.debit,
    }));
```

**The entire mechanism of reversal is those two lines: `debit: l.credit, credit: l.debit`.**

If the original was `Dr Other Expenses 12,000 / Cr Bank 12,000`, the reversal is
`Dr Bank 12,000 / Cr Other Expenses 12,000`. Add the two together and every account nets to zero.
The original still exists; the correction still exists; the effect is nil.

It is also automatically balanced — swapping the two columns cannot change their totals — which is
why no balance assertion is needed here.

**Why not a `POSTING_RULES` entry?** The rules map is keyed by *document type* because each type has
different accounting. Reversal is the same mechanical transform for every entry regardless of type,
so it belongs with the operation, not in the rules table.

#### Part 3 — write the reversal, flip the original

```js
    const reversal = await tx.journalEntry.create({
      data: {
        organizationId: actor.organizationId, periodId: period.id, entryNumber,
        documentType: 'manual', entryDate: date,
        description: `Reversal of ${original.entryNumber}: ${reason}`,
        status: 'POSTED', sourceId: null, reversalOfId: original.id,
        postedAt: new Date(), postedById: actor.userId,
        lines: { create: swappedLines.map((l, i) => ({ ... , lineNumber: i + 1 })) },
      },
      include: { lines: true },
    });

    // The one permitted UPDATE on a posted entry — the migration's trigger
    // carve-out only allows this exact status transition, nothing else.
    await tx.$executeRaw`UPDATE "JournalEntry" SET status = 'REVERSED' WHERE id = ${original.id}`;
```

**`description: \`Reversal of ${original.entryNumber}: ${reason}\`** — a **template literal**:
backticks with `${...}` holes that insert values. The `reason` is required by the route's validation,
so the audit trail always records *why*, not just *that*.

**`sourceId: null`** — the reversal is not itself produced by a document. **`reversalOfId`** is what
links it back.

**Why raw SQL for the status flip?** Prisma's `update` sends every field it knows about. The trigger
compares old and new values on several columns, and Prisma's serialisation of dates could make an
unchanged timestamp *look* changed, tripping the guard. Raw SQL touches exactly one column and
nothing else — which is precisely what the trigger permits.

#### Part 4 — the cascade

```js
    let sourceDocument = null;
    if (original.sourceId) {
      const [doc] = await tx.$queryRaw`
        SELECT * FROM "Document" WHERE id = ${original.sourceId} AND "organizationId" = ${actor.organizationId} FOR UPDATE
      `;
      if (doc) sourceDocument = await cascadeReversal(tx, actor, original.documentType, doc);
    }

    return { original: { ...original, status: 'REVERSED' }, reversal, sourceDocument };
```

**Why a cascade is necessary.** The ledger now nets to zero, but the *documents* have not caught up.
Reverse a receipt and the ledger correctly says the bank never received the money — but the invoice
still says `PAID`. The two halves must agree, or the subledger-equals-ledger invariant (INV-3)
breaks immediately.

`if (original.sourceId)` — manual journal entries have no source document, so nothing cascades.

**The three cascade branches:**

**Reversing an invoice — refuse if anything has happened to it:**

```js
  if (documentType === 'invoice') {
    if (dec(doc.allocatedAmount).gt(0)) {
      throw businessRule('cannot_reverse_invoice_with_activity', `Invoice ${doc.id} has payments applied — issue a credit note instead`);
    }
    const corrections = await tx.document.count({ where: { parentDocumentId: doc.id } });
    if (corrections > 0) {
      throw businessRule('cannot_reverse_invoice_with_activity', `Invoice ${doc.id} has credit notes applied — issue a further correction instead`);
    }
    return tx.document.update({
      where: { id: doc.id },
      data: { status: 'REVERSED', outstandingAmount: 0, version: { increment: 1 } },
    });
  }
```

An invoice that has been paid or credited is entangled with other documents. Unwinding it would
orphan a payment against a document that no longer exists. The error message points at the correct
tool: a credit note. Only an untouched invoice may be reversed outright.

**Reversing a receipt — give the money back to the invoices:**

```js
  if (documentType === 'receipt') {
    const allocations = await tx.paymentAllocation.findMany({ where: { paymentDocumentId: doc.id } });
    for (const alloc of allocations) {
      const [invoice] = await tx.$queryRaw`SELECT * FROM "Document" WHERE id = ${alloc.targetDocumentId} ... FOR UPDATE`;
      if (!invoice) continue;
      const newOutstanding = add(invoice.outstandingAmount, alloc.amount);
      const newAllocated = sub(invoice.allocatedAmount, alloc.amount);
      await tx.document.update({
        where: { id: invoice.id },
        data: {
          outstandingAmount: newOutstanding,
          allocatedAmount: newAllocated,
          status: isZero(newAllocated) ? 'POSTED' : 'PARTIALLY_PAID',
          version: { increment: 1 },
        },
      });
    }
    await tx.paymentAllocation.deleteMany({ where: { paymentDocumentId: doc.id } });
    return tx.document.update({
      where: { id: doc.id },
      data: { status: 'REVERSED', outstandingAmount: 0, version: { increment: 1 } },
    });
  }
```

The exact inverse of what `postReceipt` did: outstanding goes back **up**, allocated goes back
**down**, and the allocation rows are deleted. The status returns to `POSTED` if no allocations
remain, or `PARTIALLY_PAID` if other receipts still apply.

Note the invoices are locked again here, for the same reason as before.

**Is deleting the allocation rows a violation of "nothing is ever deleted"?** No. That rule protects
*ledger* records — journal entries and lines, which are untouched. An allocation is a link between
documents, not an accounting record. Its deletion is itself recorded, because the reversal entry and
two audit rows describe exactly what happened.

**Reversing a credit note — give the debt back:**

```js
  if (documentType === 'creditNote') {
    const [invoice] = await tx.$queryRaw`SELECT * FROM "Document" WHERE id = ${doc.parentDocumentId} ... FOR UPDATE`;
    if (invoice) {
      const maxOutstanding = sub(invoice.grandTotal, invoice.allocatedAmount);
      const restored = add(invoice.outstandingAmount, doc.grandTotal);
      const newOutstanding = restored.gt(maxOutstanding) ? maxOutstanding : restored;
      ...
    }
    return tx.document.update({ where: { id: doc.id }, data: { status: 'REVERSED', version: { increment: 1 } } });
  }
```

The credit note reduced what was owed; reversing it puts that back. The `maxOutstanding` clamp is a
safety rail: an invoice can never owe more than its grand total minus what has already been paid.
Without it, an unusual sequence of operations could push outstanding above the total, which the
schema forbids.

**What happens at runtime — reversing a receipt that paid an invoice in full**

1. Entry located and locked; confirmed `POSTED`.
2. Reversal date resolved; fiscal year and open period confirmed.
3. The original's two lines are read: Dr Bank 10,000 / Cr AR 10,000.
4. Swapped: Dr AR 10,000 / Cr Bank 10,000.
5. A new entry number is allocated; the reversal entry and lines are written with
   `reversalOfId` pointing at the original.
6. The original's status is flipped to `REVERSED` by raw SQL — permitted by the trigger carve-out.
7. Its `sourceId` points at a receipt, so the cascade runs: the invoice is locked, outstanding goes
   0 → 10,000, allocated goes 10,000 → 0, status returns to `POSTED`, the allocation row is deleted,
   and the receipt is marked `REVERSED`.
8. Commit.
9. Back in the route, two audit log rows are written.

Net effect on the ledger: zero. Rows deleted from the ledger: zero. This is test INV-8, and the
cascade half is the second test in `reverse-entry.test.js`.

---

### 3.7 The HTTP routes

Before the individual files, the concepts they all share.

**What is an HTTP request?** When a browser talks to a server it sends a message with four parts: a
**method** (`GET` to read, `POST` to create, `PATCH` to modify), a **path** (`/api/v1/receipts`),
**headers** (small labelled facts like who you are), and optionally a **body** (the data, as JSON).
The server sends back a **status code** (200 OK, 404 Not Found, 422 rule violation) and usually a
body.

**What is Express?** The library that receives those requests and decides which of our functions
handles each one.

**What is middleware?** A function that runs *before* the handler and can inspect the request, add
to it, or stop it. Each one either passes control on with `next()` or ends the request. Every
protected route in LedgerLine runs the same chain:

```
authenticate  →  resolveTenant  →  authorize('some.permission')  →  the handler
"who are you"    "which company,     "may you do this            the actual work
                  and are you         specific thing?"
                  a member?"
```

**What is Zod?** A validation library. You describe the shape you expect, and it either returns
clean data or throws. Because LedgerLine is plain JavaScript rather than TypeScript, Zod *is* the
type system — it is the only place the shape of incoming data is guaranteed.

---

**File:** `backend/src/routes/receipts.js`

**Status:** Created

**Purpose:** Exposes receipt creation and lookup over HTTP, and applies idempotency protection.

```js
const router = Router();

router.use(authenticate, resolveTenant);

const allocationSchema = z.object({
  invoiceId: z.string().uuid(),
  amount: z.coerce.number().positive(),
}).strict();

const createReceiptSchema = z.object({
  partyId: z.string().uuid(),
  docDate: z.string().regex(DATE_RE),
  depositAccountId: z.string().uuid(),
  amount: z.coerce.number().positive(),
  referenceNo: z.string().optional(),
  notes: z.string().optional(),
  allocations: z.array(allocationSchema).default([]),
}).strict();
```

#### Reading this code from zero

**`router.use(authenticate, resolveTenant)`** applies those two middleware to **every** route in this
file. Writing them once rather than per-route means a new route cannot accidentally be left
unprotected.

**Reading the Zod schema:**

- `z.string().uuid()` — must be a string, and must look like a UUID. A malformed id is rejected
  before any database query runs.
- `z.coerce.number().positive()` — convert to a number if it arrives as a string (JSON and form data
  are inconsistent about this), then require it to be greater than zero. A negative or zero payment
  is rejected here.
- `z.string().regex(DATE_RE)` where `DATE_RE` is `/^\d{4}-\d{2}-\d{2}$/` — exactly four digits, dash,
  two digits, dash, two digits. The whole project uses plain `YYYY-MM-DD` strings for dates rather
  than `z.date()`, so there is no timezone ambiguity in what the client sent.
- `.optional()` — the field may be absent.
- `.default([])` — if absent, use an empty array. This is what makes a receipt with no allocations
  (a pure advance) valid.
- **`.strict()`** — reject the request if it contains *any* property not listed. Without it, a typo
  like `allocation` instead of `allocations` would be silently ignored and the payment would post
  with nothing allocated. With it, the client gets a clear 400.

#### The idempotency wiring

```js
router.post('/receipts', authorize('payment.create'), async (req, res, next) => {
  try {
    const input = createReceiptSchema.parse(req.body);
    const actor = actorFrom(req);
    const key = req.headers['idempotency-key'];

    let status;
    let body;
    let replayed = false;

    if (key) {
      const outcome = await runIdempotent(
        { key, endpoint: 'POST /receipts', requestBody: req.body },
        async (tx) => {
          const result = await postReceipt(actor, input, tx);
          return { status: 201, body: serializeResult(result) };
        }
      );
      replayed = outcome.replayed;
      status = outcome.status;
      body = outcome.body;
    } else {
      const result = await postReceipt(actor, input);
      status = 201;
      body = serializeResult(result);
    }

    if (replayed) {
      res.set('Idempotent-Replay', 'true');
    } else {
      req.auditEntry = { action: 'receipt.posted', entityType: 'Document', entityId: body.receipt.id, before: null, after: { ... } };
    }

    res.status(status).json(body);
  } catch (err) {
    next(err);
  }
});
```

**`authorize('payment.create')`** — the permission required. From the plan's role matrix, Owner,
Accountant, and Clerk have it; Viewer does not. There is deliberately no separate "payment.post"
permission: unlike an invoice, a receipt has no draft-then-approve step.

**`req.headers['idempotency-key']`** — a header the *client* generates (typically a fresh UUID per
user action) and resends unchanged on any retry. Express lowercases header names.

**The two branches:** with a key, the write runs inside `runIdempotent`'s transaction (passing `tx`
into `postReceipt` — this is the reason for that parameter). Without a key, `postReceipt` opens its
own transaction as normal. Sending the key is therefore optional but strongly advised.

**`res.set('Idempotent-Replay', 'true')`** tells the client "this is the stored response from your
earlier identical request, not a new payment". The status and body are byte-identical to the first
response, which is what makes a retry genuinely safe.

**Why is no audit entry written on a replay?** Because nothing happened. The original request
already wrote one. Logging again would make one payment look like two in the audit trail — exactly
the confusion idempotency exists to prevent.

**`try { ... } catch (err) { next(err); }`** — every route in the project uses this shape. `next(err)`
hands the error to the single error handler in `app.js`, which turns `err.status` and `err.code`
into the HTTP response. Without the catch, a rejected promise inside an async handler would hang the
request.

**Generic syntax — status codes used here**

- **201 Created** — a new thing exists. Correct for a successful receipt.
- **400** — malformed request (Zod rejected it).
- **403** — authenticated but not permitted.
- **404** — not found, *or* found but belonging to another company.
- **409** — conflicts with current state.
- **422** — well-formed but breaks a business rule (over-allocation, locked period).

---

**File:** `backend/src/routes/credit-notes.js`

**Status:** Created

Structurally the same. The notable line:

```js
router.post('/credit-notes', authorize('invoice.post'), async (req, res, next) => {
```

**Why reuse `invoice.post` rather than invent `credit_note.post`?** Issuing a credit note changes
the ledger and reduces a customer's debt — the same level of trust as posting an invoice. The plan's
permission matrix has eight codes and no credit-note code, so adding one would mean editing the
seed data, the test helper role matrix, and every existing environment's database. Reusing the
existing code keeps the separation of duties intact (a Clerk still cannot do it) at zero cost.

---

**File:** `backend/src/routes/journal-entries.js`

**Status:** Modified — added the reverse endpoint

```js
router.post('/journal-entries/:id/reverse', authorize('journal.post'), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const input = reverseEntrySchema.parse(req.body);
    const actor = { userId: req.userId, organizationId: req.organizationId, roleId: req.roleId };

    const { original, reversal } = await reverseEntry(id, input, actor);
    const originalFull = await prisma.journalEntry.findUniqueOrThrow({ where: { id: original.id }, include: { lines: true } });

    await writeAuditLog({
      organizationId: req.organizationId, userId: req.userId, requestId: req.id, ipAddress: req.ip,
      action: 'journal_entry.reversal_posted', entityType: 'JournalEntry', entityId: reversal.id,
      before: null, after: { entryNumber: reversal.entryNumber, reversalOfId: original.id },
    });
    await writeAuditLog({
      organizationId: req.organizationId, userId: req.userId, requestId: req.id, ipAddress: req.ip,
      action: 'journal_entry.marked_reversed', entityType: 'JournalEntry', entityId: original.id,
      before: { status: 'posted' }, after: { status: 'reversed', reversalEntryId: reversal.id },
    });
    ...
```

**`:id` in the path** is a **route parameter** — a placeholder. A request to
`/journal-entries/abc-123/reverse` makes `req.params.id` equal `'abc-123'`. It is still validated as
a UUID before use.

**Why re-fetch `originalFull`?** `reverseEntry` returns the original as it came from `$queryRaw` —
a plain Postgres row where dates and decimals are raw values, not the Prisma objects the serializer
expects. Calling `.toISOString()` on a raw value would crash. Re-reading through the ORM gives
properly typed objects.

**Why two audit writes instead of the usual one?** Every other route sets `req.auditEntry`, and the
audit middleware writes that single entry after the response is sent. But this one request produces
two genuinely distinct state changes: a new entry was created, and an existing entry's status
changed. Recording only one would leave a hole in the trail.

So this route calls `writeAuditLog` directly, twice — the one deliberate exception to the
convention, documented in a comment at the call site.

**Why does this make the INV-8 audit count 3?** Posting the original manual entry wrote one row.
Reversing it writes two more. That is the "audit_log entries == 3" the plan specifies for INV-8, and
the test asserts exactly that.

**Why after the transaction, not inside?** The rule inherited from Day 2: an audit entry must never
claim something happened if the transaction later rolled back. `reverseEntry` has already committed
by the time these run.

---

**File:** `backend/src/routes/masters.js`

**Status:** Modified — added period lock/unlock

```js
const updatePeriodSchema = z.object({ isOpen: z.boolean() }).strict();

router.patch('/periods/:id', authorize('org.manage'), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const { isOpen } = updatePeriodSchema.parse(req.body);

    const existing = await prisma.accountingPeriod.findFirst({
      where: { id, fiscalYear: { organizationId: req.organizationId } },
    });
    if (!existing) throw notFound('Accounting period not found');

    const period = await prisma.accountingPeriod.update({ where: { id }, data: { isOpen } });

    req.auditEntry = {
      action: isOpen ? 'period.unlocked' : 'period.locked',
      entityType: 'AccountingPeriod',
      entityId: period.id,
      before: { isOpen: existing.isOpen },
      after: { isOpen: period.isOpen },
    };
    ...
```

**Why `org.manage` (Owner only)?** Closing the books is an organisational control, not a routine
accounting action. An Accountant can post; only an Owner can decide the month is finished.

**Why the manual ownership check?** This is the constraint Day 2's documentation warned about.
LedgerLine's tenant extension automatically adds `organizationId` to queries — but only for tables
that *have* that column. `AccountingPeriod` does not; it is scoped through its parent fiscal year.
So the filter must be written by hand:

```js
      where: { id, fiscalYear: { organizationId: req.organizationId } },
```

That nested `where` follows the relation and filters on the parent's column. Without it, any
authenticated user could lock another company's periods by guessing a UUID. The
`reports.test.js` suite includes a test proving a cross-company attempt returns 404.

**`before` and `after` in the audit entry** capture the state on both sides of the change, so the
audit trail shows what it actually was, not just what it became.

---

### 3.8 The reports

---

**File:** `backend/src/routes/reports.js`

**Status:** Modified — trial balance fixed, two reports added

#### The trial balance fix

```js
      WHERE jl."organizationId" = ${req.organizationId}
        AND je.status IN ('POSTED', 'REVERSED')
        AND je."entryDate" BETWEEN ${from}::date AND ${asOf}::date
```

One word changed: `je.status = 'POSTED'` became `je.status IN ('POSTED', 'REVERSED')`. Section 4.6
explains in full why this was mandatory the moment reversal existed — in short, without it a
reversed entry's own lines vanish from every report while its offsetting reversal stays, so the pair
stops netting to zero and the trial balance silently reports wrong numbers.

#### AR aging

**What is AR aging?** A report answering "who owes us money, and how late are they?" Debts are sorted
into **buckets** by how far past their due date they are. It is the standard tool for chasing
payment and for judging how much of what you are owed you will actually collect.

```js
const AGING_BUCKETS = [
  { key: 'current', label: 'Current', min: -Infinity, max: 0 },
  { key: 'd1_30', label: '1-30 days', min: 1, max: 30 },
  { key: 'd31_60', label: '31-60 days', min: 31, max: 60 },
  { key: 'd61_90', label: '61-90 days', min: 61, max: 90 },
  { key: 'd90_plus', label: '90+ days', min: 91, max: Infinity },
];

function bucketFor(daysOverdue) {
  return AGING_BUCKETS.find((b) => daysOverdue >= b.min && daysOverdue <= b.max).key;
}
```

`-Infinity` and `Infinity` are real JavaScript values, used here so the first and last buckets are
open-ended without special cases. An invoice due in the future has a *negative* days-overdue, which
falls in `current`.

`.find()` returns the first element matching a condition. The buckets do not overlap and cover every
possible number, so exactly one always matches.

```js
    const openInvoices = await prisma.document.findMany({
      where: { organizationId: req.organizationId, docType: 'INVOICE', status: { in: ['POSTED', 'PARTIALLY_PAID'] }, outstandingAmount: { gt: 0 } },
      include: { party: true },
    });
```

**Why query `Document` here and `JournalLine` in the trial balance?** These are two different views
of the same truth:

- The **general ledger** is the account-level view: "Accounts Receivable totals 86,450."
- The **subledger** is the document-level view: "invoice 1 owes 35,600, invoice 2 owes 50,850."

Aging needs per-invoice due dates and per-customer grouping, which only the subledger has. The two
must always agree — which is why this report checks itself.

`outstandingAmount: { gt: 0 }` (greater than zero) matches the partial index built on Day 3
specifically for this query, so it stays fast as the table grows.

```js
      const dueDate = doc.dueDate ?? doc.docDate;
      const daysOverdue = Math.floor((asOfDate - dueDate) / (1000 * 60 * 60 * 24));
```

Subtracting two JavaScript `Date` objects gives the difference in **milliseconds**. Dividing by
`1000 * 60 * 60 * 24` (milliseconds in a day) converts to days, and `Math.floor` rounds down to a
whole day. Written as a multiplication rather than `86400000` so a reader can see where the number
comes from.

`doc.dueDate ?? doc.docDate` — if an invoice somehow has no due date, treat it as due on its own
date rather than crashing.

```js
    const [arRow] = await prisma.$queryRaw`
      SELECT COALESCE(SUM(jl.debit), 0) AS total_debit, COALESCE(SUM(jl.credit), 0) AS total_credit
      ...
        AND a.code = ${AR_ACCOUNT_CODE}
        AND je.status IN ('POSTED', 'REVERSED')
        AND je."entryDate" <= ${asOf}::date
    `;
    const arControlBalance = sub(dec(arRow.total_debit), dec(arRow.total_credit));
```

**This is the self-check, and it is the most interesting part of the report.**

**What is a control account?** An account in the general ledger whose balance must always equal the
sum of a detailed subledger. Accounts Receivable is the classic one: its balance must equal the total
of every unpaid invoice. If the two ever diverge, no report is trustworthy — and this is precisely
what an auditor tests.

`SUM(...)` adds up a column across matching rows. `COALESCE(x, 0)` substitutes 0 when there are no
rows at all (SQL's `SUM` of nothing is `NULL`, not zero).

The response then carries both numbers and their verdict:

```js
      totals: { grandTotal: grandTotal.toFixed(2) },
      integrity: { arControlBalance: arControlBalance.toFixed(2), balanced: eq(grandTotal, arControlBalance) },
```

The report proves its own correctness in its own output. The frontend can render a green check or a
loud red warning without a second request, and this is what backs the plan's requirement for "the
AR-control-account reconciliation line underneath" the aging table.

#### General ledger

**What is a general ledger report?** Every movement that touched one specific account, in date
order, with a running balance — the account's statement.

```js
    const debitNormal = ['ASSET', 'EXPENSE'].includes(account.type);
```

**What is "debit-normal"?** Whether an account's balance naturally sits on the debit side.

- **Assets and expenses are debit-normal.** More cash = more debit.
- **Liabilities, equity and income are credit-normal.** More revenue = more credit.

Without this distinction a revenue account would display its balance as negative, which is not how
an accountant reads a ledger. So the running balance is computed in whichever direction is natural:

```js
      balance = debitNormal ? add(balance, sub(debit, credit)) : add(balance, sub(credit, debit));
```

```js
    let balance = debitNormal
      ? sub(dec(opening.total_debit), dec(opening.total_credit))
      : sub(dec(opening.total_credit), dec(opening.total_debit));
    const openingBalance = balance;
```

**What is an opening balance?** The account's balance immediately *before* the reporting window
starts, computed by summing everything dated earlier. Without it, a report starting in October would
imply the account began at zero in October, which is wrong. The running balance must continue from
where the account actually stood.

```js
      LEFT JOIN "Document" d ON d."journalEntryId" = je.id
```

**What is a JOIN?** Combining rows from two tables using a link between them. A plain `JOIN` keeps
only rows that match on both sides. A **`LEFT JOIN`** keeps every row from the left table and fills
the right side with `NULL` when there is no match.

`LEFT` is essential here: manual journal entries have no source document. A plain `JOIN` would
silently drop every manual entry from the report — an entire class of transaction quietly missing.

The document columns feed the "clickable rows into source documents" the plan asks for:

```js
        sourceDocumentId: r.source_document_id,
        sourceDocType: r.source_doc_type ? r.source_doc_type.toLowerCase() : null,
        sourceDocNo: r.source_doc_no,
```

The conditional guards the `null` case — calling `.toLowerCase()` on `null` would crash on exactly
those manual entries.

---

### 3.9 The idempotency fix

---

**File:** `backend/src/lib/idempotency/run-idempotent.js`

**Status:** Modified — bug fix (8 lines added)

This file was written on Day 2 and never called. Wiring it up on Day 4 revealed it did not work.
The full debugging story is section 7.3; here is the fix itself.

```js
  return prisma.$transaction(async (tx) => {
    // A failed statement aborts the whole Postgres transaction — catching
    // the P2002 in JS and continuing to query on the same `tx` would just
    // fail again with "current transaction is aborted". A savepoint around
    // the risky insert lets a conflict roll back to a clean point without
    // losing the transaction the idempotency key must share with the write.
    await tx.$executeRaw`SAVEPOINT idempotency_insert`;

    let created;
    try {
      created = await tx.idempotencyKey.create({ ... });
    } catch (err) {
      if (err.code !== 'P2002') throw err;
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT idempotency_insert`;

      const existing = await tx.idempotencyKey.findFirst({ where: { key } });
      ...
```

**What is a savepoint?** A bookmark inside a transaction. `ROLLBACK TO SAVEPOINT` undoes everything
since the bookmark **without ending the transaction**. It is a partial undo.

**Why is it needed?** Postgres has a strict rule: once *any* statement in a transaction fails, the
whole transaction is poisoned. Every subsequent statement is refused with
`current transaction is aborted, commands ignored until end of transaction block`.

The original code assumed catching the error in JavaScript was enough. It was not — Postgres had
already given up on the transaction, so the very next query failed too.

**How the fix works:**

1. Drop a savepoint before the risky insert.
2. Try to insert the idempotency key. If this is the first time we have seen this key, it succeeds
   and the savepoint is simply never used.
3. If the key already exists, the unique constraint rejects it. Prisma reports this as error code
   `P2002`. The transaction is now poisoned.
4. `ROLLBACK TO SAVEPOINT` un-poisons it — the failed insert is undone and the transaction is
   healthy again.
5. Now the follow-up query works, and we can read the stored response and replay it.

**Why `if (err.code !== 'P2002') throw err;`?** Only a duplicate-key error means "we have seen this
request". Any other failure is a real problem and must not be swallowed.

**Why not check first and then insert?** Because between the check and the insert, another request
could insert the same key — the same race condition described in section 3.4. Attempting the insert
and letting the database's unique constraint decide is *atomic*: the database guarantees exactly one
winner.

---

### 3.10 The tests

**What is an automated test?** A program that runs your program and checks the result. It runs on
every change, so a mistake that breaks old behaviour is caught immediately rather than in
production.

LedgerLine uses **Vitest** as the runner and **Supertest** to make real HTTP requests against the
Express app without opening a network port.

**These are integration tests, not unit tests.** They run against a **real PostgreSQL database**.
That is deliberate: the most important guarantees in this system — the balance trigger, the
immutability trigger, row locking, unique constraints — live *in the database*. A test using a fake
database would prove nothing about any of them.

```js
// backend/vitest.config.js
    fileParallelism: false,
```

Test files run one at a time, because every file wipes and reseeds the same database. Running two
at once would have them destroying each other's data.

---

**File:** `backend/src/lib/accounting/receipt-service.test.js` — 5 tests

The headline test is **CONC-1**, which the plan calls "the test that makes experienced reviewers stop
scrolling":

```js
  it('exactly 3 of 5 concurrent 30,000 receipts succeed against a 100,000 outstanding invoice', async () => {
    const invoice = await postInvoice({ docDate: new Date('2025-07-23'), quantity: 1, unitPrice: '100000.00' });

    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        postReceipt(actor, {
          partyId: party.id, docDate: '2025-07-29', depositAccountId: cashAccount.id, amount: 30000,
          allocations: [{ invoiceId: invoice.id, amount: 30000 }],
        })
      )
    );

    const fulfilled = attempts.filter((a) => a.status === 'fulfilled');
    const rejected = attempts.filter((a) => a.status === 'rejected');
    expect(fulfilled).toHaveLength(3);
    expect(rejected).toHaveLength(2);
    for (const r of rejected) {
      expect(r.reason).toMatchObject({ status: 422, code: 'over_allocation' });
    }

    const finalInvoice = await prisma.document.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(finalInvoice.outstandingAmount.toFixed(2)).toBe('10000.00');

    const allocations = await prisma.paymentAllocation.findMany({ where: { targetDocumentId: invoice.id } });
    const allocatedTotal = allocations.reduce((t, a) => t.plus(a.amount), dec(0));
    expect(allocatedTotal.toFixed(2)).toBe('90000.00');

    const allLines = await prisma.journalLine.findMany({ where: { organizationId: org.id } });
    const totalDebit = allLines.reduce((t, l) => t.plus(l.debit), dec(0));
    const totalCredit = allLines.reduce((t, l) => t.plus(l.credit), dec(0));
    expect(totalDebit.toFixed(4)).toBe(totalCredit.toFixed(4));
  });
```

**What this test proves.** Five payments of 30,000 are fired at an invoice owing 100,000, *at the
same time*. Three of them fit (90,000). Two must fail. The test asserts:

- exactly 3 succeeded and exactly 2 failed
- both failures are `422 over_allocation`, not crashes or deadlocks
- the invoice's outstanding is exactly 10,000
- the allocations total exactly 90,000
- **the entire ledger still balances**

**If the row locking were removed, this test fails.** All five would read "100,000 outstanding",
all five would pass the guard, and the invoice would end up over-allocated. That is precisely the
bug it exists to catch.

**`Promise.allSettled`** runs everything concurrently and waits for all of them, reporting each as
`fulfilled` or `rejected`. This is different from `Promise.all`, which rejects as soon as *one*
fails — useless here, since we expect and want failures.

**`Array.from({ length: 5 }, () => ...)`** builds an array of five items by calling the function five
times. `.filter()` keeps only matching elements. `toMatchObject` checks the listed properties exist
with those values, ignoring others.

The other four tests in this file cover the fully-allocated happy path, splitting one receipt across
two invoices with an advance left over, a pure advance with no allocations, and **INV-7** (sequential
over-allocation is refused and leaves nothing behind).

---

**File:** `backend/src/routes/receipts.test.js` — 4 tests

**IDEM-1** — the same key twice creates one payment:

```js
    const first = await request(app).post('/api/v1/receipts').set(owner.headers).set('Idempotency-Key', key).send(body);
    expect(first.status).toBe(201);
    expect(first.headers['idempotent-replay']).toBeUndefined();

    const second = await request(app).post('/api/v1/receipts').set(owner.headers).set('Idempotency-Key', key).send(body);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.body).toEqual(first.body);
```

The second response is byte-identical and flagged as a replay. **IDEM-2** sends the same key with a
*different* body and expects `422 idempotency_key_reuse` — reusing a key for different data is a
client bug worth reporting loudly. **IDEM-3** uses the same key string from a *second organisation*
and expects both to succeed, proving keys are scoped per company.

**INV-3 — the auditor's test:**

```js
    const openInvoices = await prisma.document.findMany({
      where: { organizationId: owner.orgId, docType: 'INVOICE', status: { not: 'REVERSED' } },
    });
    const subledgerTotal = openInvoices.reduce((t, d) => t.plus(d.outstandingAmount), dec(0));

    const [arRow] = await prisma.$queryRaw`
      SELECT COALESCE(SUM(jl.debit), 0) AS total_debit, COALESCE(SUM(jl.credit), 0) AS total_credit
      FROM "JournalLine" jl JOIN "Account" a ON a.id = jl."accountId"
      WHERE jl."organizationId" = ${owner.orgId} AND a.code = '1100'
    `;
    const ledgerBalance = dec(arRow.total_debit).minus(arRow.total_credit);

    expect(subledgerTotal.toFixed(4)).toBe(ledgerBalance.toFixed(4));
```

After posting an invoice and a partial receipt, the sum of what every invoice says it is owed must
equal the Accounts Receivable balance in the ledger. Two completely independent paths to the same
number. **This is the test an actual auditor performs**, and the plan describes it as the difference
between having read about accounting and having built it.

---

**File:** `backend/src/lib/accounting/reverse-entry.test.js` — 4 tests

**INV-8** asserts the original becomes `reversed`, the reversal's `reversalOfId` points back, both
affected account balances net to exactly zero, the entry count went **up** by two (nothing deleted),
and three audit rows exist.

One test deserves special attention:

```js
  it('the DB trigger still blocks every other mutation on a posted entry', async () => {
    ...
    await expect(
      prisma.journalEntry.update({ where: { id: entry.id }, data: { description: 'sneaky edit' } })
    ).rejects.toThrow(/immutable/i);

    const line = await prisma.journalLine.findFirstOrThrow({ where: { journalEntryId: entry.id } });
    await expect(prisma.journalLine.delete({ where: { id: line.id } })).rejects.toThrow(/immutable/i);
  });
```

**Why this test matters more than the others.** We *modified a security trigger* in this session. The
risk of carving out an exception is that you accidentally carve out too much. This test attacks the
database directly — bypassing every service, every route, every permission check — and proves that
editing a posted entry and deleting a posted line are both still impossible.

`rejects.toThrow(/immutable/i)` asserts the promise fails with a message matching that pattern
(`/i` = case-insensitive).

---

**File:** `backend/src/lib/accounting/credit-note-service.test.js` — 2 tests

Asserts the journal is the exact mirror of an invoice (Dr revenue, Dr VAT, Cr AR), that the invoice's
outstanding drops while **`grandTotal` stays 135,600**, and that `credit_exceeds_outstanding` fires
when the credit is too large.

---

**File:** `backend/src/routes/reports.test.js` — 4 tests

Covers AR aging bucket placement with its `integrity.balanced` self-check, the general ledger running
balance and source-document links, and **INV-10**:

```js
    const lockRes = await request(app).patch(`/api/v1/periods/${period.id}`).set(owner.headers).send({ isOpen: false });
    expect(lockRes.status).toBe(200);

    const created = await request(app).post('/api/v1/invoices').set(owner.headers).send({ ... docDate: '2025-08-20' ... });
    const postRes = await request(app).post(`/api/v1/invoices/${created.body.id}/post`).set(owner.headers).send();

    expect(postRes.status).toBe(422);
    expect(postRes.body.error.code).toBe('period_locked');
```

The period is locked **through the real endpoint**, then posting into it is refused. The fourth test
proves locking another company's period returns 404.

---

**File:** `backend/src/lib/accounting/post-document.test.js`

**Status:** Modified — added CONC-2

```js
  it('assigns 10 distinct, gapless doc numbers under concurrent posting (CONC-2)', async () => {
    const drafts = await Promise.all(Array.from({ length: 10 }, (_, i) => makeDraftInvoice({ ... })));

    await Promise.all(drafts.map((doc) => postDocument(doc.id, actor)));

    const posted = await prisma.document.findMany({ where: { id: { in: drafts.map((d) => d.id) } } });
    const seqs = posted.map((d) => Number(d.docNo.split('-').pop())).sort((a, b) => a - b);

    expect(new Set(seqs).size).toBe(10); // no duplicates
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBe(seqs[i - 1] + 1); // no gaps
    }
  });
```

Ten invoices posted simultaneously must produce ten different, consecutive numbers.
`new Set(seqs).size === 10` proves no duplicates (a Set collapses them); the loop proves no gaps.

This tests Day 3's locked-counter numbering, but the plan schedules it on Day 4 — the point being
that gapless sequential document numbering is a **statutory** requirement in many jurisdictions, so
"two invoices got number 7" is a legal problem, not a cosmetic one.

---

## 4. The code explained from zero

Section 3 walked through the files. This section takes the six ideas that span several files and
explains each one properly in one place.

### 4.1 Why money is a Decimal and never a number

Every money value in LedgerLine — in the database, in memory, in the JSON response — avoids
JavaScript's normal number type. Here is why.

**The problem.** Computers store ordinary numbers in binary. Some decimal fractions have no exact
binary representation, exactly as 1/3 has no exact decimal representation. Open any JavaScript
console:

```js
0.1 + 0.2        // 0.30000000000000004
```

That is not a bug; it is what the number format is. In most software the error is irrelevant. In
accounting it is fatal — because the whole system rests on debits *exactly* equalling credits. A
difference of 0.00000000000000004 makes a trial balance fail to balance, and an accountant then
spends a day hunting a discrepancy that came from arithmetic, not from data.

**The solution.** `backend/src/lib/money.js` wraps Prisma's `Decimal` type, which stores the digits
themselves rather than a binary approximation:

```js
export function dec(value) { return new Decimal(value); }
export function add(a, b) { return dec(a).plus(dec(b)); }
export function sub(a, b) { return dec(a).minus(dec(b)); }
export function eq(a, b) { return dec(a).equals(dec(b)); }
export function isZero(a) { return dec(a).isZero(); }
```

**The three rules this creates, all of which Day 4 code follows:**

1. **Never use `+` on money.** Use `add()`. Beyond precision, `+` on two Decimals in JavaScript
   silently produces a *string* — `"100" + "50"` is `"10050"`, not `150`. That would be a
   catastrophic, silent bug.
2. **Never use `===` on money.** Use `eq()`. Two Decimal objects holding the same value are still
   two different objects, so `===` compares identity and returns false.
3. **Money leaves the API as a string.** `.toFixed(2)` produces `"135600.00"`. A JavaScript number
   cannot faithfully round-trip more than about 15 significant digits, so serialising as a number
   risks the client receiving a subtly different value. The frontend formats the string for display
   and never does arithmetic on it.

**Where rounding happens.** `line-math.js` rounds at each named boundary — discount, then tax, then
line total — and document totals are the sum of already-rounded line values. That is what guarantees
`document.grandTotal` exactly equals the Accounts Receivable debit on its journal entry. Summing
unrounded values and rounding at the end would leave the printed invoice and the ledger disagreeing
by a paisa.

### 4.2 Row locking, race conditions, and deadlock

**A race condition** is a bug where the result depends on the timing of two things happening at once.
They are the hardest bugs to find because they are invisible in single-user testing and appear only
under real load.

**The read-modify-write race.** Almost every money bug of this class has the same shape:

```
1. Read the current value
2. Decide something based on it
3. Write a new value
```

If two requests interleave those steps, both read the same starting value and the second write
overwrites the first. The invoice example from section 3.4:

```
Invoice owes 35,600. Two payments of 30,000 arrive simultaneously.

  Request A: read 35,600 ──┐
  Request B: read 35,600 ──┤  both read the same number
  Request A: 30,000 ≤ 35,600 → allowed
  Request B: 30,000 ≤ 35,600 → allowed   ← wrong, but it cannot tell
  Request A: write 5,600
  Request B: write 5,600
```

60,000 has been applied to an invoice owing 35,600. No error was raised. Every report from this
moment on is wrong.

**The fix — `SELECT ... FOR UPDATE`.** This reads rows *and locks them*. Any other transaction
touching those rows waits until the first commits.

```
  Request A: SELECT ... FOR UPDATE  → gets the lock, reads 35,600
  Request B: SELECT ... FOR UPDATE  → BLOCKED, waiting
  Request A: allowed, writes 5,600, COMMIT   → lock released
  Request B: unblocks, reads 5,600 (the NEW value)
  Request B: 30,000 ≤ 5,600? No → 422 over_allocation ✓
```

The second request is not merely rejected — it is rejected *for the right reason*, having seen
current data. This is what CONC-1 verifies.

**Deadlock — the trap that ordered locking avoids.** Locks introduce their own failure mode. If two
transactions each hold a lock the other needs, neither can move:

```
  Receipt A wants invoices [X, Y]        Receipt B wants invoices [Y, X]

  A locks X                              B locks Y
  A asks for Y → blocked (B has it)      B asks for X → blocked (A has it)
                    ↑ neither can proceed, ever ↑
```

Postgres detects this after a moment and kills one transaction with a deadlock error — but the user's
request has already failed for a reason that has nothing to do with their data.

**The fix is one method call:**

```js
const invoiceIds = [...new Set(allocationInputs.map((a) => a.invoiceId))].sort();
```

If **every** transaction locks in the same order — sorted by id — the cycle cannot form. A and B both
want X first, so one simply waits for the other and then proceeds. The plan calls this out explicitly
("**ordered by id**, to avoid deadlock between two concurrent receipts hitting the same pair of
invoices").

**Where else this pattern appears in Day 4:** locking the document being posted, locking the parent
invoice for a credit note, locking the entry being reversed, locking the invoices during a reversal
cascade, and locking the numbering counter rows.

### 4.3 Why the idempotency key shares the payment's transaction

**What is idempotency?** An operation is idempotent if doing it twice has the same effect as doing it
once. `GET` is naturally idempotent — reading twice changes nothing. `POST /receipts` is naturally
**not**: posting twice creates two payments.

**Why this cannot be ignored.** Networks fail in the worst possible way: the request arrives, the
work is done, and the *response* is lost. The client has no way to distinguish "never arrived" from
"succeeded but I did not hear". Its only sane move is to retry. Without protection, the retry doubles
the payment.

**The mechanism.** The client generates a unique key per user action and sends it as a header,
resending the *same* key on retries. The server records each key it has seen along with the response
it produced. A second request with a known key gets the stored response back instead of doing the
work again.

**The critical design decision — the key row and the payment are written in the same transaction.**

```js
if (key) {
  const outcome = await runIdempotent(
    { key, endpoint: 'POST /receipts', requestBody: req.body },
    async (tx) => {
      const result = await postReceipt(actor, input, tx);   // ← the same tx
      return { status: 201, body: serializeResult(result) };
    }
  );
```

`runIdempotent` opens the transaction and writes the key row. It then hands that same `tx` to
`postReceipt`, which — because of its `tx = prisma` default parameter — uses it rather than opening
its own. Both writes land in one commit.

**Why that matters.** Consider the alternative, two separate transactions:

```
  Transaction 1: record the idempotency key ✓ committed
  ── crash ──
  Transaction 2: record the payment ✗ never ran

  Client retries → server says "already handled, here is your response"
  Reality: no payment exists. Money silently lost.
```

Or the reverse order, and a retry creates a second payment. **With one transaction, neither is
possible.** Either both rows exist or neither does. There is no in-between state.

**Why Postgres and not Redis?** Redis is the usual home for this kind of key, and it would be faster.
But Redis cannot participate in a Postgres transaction. You would be back to two systems that can
disagree about whether a payment happened — which is the exact failure idempotency exists to prevent.
The plan calls this out as a genuinely good interview answer, and it is: choosing the slower store
because it is the only one that can be *correct*.

**Why the request body is hashed:**

```js
function hashBody(body) {
  return createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex');
}
```

A **hash** is a fixed-length fingerprint of some data; the same input always gives the same
fingerprint, and different input almost certainly gives a different one. Storing the fingerprint lets
the server detect a client reusing one key for two *different* payments — a client bug that would
otherwise silently suppress the second, real payment. That case returns `422 idempotency_key_reuse`
rather than a replay.

### 4.4 The trigger carve-out — modifying a security control safely

Day 1 built three database triggers that enforce accounting rules below the application. Day 4 had to
modify one of them, which is the riskiest kind of change in this codebase.

**What the trigger did before.** Any `UPDATE` or `DELETE` on a posted journal entry or line raised an
exception. Unconditionally. That is correct for almost everything — but a reversal must set the
original's `status` to `REVERSED`, and the trigger blocked that too. There was literally no way to
mark an entry reversed.

**Three ways to solve it, and why we chose the third:**

1. **Drop the trigger.** Absurd — it is the single strongest guarantee in the system.
2. **Store "is reversed" somewhere else** — a separate table, so the entry itself is never updated.
   Defensible, but it splits one fact across two places that can disagree, and every report would
   need an extra join.
3. **Allow exactly one transition, verified field by field.** Chosen.

**What "verified field by field" means.** It is not enough to allow updates when the status changes,
because an attacker (or a bug) could change the status *and* the amount in the same statement. So the
trigger requires every other meaningful column to be identical:

```sql
  IF TG_OP = 'UPDATE'
     AND OLD.status = 'POSTED' AND NEW.status = 'REVERSED'
     AND NEW."entryNumber" = OLD."entryNumber"
     AND NEW."entryDate" = OLD."entryDate"
     AND NEW.description IS NOT DISTINCT FROM OLD.description
     AND NEW."documentType" = OLD."documentType"
     AND NEW."sourceId" IS NOT DISTINCT FROM OLD."sourceId"
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Journal entries are immutable. Post a reversal entry instead.';
```

The default remains "reject". Only a request that satisfies every clause gets through.

**What is *not* allowed, and this is the important part:**

- `DELETE` — never, on anything.
- Any change to a `JournalLine` — the amounts themselves are absolutely frozen.
- `REVERSED` back to `POSTED` — reversal is one-way.
- Changing the status *and* anything else together.

**Why `JournalLine` needed a separate function.** Both triggers originally shared one function by
name. Adding `JournalEntry` field checks to it broke `JournalLine`, because PL/pgSQL resolves
`NEW."entryNumber"` against the actual table the first time the function runs there — even inside a
branch that could never be reached. `JournalLine` has no such column, so it failed to compile. The
fix was a dedicated function for `JournalEntry`, leaving the original untouched for `JournalLine`.
Section 7.1 tells the story.

**How we verified the carve-out is narrow enough.** A test that attacks the database directly,
bypassing every application-layer check — described at the end of section 3.10. Modifying a security
control without a test that tries to break it is how carve-outs become holes.

### 4.5 Why reports must include REVERSED entries

This is subtle, and getting it wrong would silently corrupt every report in the system.

**The setup.** Every report filters to posted entries — draft entries are invisible to accounting,
which is correct. Before Day 4, `status = 'POSTED'` was exactly right, because `REVERSED` never
occurred.

**What reversal changes.** After reversing entry A with entry B:

- Entry A: status `REVERSED`, lines `Dr Expenses 12,000 / Cr Bank 12,000`
- Entry B: status `POSTED`, lines `Dr Bank 12,000 / Cr Expenses 12,000`

**The bug, if the filter stays `= 'POSTED'`:**

```
A is excluded (status REVERSED)   ← its lines vanish from the report
B is included (status POSTED)     ← its lines remain

Report shows: Dr Bank 12,000 / Cr Expenses 12,000
Reality:      nothing happened at all
```

The report would show the *reversal alone*, unopposed. Bank would appear 12,000 higher than it is.
The trial balance would still "balance" — because B is internally balanced — so nothing would look
broken. It would simply be wrong, quietly.

**The fix:**

```sql
AND je.status IN ('POSTED', 'REVERSED')
```

**Why this is right, conceptually.** `REVERSED` does not mean "did not happen". It means "happened,
and was subsequently cancelled by another entry". Both entries are real history and both belong in
the ledger. Together they net to zero, which is exactly the correct effect. The only status that
must be excluded is `DRAFT` — something that genuinely never happened.

**Every query added in Day 4 uses this filter**, and every report added in Day 5 (P&L, balance sheet,
bank reconciliation) must too. It is the kind of mistake that would not surface until someone
reconciled a bank statement by hand and found the numbers off.

### 4.6 Subledger, general ledger, and control accounts

These three terms explain why Day 4 stores the same fact twice on purpose, and how the system proves
the two copies agree.

**The general ledger** is the account-level summary. It answers: "what is the balance of Accounts
Receivable?" It lives in `JournalLine` — the ledger of record.

**The subledger** is the document-level detail. It answers: "which invoices are unpaid, by whom, due
when?" It lives in `Document.outstandingAmount`.

**Why keep both?** The general ledger cannot answer "which invoices are overdue" without reading
every line ever written and reconstructing each document's history. The subledger answers it in one
indexed query. So `outstandingAmount` is **denormalised** — a deliberately stored copy of something
that could be recomputed, kept because recomputing it constantly would be too slow.

**The risk of denormalising.** Any stored copy can drift out of step with the truth. If a bug updates
the invoice but not the ledger, they silently disagree — and that is the exact failure mode the whole
project is a rebuttal to. The plan's opening argument is that most small-business accounting software
stores `amount_paid` on the invoice, lets a report read it, and quietly lies when someone edits the
invoice.

**A control account is the answer.** Accounts Receivable is a *control account*: its general ledger
balance must always equal the sum of the subledger. Two rules keep that true:

1. **Nothing may post to a control account manually.** In this repository the flag is the
   `Account.isControlAccount` column (the plan calls it `allow_manual_entry`; the implemented name
   differs). `backend/src/lib/accounting/post-manual-entry.js` checks it and rejects the entry with
   `manual_entry_not_allowed_on_control_account` — Day 3's PERM-6. Only document-driven posting
   rules may touch AR, and those always update both sides together.
2. **The equality is asserted by test.** INV-3 computes both numbers independently and requires them
   to match.

**And the AR aging report checks it live:**

```js
      integrity: { arControlBalance: arControlBalance.toFixed(2), balanced: eq(grandTotal, arControlBalance) },
```

Every time anyone opens the aging report, the system re-proves that the subledger agrees with the
ledger and says so in the response.

**Worked example, from the plan:**

```
Invoice 1: 135,600 → receipt of 100,000 → outstanding 35,600
Invoice 2:  50,850 → unpaid            → outstanding 50,850

Subledger: 35,600 + 50,850                    = 86,450
Ledger:    135,600 + 50,850 − 100,000         = 86,450   ✓ equal
```

Two completely different routes to the same number. When they agree, the books are trustworthy.

---

## 5. Complete request and runtime flows

### 5.1 The architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  BROWSER                                                        │
│  (Day 4 frontend not built — these calls are made by tests      │
│   and by curl for now)                                          │
└────────────────────────────┬────────────────────────────────────┘
                             │  HTTPS  /api/v1/receipts
                             │  Authorization: Bearer <token>
                             │  X-Organization-Id: <uuid>
                             │  Idempotency-Key: <uuid>
┌────────────────────────────▼────────────────────────────────────┐
│  EXPRESS  (backend/src/app.js)                                  │
│                                                                 │
│   requestId → auditLog(listener) → helmet → cors → json parser  │
│                          ↓                                      │
│   authenticate    "who are you?"        (JWT)                   │
│   resolveTenant   "which company?"      (Membership lookup)     │
│   authorize       "may you?"            (RolePermission lookup) │
│   Zod .parse()    "is the body valid?"                          │
│                          ↓                                      │
│   ROUTE   backend/src/routes/receipts.js                        │
│                          ↓                                      │
│   runIdempotent  ── opens the transaction ──┐                   │
│                          ↓                  │                   │
│   SERVICE  lib/accounting/receipt-service.js│  ONE transaction  │
│    · lock invoices (FOR UPDATE, id order)   │                   │
│    · guards: over-allocation, period, org   │                   │
│    · locked doc/entry numbering             │                   │
│    · POSTING_RULES.receipt → journal lines  │                   │
│    · assert debits == credits               │                   │
│    · write Document, JournalEntry, lines,   │                   │
│      PaymentAllocation, update invoices     │                   │
│                          ↓                  │                   │
│   COMMIT ────────────────────────────────────┘                  │
│                          ↓                                      │
│   response sent → auditLog writes (after commit)                │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│  POSTGRESQL 16                                                  │
│   · balance trigger    (deferred — checks at COMMIT)            │
│   · immutability triggers (entry + line)                        │
│   · period-lock trigger                                         │
│   · CHECK amount > 0 on PaymentAllocation                       │
│   · UNIQUE (paymentDocumentId, targetDocumentId)                │
└─────────────────────────────────────────────────────────────────┘
```

### 5.2 One receipt, end to end

`POST /api/v1/receipts` with `Idempotency-Key: 7f3c...`, paying 100,000 against an invoice owing
135,600.

**Phase 1 — before any of our code runs**

1. Express assigns `req.id`, a random UUID for tracing this one request through the logs.
2. The audit middleware registers a `res.on('finish')` listener — it will fire *after* the response
   is sent, not now.
3. `helmet()` sets security headers; `cors()` applies the origin policy; `express.json()` parses the
   body into `req.body`.

**Phase 2 — the three questions**

4. `authenticate` reads the `Authorization: Bearer ...` header, verifies the JWT's signature and
   expiry, and sets `req.userId`. Invalid or expired → **401**, and no database query ever happens.
5. `resolveTenant` reads `X-Organization-Id`, then **looks up an active membership** for this user
   and that organisation. The header alone is never trusted — anyone can type any UUID. Not a member
   → **403**. On success it sets `req.organizationId` and enters an AsyncLocalStorage context that
   the Prisma tenant extension reads on every later query.
6. `authorize('payment.create')` queries `RolePermission` for this user's role. Missing → **403**.
   Note this is read from the database on every request, not baked into the token, so revoking a
   role takes effect on the very next request.

**Phase 3 — validation**

7. `createReceiptSchema.parse(req.body)` checks every field, coerces the amounts, and rejects any
   unknown property because of `.strict()`. Failure → **400** with a per-field list.

**Phase 4 — the transaction**

8. The `Idempotency-Key` header is present, so `runIdempotent` runs. **BEGIN.**
9. `SAVEPOINT idempotency_insert`, then insert the key row. First time → succeeds.
10. `postReceipt(actor, input, tx)` runs inside that same transaction.
11. Party and deposit account verified as belonging to this company.
12. Fiscal year located; accounting period confirmed open.
13. `SELECT ... FOR UPDATE` on the invoice — **now locked**. A competing receipt would wait here.
14. Guards: it is an invoice, it is open, 100,000 ≤ 135,600. Pass.
15. `RCP-2082-0001` and `JE-2082-0002` allocated from their own locked counter rows.
16. `POSTING_RULES.receipt` returns `Dr Bank 100,000 / Cr AR 100,000`; the balance assertion passes.
17. The receipt `Document` row is written.
18. The `JournalEntry` and its two `JournalLine` rows are written. The period-lock trigger fires on
    insert and passes.
19. One `PaymentAllocation` row is written; the `CHECK amount > 0` passes.
20. The invoice is updated: outstanding 135,600 → 35,600, allocated → 100,000, status →
    `PARTIALLY_PAID`, version +1.
21. The idempotency row is updated with the response we are about to send.
22. **COMMIT.** The deferred balance trigger now fires and confirms debits equal credits. All locks
    release.

**Phase 5 — response and audit**

23. `res.status(201).json(body)` sends the receipt, its journal entry, and the allocation summary.
24. The `finish` listener fires and writes the audit row — *after* the commit, so a rolled-back
    operation can never leave a log entry claiming it happened.

**What happens instead if the invoice only owed 35,600 and 100,000 was allocated to it**

Steps 1–13 are identical. At step 14 the guard fails and throws `businessRule('over_allocation')`.
Nothing from steps 15–21 runs. **ROLLBACK** — including the idempotency key row, which is correct:
the request genuinely failed, so a retry should be allowed to try again. The error handler in
`app.js` reads `err.status` (422) and `err.code` and returns:

```json
{ "error": { "code": "over_allocation", "message": "...", "requestId": "..." } }
```

The invoice is untouched. No receipt exists. This is INV-7.

**What happens on a retry with the same key**

Steps 1–8 identical. At step 9 the insert hits the unique constraint → `P2002`. The transaction is
poisoned, so `ROLLBACK TO SAVEPOINT` un-poisons it. The stored row is read: the request hash matches
and a response is recorded, so `{ replayed: true, status: 201, body: <stored> }` comes back. The
route sets `Idempotent-Replay: true`, skips the audit entry, and returns the identical body. **No
second payment exists.**

### 5.3 Reversing a receipt

`POST /api/v1/journal-entries/<id>/reverse` with `{ "reason": "recorded in error", "reversalDate": "2025-07-25" }`.

```
authenticate → resolveTenant → authorize('journal.post') → Zod
                              ↓
BEGIN
  SELECT the entry FOR UPDATE                    → must be POSTED, else 409
  find fiscal year for 2025-07-25
  assert that period is open                     → else 422 period_locked
  read the original's lines:  Dr Bank 10,000 / Cr AR 10,000
  swap them:                  Dr AR 10,000 / Cr Bank 10,000
  allocate a new entry number
  INSERT the reversal entry + lines, reversalOfId = original.id
  UPDATE original SET status = 'REVERSED'        → trigger allows exactly this
  cascade, because sourceId points at a receipt:
      SELECT each allocated invoice FOR UPDATE
      outstanding  0 → 10,000
      allocated    10,000 → 0
      status       PAID → POSTED
      DELETE the PaymentAllocation rows
      mark the receipt REVERSED
COMMIT
                              ↓
write TWO audit rows (reversal_posted, marked_reversed)
                              ↓
200 { original: {...status: "reversed"}, reversal: {...reversalOfId: ...} }
```

Net effect on every account balance: **zero**. Journal entries deleted: **zero**. Journal lines
modified: **zero**. The invoice is back to owing what it owed, and the audit trail explains why.

### 5.4 The AR aging report

`GET /api/v1/reports/ar-aging?asOf=2025-11-15`

```
authenticate → resolveTenant → authorize('report.view') → Zod (asOf)
                              ↓
Query 1 — the SUBLEDGER (Document table)
    every INVOICE, status POSTED or PARTIALLY_PAID, outstanding > 0
    (uses the doc_open_by_party partial index)
                              ↓
    for each invoice:
        daysOverdue = asOf − dueDate
        pick a bucket: current / 1-30 / 31-60 / 61-90 / 90+
        add its outstanding to that bucket, for that customer
                              ↓
Query 2 — the GENERAL LEDGER (JournalLine table)
    SUM(debit) − SUM(credit) on account 1100, entries POSTED or REVERSED,
    dated on or before asOf
                              ↓
Compare the two independently-derived totals
                              ↓
200 {
      rows: [ per customer: buckets, total, invoice list ],
      totals:    { grandTotal: "6000.00" },
      integrity: { arControlBalance: "6000.00", balanced: true }
    }
```

The report answers the business question *and* proves its own arithmetic against the ledger in the
same response.

---

## 6. New concepts introduced

Only concepts that genuinely appear for the first time in this session are listed. Authentication,
JWT, middleware, multi-tenancy, RBAC, and the audit log were covered in the Day 2 document; the
posting engine and double-entry basics in the Day 3 document.

### Payment allocation (cash application)

Deciding which invoices a received payment settles. It is many-to-many: one payment can settle
several invoices, and several payments can settle one invoice. Each decision is stored as a
`PaymentAllocation` row with its own amount.

The reason it is not just a `paidAmount` column on the invoice is that a real payment rarely maps
one-to-one to a bill. A customer wires you NPR 90,000 covering three invoices and part of a fourth.
Without allocation rows you cannot answer "what did this payment actually pay for?" — which is the
first thing anyone asks when a customer disputes a balance.

### Over-allocation

Applying more money to an invoice than it owes. It is prevented at three levels in LedgerLine: the
service checks the amount against the freshly locked row, the row lock prevents two simultaneous
payments from both passing that check, and the schema's `outstandingAmount` design means a negative
balance would be a visible violation. Test INV-7 covers the sequential case, CONC-1 the concurrent
one.

### Customer advance (unapplied cash)

Money received that has not been assigned to any invoice — a deposit, a prepayment, or simply an
overpayment. It is legal and normal. In LedgerLine the receipt document carries it as its own
`outstandingAmount`, waiting to be allocated later. Supporting it costs nothing and its absence
would be conspicuous.

### Row lock (`SELECT ... FOR UPDATE`)

Reading rows in a way that also reserves them: any other transaction touching those rows waits
until yours commits. It is how a read-modify-write sequence is made safe against simultaneous
requests. Covered fully in section 4.2.

### Race condition

A bug whose outcome depends on the timing of concurrent operations. Invisible in single-user
testing; appears under load. The read-modify-write race is the one that matters for money.

### Deadlock

Two transactions each holding a lock the other needs, so neither can proceed. Postgres detects it
and kills one. Prevented here by always acquiring locks in the same order — sorting the invoice ids
before locking.

### Savepoint

A bookmark inside a transaction that you can partially roll back to without ending the whole
transaction. Needed because Postgres poisons an entire transaction after any statement fails —
catching the error in JavaScript is not enough. Section 4.3 and section 7.3.

### Idempotency replay

Returning the stored response from an earlier identical request instead of doing the work again,
identified by a client-supplied `Idempotency-Key` header. The response is byte-identical and carries
`Idempotent-Replay: true`.

### Credit note

A document that reduces what a customer owes, referencing the invoice it corrects. Its journal entry
is the exact mirror of the invoice's. The invoice itself is never modified — both documents survive
in the record.

### Reversal

Undoing a journal entry by posting a new one with every debit and credit swapped, then marking the
original `REVERSED`. The pair nets to zero and nothing is deleted.

### Credit note versus reversal — the distinction beginners confuse

They look similar and are used for completely different things:

| | Credit note | Reversal |
|---|---|---|
| Corrects | A **commercial** fact | A **posting** fact |
| Example | Customer returned goods | You posted to the wrong account |
| Creates | A new business document with its own number | A journal entry only |
| Amount | Can be partial | Always the full original |
| Customer sees it | Yes — it is a real document | No — it is internal bookkeeping |

Returning two of fifteen backpacks is a credit note: the sale genuinely changed. Typing 12,000 into
Other Expenses when you meant Rent Expense is a reversal: nothing about the business changed, only
your recording of it.

### Cascade

Following the consequences of one change through to related records. Reversing a receipt's journal
entry must also restore the invoices it paid and delete the allocation rows — otherwise the ledger
and the documents disagree.

### Subledger and general ledger

Two views of the same truth: the general ledger holds account balances, the subledger holds
per-document detail. Section 4.6.

### Control account

A general ledger account whose balance must always equal the sum of a subledger — Accounts
Receivable being the classic example. It is protected by forbidding manual entries into it, and its
agreement is asserted by test INV-3 and re-proved on every AR aging request.

### Denormalisation

Deliberately storing a value that could be recomputed, because recomputing it every time would be
too slow. `Document.outstandingAmount` is denormalised. The cost is the risk of drift; the mitigation
is the control-account check.

### AR aging and buckets

Sorting unpaid invoices by how far past due they are (current, 1–30, 31–60, 61–90, 90+ days). The
standard credit-risk and collections report.

### Debit-normal and credit-normal accounts

Which side an account's balance naturally sits on. Assets and expenses are debit-normal; liabilities,
equity and income are credit-normal. The general ledger report computes its running balance in
whichever direction is natural, so a revenue account does not display as negative.

### Running balance

A cumulative total that updates line by line down a report, showing what the account stood at after
each transaction. Requires an **opening balance** — the total of everything before the report window
— or the report would falsely imply the account started at zero.

### Opening balance

See above. Computed by summing every line dated before the report's start date.

### Trigger carve-out

Adding a narrow, precisely specified exception to a database rule that otherwise refuses everything.
Safe only when the exception verifies every field it is not supposed to change, and only when a test
attacks the database directly to prove the exception is not wider than intended. Section 4.4.

### `LEFT JOIN`

Combining two tables while keeping every row from the left one, filling the right side with `NULL`
where there is no match. Used in the general ledger report so that manual journal entries — which
have no source document — still appear.

### SQL injection and parameterised queries

An attack where hostile input is interpreted as SQL commands rather than data. Prevented by never
building SQL with string concatenation. Prisma's `$queryRaw` tagged template sends the values
separately from the SQL text, so the database can never mistake one for the other.

### Integration test

A test that exercises several real components together — here, HTTP request → Express → service →
real PostgreSQL. Slower than a unit test, but the only kind that can prove a database trigger, a row
lock, or a unique constraint actually works.

### Refactor

Changing the structure of code without changing its behaviour. Extracting `document-lines.js` was a
refactor; the proof is that every pre-existing invoice test passed unchanged afterwards.

---

## 7. Errors and debugging

Seven real problems from this session. None of them are hypothetical.

### 7.1 The trigger that would not compile — `The column (not available) does not exist`

**What happened.** The first version of the Day 4 migration applied cleanly. Then the existing test
suite ran and one Day 1 test failed:

```
Invalid `expect(prisma.journalLine.delete()` invocation
The column `(not available)` does not exist in the current database.
```

The failing test was `src/db/triggers.test.js:130` — "rejects deleting a posted line". It had passed
for three days.

**Why it happened.** My first attempt reused Day 1's single shared trigger function and added a
guard so it would behave differently per table:

```sql
IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'JournalEntry'
   AND OLD.status = 'POSTED' AND NEW.status = 'REVERSED'
   AND NEW."entryNumber" = OLD."entryNumber"      -- ← the problem
   ...
```

The reasoning seemed sound: the same function is attached to both `JournalEntry` and `JournalLine`,
so check `TG_TABLE_NAME` and only apply the entry-specific logic on the entry table.

It does not work. **PL/pgSQL resolves field references against the actual table the first time the
function runs for that table — including references inside branches that can never be reached
there.** `JournalLine` has no `entryNumber` column, so the moment the function fired for a
`JournalLine` delete, it failed to compile. The `TG_TABLE_NAME` check never got a chance to
short-circuit anything, because compilation happens first.

The confusing error message comes from that: Postgres could not name the missing column, so it
reported `(not available)`.

**How we diagnosed it.** The error named `journalLine.delete` and mentioned a column, but the test
was about *deletion* and did not reference any column at all. That mismatch pointed at the trigger
rather than the test. Reading the new function and asking "which of these columns exists on
JournalLine?" gave the answer immediately — none of them.

**The fix.** Give `JournalEntry` its own function and leave `JournalLine` on the original,
unconditional one:

```sql
CREATE OR REPLACE FUNCTION block_journal_entry_mutation() ...   -- new, with the carve-out
DROP TRIGGER "journal_entry_immutable" ON "JournalEntry";
CREATE TRIGGER "journal_entry_immutable" ... EXECUTE FUNCTION block_journal_entry_mutation();

CREATE OR REPLACE FUNCTION block_journal_mutation() ...          -- unchanged, JournalLine only
```

**Why the fix works.** Each function only ever references columns that exist on the one table it is
attached to, so both compile. As a bonus the result is *safer* than the original plan: `JournalLine`
is now provably untouchable, because its function has no conditional path at all.

**The lesson.** Database code is not application code. In JavaScript, an `if` that is never true
costs nothing. In PL/pgSQL, a reference inside a dead branch is still resolved against the real table
and can still fail. When one function serves two tables, it may only touch columns common to both.

### 7.2 The blocked database reset, and checking a change against the plan

**What happened.** With the trigger fix written, the local database still contained the *broken*
version. The natural repair is `npx prisma migrate reset --force`, which drops the database and
replays every migration. Prisma refused:

```
Error: Prisma Migrate detected that it was invoked by Claude Code.
You are attempting a highly dangerous action ...
```

Prisma ships a deliberate guard: an AI agent may not run a destructive database command without the
human explicitly approving it.

**How we handled it.** I stopped and explained what the command would do, what would be lost (nothing
— a throwaway container created minutes earlier), and asked. The answer was:

> "do not affect the trigger unless it is mentioned in the 7 day plan"

That is the right instinct — modifying a security control deserves a challenge. So the next step was
to verify the claim rather than assert it. The plan does specify it, in two places:

- §5, on the `journal_entries` triggers: the immutability trigger permits exactly one UPDATE, "the
  reversal back-reference".
- §6, worked example 5, step 4: *"Set the original's `status = 'reversed'` … This is the one status
  transition the immutability trigger permits — it changes no financial field."*

So the carve-out was in scope. But the *reset* was still avoidable, so we did not do it. Instead we
applied the two corrected functions directly to the running database:

```bash
docker compose exec -T postgres psql -U ledgerline -d ledgerline << 'EOF'
CREATE OR REPLACE FUNCTION block_journal_entry_mutation() ...
DROP TRIGGER "journal_entry_immutable" ON "JournalEntry";
CREATE TRIGGER "journal_entry_immutable" ... ;
CREATE OR REPLACE FUNCTION block_journal_mutation() ...
EOF
```

**Why the fix works.** `CREATE OR REPLACE FUNCTION` overwrites a function in place. The migration
file on disk already contained exactly the same SQL, so the live database and the migration history
agree — a colleague running `prisma migrate deploy` on a fresh database gets an identical result. We
then reran the full suite to confirm.

**The lesson.** Two, actually. First: when someone challenges a change to a security control, verify
the justification in writing rather than repeating the claim — the plan either says it or it does
not. Second: destructive commands usually have a narrower alternative. Dropping a database to fix two
functions is a bigger hammer than the job needs.

### 7.3 The idempotency helper that never worked — `current transaction is aborted`

**What happened.** IDEM-1 and IDEM-2 both failed with HTTP 500 instead of the expected 201 replay and
422:

```
Invalid `tx.idempotencyKey.findFirst()` invocation
Database error. Code: `25P02`. Message: `current transaction is aborted,
commands ignored until end of transaction block`
```

**Why it happened.** The Day 2 code assumed that catching an error in JavaScript restores the
connection to a usable state:

```js
try {
  created = await tx.idempotencyKey.create({ ... });   // fails: duplicate key
} catch (err) {
  if (err.code !== 'P2002') throw err;
  const existing = await tx.idempotencyKey.findFirst({ where: { key } });  // ← this also fails
```

Postgres does not work that way. **Once any statement inside a transaction fails, the entire
transaction is poisoned** — every subsequent statement is refused with `25P02` until you roll back.
The JavaScript `catch` caught the first error, but the connection was already unusable, so the very
next query failed too.

This bug had been in the repository since Day 2 and was invisible because **nothing called the
function**. Day 2's own documentation flagged this: "The `runIdempotent` helper has no caller yet. It
is built and correct." It was built. It was not correct.

**How we diagnosed it.** The Postgres error code `25P02` is specific and its message says exactly
what happened. The give-away is *which* query failed — not the `create` we expected to fail, but the
`findFirst` on the line after it. A query failing that has nothing wrong with it means the connection
is in a bad state, not the query.

**The fix.** A savepoint around the risky insert:

```js
await tx.$executeRaw`SAVEPOINT idempotency_insert`;
try {
  created = await tx.idempotencyKey.create({ ... });
} catch (err) {
  if (err.code !== 'P2002') throw err;
  await tx.$executeRaw`ROLLBACK TO SAVEPOINT idempotency_insert`;
  const existing = await tx.idempotencyKey.findFirst({ where: { key } });   // now works
```

**Why the fix works.** `ROLLBACK TO SAVEPOINT` undoes only the failed statement and clears the
aborted state, leaving the transaction alive. The outer transaction — which must still contain the
payment — survives.

**Why not check-then-insert instead?** Because two simultaneous requests could both check, both find
nothing, and both insert. Attempting the insert and letting the unique constraint pick a winner is
atomic; checking first is a race condition.

**The lesson.** Code with no callers is not tested code, however carefully it was written. It is a
hypothesis. Also: database transactions have their own error semantics that do not map onto
`try`/`catch` — a caught error does not mean a recovered connection.

### 7.4 Test arithmetic and an assumption about isolation

Two failures in the first run of `receipt-service.test.js`, both bugs in the *tests*, not the code.

**Failure 1 — my arithmetic.**

```
AssertionError: expected '20000.00' to be '10000.00'
```

The test posts a 90,000 receipt allocating 50,000 to one invoice and 20,000 to another, then asserts
the unapplied advance. I wrote `10000.00`. The correct answer is 90,000 − 70,000 = **20,000**. The
code was right and the assertion was wrong.

Worth stating plainly because it is a real risk: when a test fails, the tempting move is to "fix"
the code until the test passes. Here that would have introduced a bug to satisfy a typo. Recomputing
the expected value by hand *first* is what tells you which side is wrong.

**Failure 2 — assuming test isolation that does not exist.**

```
AssertionError: expected 4 to be 1
```

The INV-7 test asserted that exactly one receipt existed after a successful post and a rejected one.
But every test in the file shares one database, seeded once in `beforeAll`. Three earlier tests had
already created receipts, so the count was 4.

The assertion was also asking the wrong question. What INV-7 needs to prove is that *the rejected
attempt wrote nothing* — not that the table has exactly one row. Fixed by measuring the delta:

```js
    const receiptCountBefore = await prisma.document.count({ where: { docType: 'RECEIPT' } });
    ...
    const receiptCountAfter = await prisma.document.count({ where: { docType: 'RECEIPT' } });
    expect(receiptCountAfter).toBe(receiptCountBefore + 1);
```

**The lesson.** Assert the change you care about, not an absolute you happen to observe. Absolute
counts couple a test to every other test in the file and break the moment one is added.

### 7.5 The default reversal date fell outside the fiscal year

**What happened.** All three meaningful tests in `reverse-entry.test.js` failed with 422 instead of
200:

```
Error: No fiscal year covers 2026-08-15
```

**Why it happened.** `reverseEntry` defaults the reversal date to today:

```js
const date = reversalDate ? new Date(reversalDate) : new Date();
```

`new Date()` is the real current date — 2026-08-15 when the tests ran. The test fixture creates a
fiscal year running 2025-07-16 to 2026-07-15. Today was a month past the end of it, so
`findFiscalYearForDate` correctly refused.

**How we diagnosed it.** The error message named a date the test never mentions. A date appearing
from nowhere means it was defaulted, and the only default in that path is `new Date()`.

**The fix.** Pass an explicit date in the tests:

```js
.send({ reason: 'posted to the wrong account', reversalDate: '2025-07-25' })
```

**Why the fix is in the test and not the code.** The default is correct behaviour — reversing
something today should date it today. The test fixture is what is artificial: it uses a fiscal year
in the past so that dates are stable. A test that only passes on certain calendar days is a worse
problem than an explicit parameter.

**The lesson.** `new Date()` is a hidden input. Any code that reads the clock behaves differently
depending on when it runs, and tests must pin it. This is also why the plan insists posting rules are
*pure* — no clock, no randomness — and why the clock lives in the service layer where it can be
overridden.

### 7.6 Report tests that depended on other tests

Two failures in `reports.test.js`, both the same underlying mistake in different clothes.

**Failure 1 — fixture dates outside the fiscal year.** The AR aging test posted invoices dated
2025-06-01, before the fiscal year began on 2025-07-16, and into months with no accounting period
row. Fixed by moving the dates inside the fiscal year and adding the two missing periods to the
fixture. Note the *system* behaved correctly throughout — it refused to post into a period that does
not exist, which is exactly its job.

**Failure 2 — a running balance that assumed an empty account.**

```
AssertionError: expected '3500.00' to be '0.00'
```

The general ledger test asserted `openingBalance` was `0.00`, then that the running balance after two
invoices of 500 and 750 was 500 and 1,250. But the AR aging test earlier in the same file had already
posted 6,000 of invoices to the same revenue account. The opening balance was legitimately 3,500.

My first fix was to move the test to a different date window — which failed again, because *another*
test used that window too. The second fix stopped fighting it and asserted the relationship instead
of the absolute:

```js
    const before = await request(app).get('/api/v1/reports/general-ledger').query({ ... });
    const opening = Number(before.body.openingBalance);

    // ... post two invoices ...

    expect(res.body.lines[0].runningBalance).toBe((opening + 500).toFixed(2));
    expect(res.body.lines[1].runningBalance).toBe((opening + 1250).toFixed(2));
```

**Why this is a better test, not a weaker one.** What the general ledger report must actually do is
accumulate correctly *on top of whatever came before*. Asserting `0 → 500 → 1250` tested that plus an
accidental assumption about test ordering. Asserting `opening → opening+500 → opening+1250` tests
exactly the property that matters and cannot be broken by adding another test to the file.

**The lesson.** The same one as 7.4, learned twice in one session: in a suite that shares a database,
assert relationships and deltas, never absolutes you did not set up yourself.

### 7.7 The git worktree that would not delete

**What happened.** All the work was done in a **git worktree** — a second checkout of the same
repository in its own folder, on its own branch, so `main` stays untouched. After merging, removing
the worktree failed repeatedly:

```
Deletion of directory '.../agent-loop-day-4-tasks-6d2a18' failed. Should I try again? (y/n)
error: failed to delete '...': Permission denied
```

Then, confusingly:

```
git worktree remove .claude/worktrees/agent-loop-day-4-tasks-6d2a18
fatal: '...' is not a working tree
```

**Why it happened.** Two separate things. First, Windows refuses to delete a folder any process has
open — and the session doing the deleting was itself running with that folder as its working
directory. Second, `git worktree remove` had already *deregistered* the worktree before failing to
delete the files, so the retry found nothing registered while the files were still on disk.

**How we diagnosed it.** `git worktree list` showed only the main checkout, while `ls` showed the
folder still present. That mismatch — git thinks it is gone, the filesystem disagrees — identifies
it as an OS lock rather than a git problem.

**The fix.** The git side was already complete: `main` had the merge commit, and `git branch -d`
succeeded (the lowercase `-d` only deletes a branch that is fully merged, so it doubles as a safety
check). The leftover folder was deleted manually from Explorer after closing the session holding it.

**The lesson.** When a tool reports two contradictory things about the same object, the object is
probably in two systems that disagree — here git's metadata and the filesystem. Also: a process
cannot delete the directory it is running inside, on Windows.

---

## 8. Final understanding check

You should be able to answer these from the document. If an answer does not come, the linked section
is worth re-reading.

### On what we built

1. What are the three new ways money or corrections can now move through the system, and what is the
   difference between them?
2. Why does a receipt have no draft phase when an invoice does?
3. What is a customer advance, and where does the unapplied amount live?
4. Walk through what a credit note does to the original invoice. Which of its columns change and
   which deliberately do not?
5. Why did Day 4 need a database migration at all — what could not be expressed with the existing
   tables?

### On security and correctness reasoning

6. An invoice owes 35,600 and two payments of 30,000 arrive at the same instant. Explain exactly what
   happens, naming the mechanism that prevents both from succeeding.
7. Why are the invoice ids sorted before locking? Describe the failure that would occur without it.
8. Why must the idempotency key row and the payment be written in the same transaction? Describe both
   failure modes that two separate transactions would allow.
9. Why is Postgres used for idempotency keys instead of Redis, even though Redis is faster?
10. Why does looking up an account belonging to another organisation return 404 rather than 403?
11. The immutability trigger now has an exception. List everything it still refuses, and explain how
    we verified the exception is not wider than intended.
12. Why does `postReceipt` assert that debits equal credits when a database trigger already checks it
    at commit?
13. Why is `credit_exceeds_outstanding` a deliberate refusal rather than a missing feature? What
    would break if we allowed it?
14. Which reversal is refused outright, and why does the error message point the user at a credit
    note instead?

### On architecture

15. What does it mean that `POSTING_RULES` functions are *pure*, and what does that buy us?
16. Why does `postReceipt` take an optional `tx` parameter? What decides which branch runs?
17. Why was `resolveLines` extracted into `document-lines.js` instead of being copied into the credit
    note service?
18. Why does the AR aging report query the `Document` table while the trial balance queries
    `JournalLine`? What is the relationship between the two answers?
19. What is a control account, and what two rules keep Accounts Receivable trustworthy?
20. Why is `outstandingAmount` stored at all, when it could be computed from the ledger? What risk
    does storing it create and how is that risk managed?
21. Why does the reversal route write two audit entries directly instead of using the `req.auditEntry`
    convention every other route uses?
22. Why does the general ledger report use a `LEFT JOIN` to `Document` rather than a plain `JOIN`?
    What would silently disappear otherwise?
23. Why is `PaymentAllocation` in `TENANT_SCOPED_MODELS`, and what would happen if it were forgotten?

### On the request lifecycle

24. Trace `POST /api/v1/receipts` with an idempotency key from browser to database and back. Name
    every middleware and say what each one decides.
25. At which exact step does an over-allocated request stop, and what is left in the database
    afterwards?
26. A client retries a receipt with the same `Idempotency-Key`. Describe every step, including what
    the savepoint does and why no audit entry is written.
27. Reversing a receipt changes five things across three tables. Name them.

### On the money rules

28. Why is `0.1 + 0.2` a problem for an accounting system, and what does LedgerLine use instead?
29. Give two reasons `+` must never be used on a money value in this codebase.
30. Why does money leave the API as a string like `"135600.00"` rather than a number?

### On debugging

31. Why did a trigger function with a `TG_TABLE_NAME` guard fail to compile for `JournalLine`, even
    though the guard would have skipped that branch at runtime?
32. `runIdempotent` was written on Day 2 and described as "built and correct". Why was it neither
    tested nor correct, and what does that suggest about code with no callers?
33. What does Postgres error `25P02` mean, and why is a JavaScript `try`/`catch` not enough to recover
    from a failed statement inside a transaction?
34. Two separate test failures in this session came from the same root mistake about test isolation.
    What was it, and what is the general rule that avoids it?
35. A test failed with `No fiscal year covers 2026-08-15` when no test mentions that date. What does
    that tell you, and why was the fix applied to the test rather than the service?

### On the plan

36. Which Day 4 objectives are complete and which are not started? What is the reason for the split?
37. CONC-3 is not implemented, yet the mechanism it would test is. Explain that apparently
    contradictory statement.
38. Why must every report Day 5 adds use `status IN ('POSTED', 'REVERSED')`? What would go wrong,
    and why would it be hard to notice?
39. What does Day 5's bank reconciliation need from the work done in this session?

---

## Quick reference

**Start the database** (from the repository root)
```bash
docker compose up -d postgres redis
```

**Apply migrations and generate the client**
```bash
cd backend
npx prisma migrate deploy
npx prisma generate
```

**Run the backend**
```bash
cd backend
npm run dev
```

**Run the tests** (this truncates the database)
```bash
cd backend
npm test
npm run seed
```

**Environment variables** — `backend/.env`, not committed:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | `postgresql://ledgerline:ledgerline@localhost:5432/ledgerline` |
| `JWT_SECRET` | Signs access tokens |
| `NODE_ENV` | `development` locally |

**Day 4 endpoints**

| Method | Path | Permission | Purpose |
|---|---|---|---|
| `POST` | `/api/v1/receipts` | `payment.create` | Record a payment, allocate to invoices |
| `GET` | `/api/v1/receipts/:id` | `report.view` | One receipt with its allocations |
| `POST` | `/api/v1/credit-notes` | `invoice.post` | Credit an invoice |
| `GET` | `/api/v1/credit-notes/:id` | `report.view` | One credit note with its lines |
| `POST` | `/api/v1/journal-entries/:id/reverse` | `journal.post` | Reverse an entry, cascade to its document |
| `PATCH` | `/api/v1/periods/:id` | `org.manage` | Lock or unlock an accounting period |
| `GET` | `/api/v1/reports/ar-aging` | `report.view` | Who owes what, bucketed by age |
| `GET` | `/api/v1/reports/general-ledger` | `report.view` | One account's movements, running balance |

**Error codes introduced in Day 4**

| Code | Status | Meaning |
|---|---|---|
| `over_allocation` | 422 | More money applied than the invoice owes, or than the receipt holds |
| `invoice_not_open` | 422 | Target is not `POSTED` or `PARTIALLY_PAID` |
| `not_an_invoice` | 422 | Allocation target is not an invoice |
| `credit_exceeds_outstanding` | 422 | Credit note larger than the invoice's remaining balance |
| `cannot_reverse_invoice_with_activity` | 422 | Invoice has payments or credit notes — use a credit note |
| `already_reversed` | 409 | Entry is not in `POSTED` state |
| `idempotency_key_reuse` | 422 | Same key, different request body |
| `idempotency_in_progress` | 409 | An identical request is still running |

**Tests from the plan covered in this session**

| Test | Meaning | File |
|---|---|---|
| INV-3 | Subledger equals general ledger | `routes/receipts.test.js` |
| INV-7 | Over-allocation is impossible | `lib/accounting/receipt-service.test.js` |
| INV-8 | Reversal nets to zero, preserves both entries | `lib/accounting/reverse-entry.test.js` |
| INV-10 | Period locking enforced | `routes/reports.test.js` |
| IDEM-1..3 | Idempotent payments, tenant-scoped keys | `routes/receipts.test.js` |
| CONC-1 | Concurrent over-allocation refused | `lib/accounting/receipt-service.test.js` |
| CONC-2 | Concurrent posting, gapless numbering | `lib/accounting/post-document.test.js` |
