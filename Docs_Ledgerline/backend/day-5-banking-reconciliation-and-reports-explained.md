# Day 5 — Banking, Bank Reconciliation, and the Remaining Financial Reports

This document explains everything built in the Day 5 backend session, from zero. It uses the actual
LedgerLine codebase as the source of truth. Every code block below is copied from a real file in
this repository, and every file path is exact.

**Base commit:** `17b69f9 — Day 4 backend: receipts, allocation, credit notes, reversal, period lock, AR/GL reports`

**This session's work is not yet committed.** At the time of writing, `git status` shows 11 modified
files and 6 new paths. Section 3 lists every one of them. When you commit, this document's "files
created and modified" section is your commit message checklist.

**Test count: 108 → 122 tests**, all passing. Lint clean across the whole backend.

**Scope note.** This session covered the *backend half* of Day 5 only — Developer A's slice in the
plan. The Day 5 frontend work (the banking module, the two-column reconciliation workspace, the
P&L / Balance Sheet / Reconciliation Summary screens, CSV export) was deliberately not started.
Section 2 explains exactly what that leaves open.

**A note on how this session actually went.** Partway through, two pieces were first built as
simplified versions and then, on your instruction, rebuilt to match the plan exactly. That is
recorded honestly in section 2.7 and section 7, because the reasoning on both sides is worth
understanding — it is a real example of the trade-off between "smallest thing that works" and
"what the specification actually says."

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

Before this session, LedgerLine could handle money flowing in two directions, entirely on its own
authority.

In plain language: you could create an invoice ("the customer owes us 135,600"), post it to the
ledger, record a receipt when they paid ("we received 100,000, apply it to that invoice"), issue a
credit note if they returned goods, and reverse an entry posted by mistake. You could run a trial
balance, a general ledger drill-down, and an AR aging report.

Every one of those numbers came from inside LedgerLine. **Nothing had ever been checked against the
outside world.**

That is a genuine problem, and it is the reason bank reconciliation exists as a discipline. Your
books say the bank account holds 625,850. Does it? The only way to know is to get the bank's own
record — a *bank statement* — and compare it, line by line, against what your books claim. Every
difference is either something the bank knows that you do not (a service charge you were never
told about), or something you know that the bank does not yet (a cheque you wrote that has not
cleared), or an error.

Before this session, LedgerLine had no concept of a bank statement, no way to import one, no way to
compare it against the ledger, and no way to record that a comparison had been done and came out
clean. It also had only four of its six planned financial reports.

That is what this session built.

---

### The eight problems we solved

---

**Problem 1 — There was no way to get bank data into the system at all.**

*What was wrong before:* LedgerLine had an `Account` table with an `isBankAccount` boolean flag, and
that was the entire extent of its banking knowledge. There was no table for a bank account's real-
world details (which bank, which account number), no table for a statement, and no table for the
individual lines on a statement.

*Why it matters:* Reconciliation is fundamentally "compare two lists." Without somewhere to put the
bank's list, there is nothing to compare against.

*What we built:* Four new database tables — `BankAccount`, `BankStatement`, `BankStatementLine`,
and `Reconciliation` — plus a CSV import pipeline that turns an uploaded file into rows in those
tables.

*Why this solution:* We deliberately did **not** integrate with a real bank API. Real bank
integration means OAuth flows, per-bank quirks, sandbox credentials, and rate limits — weeks of
work that demonstrates nothing about accounting. A CSV upload is what most small-business
accounting software actually offers anyway, and it lets the interesting part (the matching) be the
focus.

---

**Problem 2 — Matching is a real problem, not a database lookup.**

*What was wrong before:* Nothing existed. But the naive thing somebody might build is
`WHERE amount = amount` — find the ledger line with the same number, call it a match, done.

*Why that is not enough:* Consider a statement line that reads
`NEFT/HIMALAYAN TREK SUPPLIES/INV-2082-0001` for 100,000 on 5 February. Your ledger might contain
three separate 100,000 movements that week. Which one is it? A pure amount lookup finds all three
and can tell you nothing. Meanwhile the description contains the invoice number and the customer
name — information a human would use instantly and a naive query throws away.

*What we built:* A **four-pass confidence-scored matching engine**. Every candidate ledger line gets
a score between 0 and 1, built from three weighted components (amount as a hard gate, date
proximity, and reference/name similarity), with the party-name comparison done using PostgreSQL's
`pg_trgm` trigram similarity extension so `"IPS/EVEREST CAFE PVT LTD"` can be recognised as probably
being `"Everest Cafe Pvt. Ltd."`.

*Why this solution:* Because a score lets you express *confidence*, and confidence lets you split
behaviour three ways: high confidence auto-confirms, medium confidence asks a human, and no
candidate is flagged for investigation. A boolean match can only ever say yes or no, and a wrong
"yes" in accounting software hides a real error forever.

---

**Problem 3 — Two statement lines can both want the same ledger line.**

*What was wrong:* Scoring alone is not enough. Suppose two statement lines each score 0.95 against
the *same* journal line. If you process them independently, you match that one journal line twice —
which is nonsense, because one real-world movement of money cannot be two different statement
lines.

*Why it matters:* This is the difference between "I compute scores" and "I solve an assignment
problem." Reconciliation requires a **one-to-one** pairing: each statement line matches at most one
journal line, and each journal line is claimed by at most one statement line.

*What we built:* A **greedy bipartite assignment** pass. All `(statementLine, journalLine, score)`
triples above the threshold are collected, sorted by score descending, then walked top to bottom;
a pair is accepted only if *neither* side has already been claimed.

*Why this solution over the theoretically optimal one:* The globally optimal answer to this problem
is the Hungarian algorithm (or min-cost max-flow). Greedy is not guaranteed optimal. We chose greedy
deliberately, and the reason is worth being able to say out loud: at statement scale the top scores
cluster near 1.0, where greedy and optimal agree, and *anything scoring below 0.90 is shown to a
human for confirmation anyway* — so the cases where greedy could differ from optimal are exactly the
cases a person is already reviewing. Knowing the optimal algorithm and choosing not to use it, with
a stated reason, is a stronger signal than shipping it.

---

**Problem 4 — A tie must never auto-confirm.**

*What was wrong:* This one goes beyond what the plan's pseudocode literally specifies, and it is the
one place this session deliberately added a rule.

Consider the plan's own edge case: two identical NPR 5,000 transfers from the same customer on the
same day. Both are legitimate. Both statement lines score *identically* against both journal lines —
same amount, same date, same party name. Greedy assignment will happily pair them up in whatever
order the sort happened to produce, and because the scores are high, it would auto-confirm both.

*Why it matters:* It has a 50% chance of pairing them backwards. In this specific case the two
pairings are financially interchangeable, so nothing breaks — but the system has just *asserted* a
fact it had no evidence for. The plan is explicit that this must not happen: "a coin-flip
auto-match is worse than asking."

*What we built:* Before assignment runs, the engine checks each statement line's own candidate list.
If its top two candidates score within a floating-point epsilon of each other, that line is marked
*ambiguous* and can never auto-confirm — it becomes a suggestion for a human, regardless of how high
the score is.

*Why this solution:* It puts the rule where the evidence is. The ambiguity is a property of *one
statement line's candidate list*, so it is computed from that list, before any candidate has been
claimed by the greedy walk.

---

**Problem 5 — An unmatched line needs somewhere to go.**

*What was wrong:* Suppose the statement shows `MONTHLY SERVICE CHARGE 1,130.00` and your ledger has
nothing like it. That is not an error in the matcher — it is a real transaction the bank performed
that you were never told about and therefore never recorded. If unmatched lines can only sit there,
the reconciliation can never balance.

*Why it matters:* This is the single most satisfying moment in the whole demo. An unexplained 1,130
becomes a real ledger entry, and the difference on screen falls to zero.

*What we built:* Three resolution paths, each an endpoint:

1. **Manual match** — the user picks any candidate from a list. Records `matchedBy: 'manual'`,
   confidence exactly 1.0, and writes an audit row naming who did it.
2. **Create an entry from the line** — the user picks an account (e.g. `5500 Bank Charges`) and the
   system posts a real journal entry through `postDocument()`, *the same posting engine every
   invoice goes through*, then auto-matches the new bank-side journal line to the statement line.
3. **Ignore** — an internal transfer already recorded elsewhere. Requires a written reason, is
   excluded from the difference calculation, and is retained in the record forever.

*Why this solution:* Note what path 2 is *not*: it is not a special "adjustment" table with its own
rules. It creates a `Document`, gives it `DocumentLine` rows, and posts it through the exact
function that posts invoices. That means it inherits period locking, locked-counter numbering, the
balance assertion, the immutability triggers, and reversibility — for free, and provably, because
it is literally the same code path.

---

**Problem 6 — "Reconciled" has to be a real control, not a label.**

*What was wrong:* It would be easy to build a `Reconciliation` row with a `status` column and let
the application set it to `completed` whenever the user clicks the button.

*Why that is not enough:* In accounting, "this bank account is reconciled as at 28 February" is a
*claim* — an assertion that the books and the bank agree to the paisa on that date. If a bug, a
bad migration, or a direct `UPDATE` in a database console can mark a reconciliation complete while
the difference is 1,130, then the claim is worthless, because it can be false.

*What we built:* Two layers.

- The service recomputes book balance, bank balance, difference, and unresolved-line count *at
  completion time* — not trusting the numbers stored when the reconciliation was created, because
  matches may have happened in between — and refuses with HTTP 422 if either is nonzero.
- The database carries a `CHECK` constraint:
  `CHECK ("status" <> 'COMPLETED' OR "difference" = 0)`.

*Why this solution:* The `CHECK` is the internal control **expressed in DDL**. It is not enforced by
remembering to call the right function; it is enforced by PostgreSQL refusing to write the row. Test
RECON-7 proves both layers independently: it asserts the endpoint returns 422, and then it fires a
raw SQL `UPDATE` straight at the table and asserts *that* is rejected too.

---

**Problem 7 — Reversal could have silently corrupted a completed reconciliation.**

*What was wrong before:* `reverseEntry()` existed from Day 4 and knew nothing about bank statements —
they did not exist yet. Once statement lines can point at journal lines, reversing an entry whose
line is matched would leave a `BankStatementLine` pointing at a journal entry that has been undone.

*Why it matters:* Two distinct bad outcomes. If the reconciliation is still in progress, the
statement line should return to `unmatched` so the workspace picks it up again — otherwise the line
silently claims to be explained by an entry that no longer means anything. If the reconciliation is
already *completed*, reversing would break a closed period: the difference that was certified as
zero is now not zero.

*What we built:* A guard at the top of `reverseEntry()`. It looks up every statement line matched to
any of the entry's journal lines. If any is `RECONCILED`, the whole reversal is refused with
`422 reconciled_period`. Otherwise each matched line is reset to `UNMATCHED` with its match fields
cleared, inside the same transaction as the reversal itself.

*Why this solution:* Putting it in `reverseEntry()` rather than in the banking module means *every*
caller is covered — the receipt reversal path, the invoice reversal path, and the bank-adjustment
reversal path — with one guard instead of three.

---

**Problem 8 — A latent Day 4 bug: receipts were never linked to their journal entry.**

*What was wrong:* This was not on the plan. It was found by the matching engine failing a test.

`postDocument()` (used by invoices) writes `Document.journalEntryId` when it posts — that column is
the link from a business document back to its accounting record. But `postReceipt()` creates the
document and the journal entry in the *opposite* order (a receipt has no draft phase — it
create-and-posts in one step), and it never went back to fill in that link. So for every receipt in
the database, `Document.journalEntryId` was `NULL`.

*Why it matters, and how we found it:* The matching engine's candidate query does
`LEFT JOIN "Document" d ON d."journalEntryId" = je.id` in order to read the document number and the
customer name for reference scoring. With the link missing, that join produced `NULL` for every
receipt — so `doc_no` was null, `party_name` was null, the reference score was always 0, and no
receipt could ever score above 0.80. RECON-1 expected 3 auto-matches and got 0.

The same bug also silently degraded a Day 3 feature: `GET /reports/general-ledger` returns
`sourceDocumentId` via the identical join, so clicking a receipt row in the general ledger would
never have linked back to the receipt.

*What we built:* One extra write in `postReceipt()` after the journal entry is created, setting
`journalEntryId` on the document, inside the existing transaction.

*Why it matters that a test found it:* Nothing in the Day 4 test suite asserted that link existed.
The bug was invisible until a feature depended on it.

---

**Problem 9 — Two of the six planned reports did not exist.**

*What was wrong before:* LedgerLine had Trial Balance, General Ledger, and AR Aging. The plan calls
for six reports. Profit & Loss, Balance Sheet, and the Bank Reconciliation Summary were missing.

*Why it matters:* The Balance Sheet in particular is the report that proves you understand the
accounting equation, and it contains the single most commonly botched mechanic in home-grown
accounting systems — explained in depth in section 4.6.

*What we built:* All three endpoints, each a pure aggregation over `JournalLine`.

---

### Everything created

**The banking library** (`backend/src/lib/banking/`)
- `csv.js` — CSV parsing, normalisation, validation, and the two hashes
- `matching-engine.js` — the candidate query, the four-pass scoring, greedy assignment
- `statement-import-service.js` — the end-to-end import pipeline
- `reconciliation-service.js` — manual match, create-entry, ignore, create/complete reconciliation

**HTTP routes**
- `backend/src/routes/banking.js` — nine endpoints (bank accounts, statement import, statement
  lines, the three resolution paths, and the two reconciliation endpoints)

**Tests**
- `backend/src/routes/banking.test.js` — 12 tests covering RECON-1 through RECON-8, the multipart
  upload guards, and the reconciliation summary report

**Database migrations** (`backend/prisma/migrations/`)
- `20260816090748_day5_banking_reconciliation/` — the four tables, three enums, and two hand-written
  `CHECK` constraints
- `20260816090948_enable_pg_trgm/` — enables PostgreSQL's trigram similarity extension
- `20260816093247_day5_bank_adjustment_doctype/` — adds the `BANK_ADJUSTMENT` document type and the
  `debit`/`credit` columns on `DocumentLine`

### Everything modified

- `backend/prisma/schema.prisma` — four new models, three new enums, the `BANK_ADJUSTMENT` doc type,
  two new `DocumentLine` columns, and back-relations on `Organization`, `Account`, and `JournalLine`
- `backend/src/lib/accounting/post-document.js` — generalised from invoice-only to dispatching by
  document type; gained the optional-transaction parameter
- `backend/src/lib/accounting/posting-rules.js` — new `bankAdjustment` rule
- `backend/src/lib/accounting/receipt-service.js` — the `journalEntryId` link fix (Problem 8)
- `backend/src/lib/accounting/reverse-entry.js` — the RECON-8 guard and the `bankAdjustment` cascade
- `backend/src/routes/reports.js` — three new endpoints and one shared helper
- `backend/src/routes/reports.test.js` — two new tests
- `backend/src/app.js` — mounts the banking router; JSON body cap set explicitly to 1 MB
- `backend/src/test/helpers.js` — the four new tables added to the `TRUNCATE` list
- `backend/package.json` / `package-lock.json` — added `multer`

### Everything configured

- `multer` installed as a backend dependency (multipart file upload handling)
- The `pg_trgm` PostgreSQL extension enabled in the database
- Three migrations created and applied
- The Prisma client regenerated twice (see section 7.2 — forgetting this cost real debugging time)

---

## 2. How it relates to the 7-day plan

This session is **Day 5 — Banking, reconciliation, reports** (`ledgerline-7-day-plan_1.md`, line
1499). Day 5 is also the plan's **feature freeze**: after 20:00 on Day 5, no new features, only
hardening, tests, deployment, and documentation.

### The plan's Day 5 goals for Developer A (backend)

> - CSV parser + normaliser + column mapping + all-or-nothing validation.
> - Statement import with `file_sha256` idempotency and per-row `row_hash`.
> - **The matching engine**: candidate query, four-pass scoring, greedy bipartite assignment, thresholds.
> - Endpoints: import, `GET /statements/:id/lines`, `POST /lines/:id/match`, `POST /lines/:id/create-entry`, `POST /lines/:id/ignore`, `POST /reconciliations`, `POST /reconciliations/:id/complete`.
> - `GET /reports/profit-loss`, `GET /reports/balance-sheet` (with computed current-year earnings), `GET /reports/bank-reconciliation`.
> - Tests: RECON-1..8.

### The plan's Day 5 goals for Developer B (frontend)

> - Banking module: bank account list, statement upload with drag-drop and a column-mapping step.
> - **Reconciliation workspace — the visual centrepiece.** Two columns: statement lines left, ledger movements right. Auto-matched pairs joined by a connector and shown collapsed; suggestions with a confidence badge and Confirm/Reject; unmatched lines with three action buttons. A sticky footer showing *Book / Bank / Difference*, with the difference in red until it hits zero, then green.
> - P&L, Balance Sheet, Bank Reconciliation Summary screens.
> - Report export to CSV (with the formula-injection escape).

### Plan → What we built → Why it matters

| Plan objective | What we built | Why it matters |
|---|---|---|
| CSV parser + normaliser + column mapping + all-or-nothing validation | `lib/banking/csv.js` | Real bank CSVs are messy — BOM bytes, CRLF endings, `1,25,000.00` lakh grouping, two date formats. The plan lists every one of these as an edge case to name in the README. |
| Statement import with `file_sha256` idempotency | `lib/banking/statement-import-service.js` | Re-uploading the same file returns the original statement and imports nothing. Idempotent *by construction*, via a `UNIQUE(bankAccountId, fileSha256)` index — not by remembering to check. |
| Per-row `row_hash` including the row index | `csv.js` → `rowHash()` | Two identical NPR 5,000 transfers on the same day are legitimate and must both survive. Including the row index in the hash is what makes that work. |
| Four-pass scoring with a hard amount gate | `lib/banking/matching-engine.js` → `scoreCandidate()` | Being strict on amount is the correct call: a system that "helpfully" matches 100,000 against 100,500 hides a 500 error forever. |
| `pg_trgm` party-name similarity | The `similarity()` call in the candidate query, plus the `enable_pg_trgm` migration | Lets `"IPS/EVEREST CAFE PVT LTD"` suggest `"Everest Cafe Pvt. Ltd."` — enough for a suggestion, not enough to auto-confirm. |
| Greedy bipartite assignment | `matchStatementLines()` | Makes the pairing one-to-one. Also the place to explain why we did *not* use the Hungarian algorithm. |
| Thresholds (≥0.90 auto, 0.45–0.90 suggest) | `AUTO_MATCH_THRESHOLD`, `SUGGEST_THRESHOLD` | Turns a score into three distinct behaviours, with a human in the loop for everything uncertain. |
| The seven reconciliation endpoints | `routes/banking.js` | Exactly the list the plan names, plus `GET`/`POST /bank-accounts` so a bank account can exist to import against. |
| `GET /reports/profit-loss` | `routes/reports.js` | A *period* report (movements between two dates) — the distinction from the balance sheet is one a knowledgeable reviewer specifically checks. |
| `GET /reports/balance-sheet` with computed current-year earnings | `routes/reports.js` | The single most common mistake in home-grown accounting systems. Implemented correctly and explained in section 4.6. |
| `GET /reports/bank-reconciliation` | `routes/reports.js` | The §8.6 summary — book vs bank vs difference plus the matched/unmatched breakdown. |
| Tests RECON-1..8 | `routes/banking.test.js` | All eight, plus four extra. RECON-7 proves the control at both the service layer and the database layer. |

### What is completed

Every Developer A item on the Day 5 list is done and verified. Specifically:

- All nine banking endpoints exist and are covered by tests.
- All three report endpoints exist; two are covered by new tests, the third by a test in
  `banking.test.js`.
- RECON-1 through RECON-8 all pass.
- Backend suite: **122 tests, all passing.** Lint clean.
- The security grep the plan's §9 asks for is clean: `grep -rn "queryRawUnsafe" backend/src` has **zero
  hits** outside Prisma's own generated code. Every raw query added this session uses tagged-template
  `$queryRaw`, which parameterises its inputs. (`$executeRawUnsafe` does appear, but only in test files,
  in `TRUNCATE` statements that interpolate nothing.)

### What is incomplete, and why

**The entire Day 5 frontend.** The banking module, the reconciliation workspace, the three report
screens, and CSV export were not started. This is the same split as Day 4 — the sessions have been
backend-only. This is the largest outstanding item in the project, and it matters more than usual
because the plan calls the reconciliation workspace "the visual centrepiece" and the 20:00
checkpoint is explicitly a *browser* test:

> the whole story must run end to end in the browser, unassisted: customer → invoice → post →
> journal → receipt → allocation → CSV → match → create-from-line → reconcile → TB → P&L → BS →
> aging.

The backend half of that chain is complete and tested. The browser half does not exist yet.

**Other deliberate omissions:**

- **The three CSV fixture files** (clean, messy dates, duplicate amounts) that the plan asks be
  shipped. The test suite generates its CSV content inline instead. Fixtures are more valuable once
  the frontend needs something to drag and drop.
- **The golden end-to-end test** (`invoice → payment → reconciliation → reports stay consistent`,
  asserted to the paisa). The plan schedules it for Day 6, line 1523.
- **Partial-payment subset matching** (pass 4 — finding a *pair* of unmatched receipts summing to
  one statement amount). The plan itself marks this "optional, if time" and warns that beyond pairs
  it becomes subset-sum. Not built.
- **Overlapping-statement-period warning.** The plan mentions warning if a new statement's period
  overlaps an existing one. Row-level `row_hash` dedupe within a statement is implemented; the
  cross-statement overlap warning is not.
- **A `GET /reconciliations` list endpoint.** You can create and complete a reconciliation but not
  list past ones. The frontend will need this; it is a five-line addition when it does.

### The two shortcuts that were built and then removed

This is worth recording precisely, because both were reasonable and both were ultimately rejected.

The session first shipped two simplifications, each marked with a code comment explaining itself:

1. **The CSV arrived as a JSON string field** (`csvContent`) rather than a real multipart file
   upload, because no multipart middleware existed in the repository yet.
2. **"Create entry from line" posted through `postManualEntry()`** rather than `postDocument()`,
   because `postDocument()` only had posting rules wired for `INVOICE`, and adding a document type
   meant a schema change.

Both worked, both were tested, and the functional outcome was identical — the CSV still imported
idempotently, the bank charge still posted to the real ledger and auto-matched.

You then said: *do everything exactly like the plan, no cuttings.* Both were rebuilt:

| Shortcut | What replaced it | What that cost | What it bought |
|---|---|---|---|
| `csvContent` JSON string | Real `multipart/form-data` upload via `multer`, memory storage, mimetype allowlist, 2 MB cap, plus optional `Idempotency-Key` | One new dependency, ~40 lines of route code, two new tests | The plan's literal step 1 ("mimetype allowlist, ≤ 2 MB"), a real `2 MB` file cap independent of the JSON body cap, and the `express.json()` limit could go back to the spec's 1 MB |
| `postManualEntry()` | `postDocument()` with a new `BANK_ADJUSTMENT` document type | A migration, a new posting rule, a `postDocument` refactor, a new `reverseEntry` cascade branch | The plan's literal claim that create-from-line goes through "*the same engine*". A bank adjustment is now a first-class `Document` with a `BADJ-2082-0001` number, visible in document listings, reversible through the standard path |

**The lesson worth keeping.** The shortcut version was defensible and I would defend it again on a
tight timeline. But "the same engine" in the plan was not decoration — routing through
`postDocument()` is what gives a bank adjustment a document number, a document row, and the standard
reversal cascade. The simplification quietly gave up all three. When a specification says two things
must share a code path, the sharing is usually the point.

### How this prepares the next days

**Day 6 (hardening, tests, audit)** inherits a backend where every endpoint the demo needs exists.
The specific Day 6 items that now have something concrete to work with:

- The **golden E2E test** can now be written, because every step in its chain exists.
- **Property tests INV-2 and INV-4** and the remaining isolation/permission cases have a stable API
  surface to test against.
- **Swagger UI via `zod-to-openapi`** — every new endpoint in this session already validates with a
  Zod schema, so they are ready to be reflected into OpenAPI.
- **Postgres RLS** as a second isolation layer will need to cover the four new tables. All four carry
  their own `organizationId` column, so they fit the existing pattern exactly — unlike
  `AccountingPeriod`, which does not.

**Day 7 (deployment and demo)** — the `pg_trgm` extension is now a deployment requirement. `CREATE
EXTENSION` needs database privileges that a restricted production role may not have. On Neon this
works, but it is worth checking early rather than discovering it during the Day 7 deploy.

**One constraint to carry forward.** The tenant extension (`backend/src/db/tenant-extension.js`,
built on Day 2) automatically injects `organizationId` into queries for models that have that
column. All four new tables have it. But note that `routes/banking.js` still explicitly filters by
`organizationId` in several places — e.g. `prisma.bankStatement.findFirst({ where: { id, organizationId: req.organizationId } })`.
That is belt-and-braces, not redundancy to remove: the explicit filter is what turns a cross-tenant
ID into a `404` at the route layer, which is the behaviour the plan's security section requires
(revealing that a record exists is itself a leak).

---

## 3. Files created and modified

### 3.1 Database schema and migrations

---

**File:** `backend/prisma/schema.prisma`

**Status:** Modified

**Purpose:** This file is the single description of what the database looks like. Prisma reads it and
generates two things: the SQL migration files that change the real database, and a JavaScript client
object that knows about every table and column.

**Why does this file exist?** Without it you would write SQL by hand in one place and JavaScript
query code in another, and nothing would keep them agreeing. Here, one description drives both.

**How does it connect to other files?** `npx prisma migrate dev` reads it and writes SQL into
`backend/prisma/migrations/`. `npx prisma generate` reads it and writes the client into
`backend/src/generated/prisma/`, which `backend/src/db/client.js` imports and every service file
uses.

Here are the additions, in the order they appear.

#### The three new enums

```prisma
enum BankStatementLineStatus {
  UNMATCHED
  SUGGESTED
  MATCHED
  RECONCILED
  IGNORED
}

enum MatchedBy {
  AUTO
  MANUAL
}

enum ReconciliationStatus {
  IN_PROGRESS
  COMPLETED
}
```

**What is an enum?** Short for *enumeration*. It is a column whose value must be one of a fixed,
named list. `status` on a statement line can be `UNMATCHED` or `MATCHED` or three others — it can
never be `"maybe"`, `"Unmatched"`, or a typo like `"UNMACHED"`, because PostgreSQL refuses to store
anything not in the list.

**Why an enum instead of a plain text column?** Three reasons:

1. **The database enforces it.** A text column accepts any string. Two developers spelling a status
   differently produces rows that never match a `WHERE` clause, and nothing warns you.
2. **It documents itself.** Reading the schema tells you every state a statement line can be in.
3. **It is compact.** PostgreSQL stores an enum as a small integer internally.

**Why these five statuses specifically?** Each represents a genuinely different situation:

| Status | Meaning | How it got here |
|---|---|---|
| `UNMATCHED` | No ledger line explains this | Import found no candidate, or a reversal reset it |
| `SUGGESTED` | We think we know, but we are not sure enough to assert it | Score between 0.45 and 0.90, or a tie |
| `MATCHED` | Paired with a ledger line, but the reconciliation is still open | Score ≥ 0.90, or a human confirmed it |
| `RECONCILED` | Paired *and* locked — the reconciliation is completed | `completeReconciliation()` flipped it |
| `IGNORED` | Deliberately excluded, with a written reason | A human called the ignore endpoint |

The distinction between `MATCHED` and `RECONCILED` is the one that matters most: it is what makes
RECON-8 possible. A matched line can be un-matched by a reversal; a reconciled line cannot, because
its reconciliation has been certified.

---

#### `BankAccount`

```prisma
model BankAccount {
  id               String  @id @default(uuid())
  organizationId   String
  accountId        String
  bankName         String
  accountNoMasked  String
  openingBalance   Decimal @default(0) @db.Decimal(18, 4)
  isActive         Boolean @default(true)

  organization   Organization    @relation(fields: [organizationId], references: [id], onDelete: Restrict)
  account        Account         @relation(fields: [accountId], references: [id], onDelete: Restrict)
  statements     BankStatement[]
  statementLines BankStatementLine[]
  reconciliations Reconciliation[]

  @@unique([organizationId, accountId])
}
```

**Reading this from zero.**

`id String @id @default(uuid())` — every table needs a way to identify one row uniquely. `@id` marks
this as the *primary key*. `@default(uuid())` means if you do not supply one, generate a random
UUID (a 36-character string like `f47ac10b-58cc-4372-a567-0e02b2c3d479`). UUIDs rather than
auto-incrementing numbers, so IDs carry no information — an attacker cannot tell how many bank
accounts exist by looking at one ID.

`organizationId String` — the multi-tenancy column. Every tenant-owned table in LedgerLine carries
it, and the Prisma tenant extension built on Day 2 automatically adds `WHERE organizationId = ...`
to queries on such tables.

`accountId String` — this is the interesting one. **A `BankAccount` is not the same thing as an
`Account`.** `Account` is the *general ledger* account — the accounting concept, code `1020`, named
"Bank — Nabil Bank Current", which holds a balance derived from journal lines. `BankAccount` is the
*real-world* thing — Nabil Bank, account number ending 4821. This column points one at the other.

Why separate them? Because they carry different information for different purposes. The GL account
is where accounting happens. The bank account is where reconciliation happens. Keeping the bank's
name and masked number out of the chart of accounts keeps the chart clean.

`accountNoMasked String` — note the name. We store `****4821`, not the full account number. A full
bank account number is sensitive data with no operational use here: the system never initiates a
transfer, so it never needs the real number. Storing only the masked form means a database leak
does not leak account numbers. This is a small detail that costs nothing and is exactly the kind of
instinct a reviewer notices.

`Decimal @db.Decimal(18, 4)` — money is **never** a floating-point number. `18, 4` means up to 18
total digits with 4 after the decimal point. Section 4 of the Day 4 document covers why in depth; the
short version is that `0.1 + 0.2` in floating-point arithmetic equals `0.30000000000000004`, and an
accounting system that drifts by fractions of a paisa across thousands of entries produces a trial
balance that does not foot.

`onDelete: Restrict` — if somebody tries to delete an `Organization` that still has a `BankAccount`,
the database refuses. The alternative, `Cascade`, would silently delete the bank account too.
`Restrict` is the correct default for financial data: deletion should be hard and explicit.

`statements BankStatement[]` — this is a *back-relation*. It does not create a column. It tells
Prisma "you can navigate from a bank account to all of its statements", which enables
`include: { statements: true }` in a query. Prisma requires both sides of a relation to be declared —
forgetting one is what caused the first error in section 7.1.

`@@unique([organizationId, accountId])` — one bank account per GL account per organisation. Without
this, you could create two `BankAccount` rows both pointing at GL account `1020`, and the matching
engine would have no way to know which statement belongs to which.

---

#### `BankStatement`

```prisma
model BankStatement {
  id             String   @id @default(uuid())
  organizationId String
  bankAccountId  String
  fileName       String
  fileSha256     String
  periodStart    DateTime @db.Date
  periodEnd      DateTime @db.Date
  openingBalance Decimal  @db.Decimal(18, 4)
  closingBalance Decimal  @db.Decimal(18, 4)
  lineCount      Int
  importedById   String?
  importedAt     DateTime @default(now())

  organization Organization        @relation(fields: [organizationId], references: [id], onDelete: Restrict)
  bankAccount  BankAccount         @relation(fields: [bankAccountId], references: [id], onDelete: Restrict)
  lines        BankStatementLine[]
  reconciliations Reconciliation[]

  @@unique([bankAccountId, fileSha256])
}
```

**The line that does the most work here is the last one.**

`@@unique([bankAccountId, fileSha256])` — this single constraint is what makes re-importing a file
idempotent, and it is worth understanding exactly why.

**What is a hash?** A hash function takes any input — a word, a file, a gigabyte of video — and
produces a fixed-length string of characters. SHA-256 always produces 64 hexadecimal characters. Two
properties make it useful:

1. **Deterministic.** The same input always produces the same output. Always.
2. **Effectively collision-free.** Two different inputs producing the same SHA-256 output is
   something nobody has ever managed to engineer deliberately, let alone by accident.

So `fileSha256` is a fingerprint of the uploaded file's exact bytes. Change one character anywhere
in the CSV and the fingerprint is completely different.

**Why that makes re-upload safe:** the unique constraint says "for a given bank account, a given
file fingerprint may appear at most once." If the user uploads the same file twice — double-clicked
the button, or came back tomorrow unsure whether it worked — the second attempt finds the existing
row and returns it, importing nothing.

Notice the phrasing: idempotent **by construction**. The import service does check for an existing
statement before parsing, but even if that check were removed or had a bug, the database itself
would refuse the duplicate row. The correctness does not depend on remembering to check.

`@db.Date` versus plain `DateTime` — `periodStart` and `periodEnd` are `@db.Date`, which stores only
a calendar date with no time-of-day. `importedAt` is a full `DateTime`. That difference is
deliberate: a bank statement covers *1 February to 28 February*, not "1 February at 00:00:00.000
UTC". Storing a timestamp for a date invites timezone bugs where a date shifts by one day depending
on where the server is running.

`importedById String?` — the `?` makes it nullable (optional). It records which user performed the
import. Nullable because a future seed script or automated import might have no human behind it.

---

#### `BankStatementLine`

```prisma
// bankAccountId is denormalised from statement.bankAccountId so the matching
// engine's candidate pool and the reconciliation workspace can filter/index
// by (organizationId, bankAccountId, status) without a join (§7 index list).
model BankStatementLine {
  id                   String                  @id @default(uuid())
  organizationId       String
  statementId          String
  bankAccountId        String
  txnDate              DateTime                @db.Date
  description          String
  reference             String?
  debit                Decimal                 @default(0) @db.Decimal(18, 4)
  credit                Decimal                 @default(0) @db.Decimal(18, 4)
  runningBalance        Decimal?                @db.Decimal(18, 4)
  rowHash               String
  status                BankStatementLineStatus @default(UNMATCHED)
  matchedJournalLineId   String?                 @unique
  matchConfidence        Decimal?                @db.Decimal(4, 3)
  matchedBy              MatchedBy?
  matchedAt               DateTime?
  ignoreReason           String?

  organization Organization  @relation(fields: [organizationId], references: [id], onDelete: Restrict)
  statement    BankStatement @relation(fields: [statementId], references: [id], onDelete: Restrict)
  bankAccount  BankAccount   @relation(fields: [bankAccountId], references: [id], onDelete: Restrict)
  matchedJournalLine JournalLine? @relation(fields: [matchedJournalLineId], references: [id], onDelete: Restrict)

  @@unique([statementId, rowHash])
  @@index([organizationId, bankAccountId, status])
}
```

This is the most important table in the session. Four things deserve close attention.

**1. `bankAccountId` is denormalised — and that is deliberate.**

**What does denormalised mean?** In database design, *normalisation* means storing each fact exactly
once. By that rule `bankAccountId` should not be here: a line belongs to a statement, and the
statement already knows its bank account. Storing it again duplicates a fact.

*Denormalisation* is deliberately breaking that rule for performance. Without this column, finding
"all unmatched lines for bank account X" requires joining `BankStatementLine` to `BankStatement`.
With it, one index — `@@index([organizationId, bankAccountId, status])` — answers the query directly.

**What is an index?** A separate sorted structure the database maintains so it can find rows without
scanning the whole table. Like a book's index: without it, finding every mention of "reconciliation"
means reading every page.

The cost of denormalising is that the duplicated fact could drift out of sync. Here it cannot: the
line's `bankAccountId` is written once at import, from the statement's own value, and nothing ever
updates it.

**2. `matchedJournalLineId String? @unique` — the one-to-one guarantee, in the database.**

Section 1's Problem 3 explained that assignment must be one-to-one, and that the greedy algorithm
enforces it in application code. This `@unique` enforces the *other half* in the database: no two
statement lines may point at the same journal line, ever, by any code path.

This matters because the greedy matcher is not the only thing that writes this column — the manual
match endpoint and the create-entry endpoint do too. A user could try to manually match a journal
line that the auto-matcher already claimed. Without `@unique` that would silently produce a
double-match. With it, PostgreSQL rejects the write and `manualMatchLine()` catches the error code
and returns a clean `409 journal_line_already_matched`.

**3. `matchConfidence Decimal? @db.Decimal(4, 3)`**

Four total digits, three after the decimal point — so values from `0.000` to `9.999`, which
comfortably covers a score in `[0, 1]` with three decimal places of precision. `0.847` is
representable exactly; that precision is what lets the UI show a meaningful confidence badge.

**4. `@@unique([statementId, rowHash])` and why the row index is in the hash.**

Within one statement, a given row fingerprint may appear only once. The fingerprint is computed by
`rowHash()` in `csv.js`:

```js
export function rowHash({ txnDate, debit, credit, description, runningBalance, rowIndex }) {
  return createHash('sha256')
    .update(`${txnDate}|${debit}|${credit}|${description}|${runningBalance ?? ''}|${rowIndex}`, 'utf8')
    .digest('hex');
}
```

Look at what goes into it: date, debit, credit, description, running balance — **and `rowIndex`**.

Why include the row's position? Because of the plan's edge case: two identical NPR 5,000 transfers
on the same day are *legitimate*. If the hash covered only the visible data, both rows would produce
the same fingerprint, the unique constraint would reject the second, and the import would silently
lose a real transaction. Including the row index makes row 3 and row 7 distinct even when every other
field is identical.

But then what does the constraint still protect against? Genuine double-processing of the *same*
row — the same file's row 3 attempted twice.

---

#### `Reconciliation`

```prisma
model Reconciliation {
  id                String               @id @default(uuid())
  organizationId    String
  bankAccountId     String
  asOfDate          DateTime             @db.Date
  statementId       String
  bookBalance       Decimal              @db.Decimal(18, 4)
  bankBalance       Decimal              @db.Decimal(18, 4)
  difference        Decimal              @db.Decimal(18, 4)
  unreconciledCount Int
  status            ReconciliationStatus @default(IN_PROGRESS)
  completedById     String?
  completedAt       DateTime?

  organization Organization  @relation(fields: [organizationId], references: [id], onDelete: Restrict)
  bankAccount  BankAccount   @relation(fields: [bankAccountId], references: [id], onDelete: Restrict)
  statement    BankStatement @relation(fields: [statementId], references: [id], onDelete: Restrict)
}
```

A `Reconciliation` row is a **certificate**: "as at this date, for this bank account, the books said
X, the bank said Y, they differed by Z, and N lines were unresolved."

Note it stores `bookBalance` and `difference` even though both are derivable by recomputing from
journal lines. That is deliberate: the row records what was true *at the moment it was certified*.
If someone later backdates an entry into that period, recomputing would give a different answer —
but the certificate should still say what was certified. This is a snapshot, not a live view. The
live view is `GET /reports/bank-reconciliation`, which recomputes every time.

The `CHECK` constraint that makes `status = COMPLETED` meaningful cannot be expressed in
`schema.prisma` — Prisma has no syntax for it — so it is hand-written into the migration.

---

#### The two new `DocumentLine` columns

```prisma
  // Only BANK_ADJUSTMENT documents use these — a plain debit/credit journal
  // line has no quantity/rate/tax shape. Nullable so every sale-line-shaped
  // doc type (invoice, credit note) is untouched; quantity/unitPrice/
  // taxableAmount/lineTotal above still get harmless placeholder values for
  // those rows since this table's NOT NULL columns aren't loosened.
  debit         Decimal? @db.Decimal(18, 4)
  credit        Decimal? @db.Decimal(18, 4)
```

**Why were these needed?** `DocumentLine` was designed for sale lines: quantity, unit price, discount
percentage, tax code, line total. That shape describes "15 backpacks at 8,000 each with 13% VAT"
perfectly.

A bank charge has none of that shape. It is simply "credit the bank account 1,130, debit bank
charges 1,130." There is no quantity, no rate, no tax.

**Why nullable, rather than restructuring the table?** Because making them required would break
every existing invoice line, and restructuring `DocumentLine` into a polymorphic shape would touch
Day 3 and Day 4 code that currently works and is tested. Two nullable columns used by exactly one
document type is the smaller change.

**The honest trade-off:** the bank-adjustment rows still fill `quantity`, `unitPrice`,
`taxableAmount`, and `lineTotal` with placeholder values, because those columns are `NOT NULL`. That
is slightly untidy — the row carries `quantity: 1` which means nothing. The alternative (making four
existing columns nullable) would weaken constraints that correctly protect invoice lines. Storing a
meaningless-but-harmless `1` is the lesser evil, and the comment in the schema says so out loud.

---

**File:** `backend/prisma/migrations/20260816090748_day5_banking_reconciliation/migration.sql`

**Status:** Created

**Purpose:** The actual SQL that creates the four tables in PostgreSQL.

**Why does this file exist?** `schema.prisma` describes the desired state. A *migration* is the set
of instructions to get from the current state to that state. Migrations are files, committed to git,
applied in order — so any developer, and production, can arrive at exactly the same database
structure by running them in sequence.

**How was it made?** `npx prisma migrate dev --name day5_banking_reconciliation --create-only`.
The `--create-only` flag generates the SQL *without* applying it, which leaves room to hand-edit
before running it. That mattered here, because two constraints had to be added by hand.

Prisma generated the `CREATE TABLE`, `CREATE INDEX`, and `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN
KEY` statements. Appended by hand:

```sql
-- Prisma can't express a CHECK constraint in schema.prisma — hand-written,
-- same convention as Day 1/4's balance/sign/amount checks.
-- A statement line is a bank debit or a bank credit, never both (§7 bank_statement_lines).
ALTER TABLE "BankStatementLine" ADD CONSTRAINT "BankStatementLine_debit_credit_check" CHECK (NOT ("debit" > 0 AND "credit" > 0));

-- The internal control expressed in DDL (§7): you cannot mark a reconciliation
-- complete while book and bank disagree, even via a direct insert/update.
ALTER TABLE "Reconciliation" ADD CONSTRAINT "Reconciliation_difference_zero_check" CHECK ("status" <> 'COMPLETED' OR "difference" = 0);
```

**What is a `CHECK` constraint?** A rule attached to a table that every row must satisfy. PostgreSQL
evaluates it on every insert and update and rejects the write if it is false. Unlike application
code, there is no way around it — not from a different service, not from a database console, not
from a migration script.

**What is DDL?** *Data Definition Language* — the subset of SQL that defines structure (`CREATE
TABLE`, `ALTER TABLE`, `ADD CONSTRAINT`), as opposed to DML (*Data Manipulation Language*: `SELECT`,
`INSERT`, `UPDATE`).

**Reading the first constraint:**

```sql
CHECK (NOT ("debit" > 0 AND "credit" > 0))
```

Read it aloud: "it is not the case that both debit and credit are positive." A single line on a bank
statement is money in *or* money out. Never both. A row with both filled in means the import code
has a bug, and the database will not store it.

**Reading the second constraint — this is the important one:**

```sql
CHECK ("status" <> 'COMPLETED' OR "difference" = 0)
```

`<>` is SQL's "not equal to". Read it as: "either the status is not COMPLETED, or the difference is
zero." Which is exactly the same as saying: **if the status is COMPLETED then the difference must be
zero.**

**Why is this expressed as an `OR` rather than an `IF`?** Because SQL `CHECK` constraints are boolean
expressions, not statements. The logical identity `(A → B) ≡ (¬A ∨ B)` lets any implication be
written as an `OR`. It reads slightly awkwardly but means precisely "if completed, then balanced."

This one line is the internal control. Everything else — the service-layer recompute, the 422 error,
the test — is convenience and good error messages. This is the part that cannot be bypassed.

---

**File:** `backend/prisma/migrations/20260816090948_enable_pg_trgm/migration.sql`

**Status:** Created

**Purpose:** Turns on a PostgreSQL extension that the matching engine needs.

```sql
-- pg_trgm powers the matching engine's party-name similarity pass (§7).
-- No schema.prisma equivalent — Prisma has no extension declaration for this.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

**What is a PostgreSQL extension?** PostgreSQL ships with a core set of features and a library of
optional add-ons. An extension adds functions, data types, or index methods. They are installed per
database with `CREATE EXTENSION`.

**What does `pg_trgm` do?** It provides *trigram* similarity. A trigram is a group of three
consecutive characters. The word `"cafe"` breaks into the trigrams `"  c"`, `" ca"`, `"caf"`,
`"afe"`, `"fe "`.

`pg_trgm` gives you a `similarity(a, b)` function that returns a number between 0 and 1: it breaks
both strings into trigrams and measures how much the two sets overlap.

**Why is that useful here?** Because a bank statement description is never a clean copy of a
customer name. The bank writes `"IPS/EVEREST CAFE PVT LTD"`; your customer record says
`"Everest Cafe Pvt. Ltd."`. They are not equal — different punctuation, different case, an extra
prefix. But they share most of their trigrams, so `similarity()` scores them around 0.55.

That number is exactly right for the job: high enough to say "this is probably the customer," low
enough that it never pushes a match over the 0.90 auto-confirm line on its own.

**Why `IF NOT EXISTS`?** So running the migration against a database that already has the extension
does not fail. Migrations must be safe to apply to any database that has not yet applied them,
including ones where a developer enabled the extension by hand.

**How the migration was made:** `npx prisma migrate dev --name enable_pg_trgm --create-only`
generated an *empty* migration (because `schema.prisma` had not changed — Prisma has no way to
express an extension), and the `CREATE EXTENSION` line was written into it by hand.

**A deployment note.** This is now a production requirement. `CREATE EXTENSION` requires privileges
that some managed PostgreSQL providers restrict. Worth verifying on Day 7 before the deploy rather
than during it.

---

**File:** `backend/prisma/migrations/20260816093247_day5_bank_adjustment_doctype/migration.sql`

**Status:** Created

**Purpose:** Adds the `BANK_ADJUSTMENT` document type and the two `DocumentLine` columns.

```sql
-- AlterEnum
ALTER TYPE "DocType" ADD VALUE 'BANK_ADJUSTMENT';

-- AlterTable
ALTER TABLE "DocumentLine" ADD COLUMN     "credit" DECIMAL(18,4),
ADD COLUMN     "debit" DECIMAL(18,4);
```

This migration exists only because of the second "no cuttings" rebuild described in section 2.7. It
is what allows a bank charge to become a real `Document` and flow through `postDocument()`.

`ALTER TYPE ... ADD VALUE` extends an existing enum. Note that PostgreSQL only allows *adding*
values to an enum easily — removing or reordering them is much harder, which is a good reason to
think before naming one.

---

**File:** `backend/src/test/helpers.js`

**Status:** Modified

**Purpose:** Shared setup used by every integration test file.

The only change is one line added to the `TRUNCATE` list:

```js
export async function resetDb() {
  await prisma.$executeRawUnsafe(`
    TRUNCATE
      "Reconciliation", "BankStatementLine", "BankStatement", "BankAccount",
      "PaymentAllocation", "DocumentLine", "Document", "DocumentSeries", "EntrySeries",
      "JournalLine", "JournalEntry", "Account", "TaxCode", "Party",
      "AccountingPeriod", "FiscalYear", "Membership", "RolePermission",
      "Role", "Permission", "Organization", "RefreshToken", "User",
      "AuditLog", "IdempotencyKey"
    CASCADE
  `);
}
```

**What is `TRUNCATE`?** SQL for "delete every row in these tables, fast." Faster than `DELETE FROM`
because it does not process rows individually.

**Why `TRUNCATE` and not `DELETE`?** The comment above the function in the file explains it: Day 1
installed an immutability trigger that blocks row-level `DELETE` on `JournalEntry` and
`JournalLine`. That trigger fires per row. `TRUNCATE` does not fire row-level triggers, so it can
clear the table where `DELETE` would be refused.

**Why were the new tables added at the front of the list?** Order in a `TRUNCATE ... CASCADE` does
not strictly matter, but listing children before parents matches the existing convention in this
file and reads more clearly.

**Why does this need updating at all?** Because if `BankStatementLine` rows survived between test
files, the matching engine's candidate query — which excludes journal lines already claimed by *any*
statement line, across the whole table — would behave differently depending on what ran before it.
Tests would pass alone and fail in a suite.

---

### 3.2 The CSV layer

---

**File:** `backend/src/lib/banking/csv.js`

**Status:** Created

**Purpose:** Turns the raw text of an uploaded CSV file into a clean, validated list of JavaScript
objects — or refuses the whole file with a list of per-row errors. It also computes the two
fingerprints (file-level and row-level) that make importing idempotent.

**Why does this file exist?** Because parsing a bank CSV is genuinely fiddly, and every piece of that
fiddliness deserves to live in one place with tests around it, rather than being smeared through the
import service. It has no database access and no knowledge of Prisma — it is pure text-in,
objects-out, which makes it the easiest file in the session to reason about.

**How does it connect to other files?** `statement-import-service.js` imports
`fileSha256`, `parseAndValidateStatement`, and `rowHash`. `routes/banking.js` imports `fileSha256`
(to build the idempotency request fingerprint). It imports Zod for validation and `businessRule`
from the shared errors module.

Here is the file, explained in four parts.

#### Part 1 — the imports and the hash

```js
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { businessRule } from '../accounting/errors.js';

export const MAX_STATEMENT_ROWS = 5000;

// Only these two survive a bank statement in practice (§7 edge cases table:
// "DD/MM/YYYY vs YYYY-MM-DD"). Anything else is rejected rather than guessed
// — an ambiguous date silently parsed wrong is worse than an upload that fails.
const DATE_FORMATS = ['YYYY-MM-DD', 'DD/MM/YYYY'];

export function fileSha256(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
```

**`import { createHash } from 'node:crypto';`**

The `node:` prefix means this module is built into Node.js itself — nothing was installed for it.
The prefix makes that explicit so a reader never wonders whether `crypto` is ours, a dependency, or
Node's.

**`export const MAX_STATEMENT_ROWS = 5000;`**

`export` makes it importable elsewhere; `const` means it cannot be reassigned. The plan specifies a
5,000-row cap. **Why cap it at all?** Because the matching engine runs one database query *per
statement line*. A 50,000-row file would issue 50,000 queries inside a single transaction, holding
locks for minutes. The cap turns a potential outage into a clear error message.

**`const DATE_FORMATS = [...]` — and the reasoning in the comment.**

This is a design decision worth understanding. `05/03/2026` is ambiguous: 5 March in most of the
world, 3 May in the United States. A parser that guesses will be right most of the time and
catastrophically wrong occasionally — and it will never tell you which.

So this file **refuses to guess**. The caller must state which format the file uses, and only these
two are accepted. An upload that fails with "unsupported date format" is a minor annoyance; a
statement silently imported with March and May transposed is a bug you might never find.

**`fileSha256` — method chaining, explained.**

```js
createHash('sha256').update(content, 'utf8').digest('hex')
```

Each call returns an object that the next call is made on. Written out step by step:

1. `createHash('sha256')` — creates a hash calculator using the SHA-256 algorithm. Returns a Hash
   object.
2. `.update(content, 'utf8')` — feeds the file's text into it. `'utf8'` says how to turn the
   characters into bytes. Returns the same Hash object, which is what makes chaining possible.
3. `.digest('hex')` — finishes the calculation and returns the result as a hexadecimal string: 64
   characters, each one of `0-9a-f`.

- **Data in:** the entire CSV file as a string.
- **Data out:** a 64-character fingerprint.
- **Who calls it:** `statement-import-service.js` (to check for a duplicate upload) and
  `routes/banking.js` (to build the idempotency request hash).

#### Part 2 — the CSV parser

```js
// RFC4180-ish: quoted fields, "" escapes a literal quote, commas inside
// quotes don't split. Strips a leading BOM and normalises CRLF, and drops
// wholly-blank trailing rows (§7 edge cases: BOM, CRLF, trailing blank rows).
export function parseCsvText(text) {
  const noBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const clean = noBom.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (inQuotes) {
      if (c === '"') {
        if (clean[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}
```

**Why write a CSV parser by hand instead of installing one?**

The honest answer: because `text.split(',')` is wrong and the correct version is about thirty lines.
Consider this legitimate CSV row:

```
2026-02-05,"NEFT, HIMALAYAN TREK, INV-2082-0001",NEFT8834512,,100000.00
```

The description contains commas. Splitting on every comma produces six fields instead of five and
shifts every column after it. Quoted fields are not an edge case — bank descriptions contain commas
routinely.

A library would also work. The reason for hand-writing here is that the requirement is small and
fully specified, and the alternative is a dependency whose behaviour you would still have to verify
against these exact edge cases.

**The BOM line, explained from zero.**

```js
const noBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
```

**What is a BOM?** A *byte order mark* — an invisible character (`U+FEFF`) that some programs,
notably Microsoft Excel, write at the very start of a file to signal its text encoding.

**Why does it matter?** It is invisible when you open the file, but it is a real character in the
string. If the first header is `Date`, the BOM makes it `﻿Date`. Then `header.indexOf('Date')`
returns `-1` — the column "does not exist" — and the import fails with a baffling error about a
column that is plainly right there in the file.

**Reading the syntax:**

- `text.charCodeAt(0)` — the numeric code of the first character.
- `=== 0xfeff` — `0x` prefix means hexadecimal. `0xfeff` is 65279 in decimal, the BOM's code.
- `condition ? valueIfTrue : valueIfFalse` — the **ternary operator**, a compact `if/else` that
  produces a value. Here: if the first character is a BOM, take everything from index 1 onward
  (`slice(1)`); otherwise use the text unchanged.

**The line-ending normalisation.**

```js
const clean = noBom.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
```

**Why do line endings differ?** Historical accident. Windows ends a line with two characters,
carriage-return + line-feed (`\r\n`). Unix, Linux, and modern macOS use just `\n`. Old classic
macOS used just `\r`.

**What is `/\r\n/g`?** A *regular expression* — a pattern for matching text. The `/.../` marks it as
a regex; `g` means "global", i.e. replace every occurrence rather than only the first.

Both replacements run so that whichever convention the bank's system used, the parser below only
ever has to look for `\n`.

**The state machine.**

The loop walks the text one character at a time carrying four pieces of state:

| Variable | Meaning |
|---|---|
| `rows` | Every completed row so far |
| `row` | The fields of the row currently being built |
| `field` | The characters of the field currently being built |
| `inQuotes` | Whether we are inside a quoted field right now |

`let` rather than `const` because all four change as the loop runs.

The `inQuotes` flag is the entire trick. When it is `true`, a comma is just a character to append to
the field — not a separator. That is how `"NEFT, HIMALAYAN TREK"` stays one field.

**The doubled-quote rule:**

```js
if (clean[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
```

Inside a quoted field, how do you write a literal quote character? The CSV convention is to write it
twice. So on seeing a `"` while inside quotes, the parser peeks at the next character. If that is
also a `"`, this is an escaped literal: append one quote and `i++` skips the second so it is not
processed again. Otherwise the quoted field has ended.

**The flush after the loop:**

```js
if (field.length > 0 || row.length > 0) {
  row.push(field);
  rows.push(row);
}
```

Rows are pushed when a `\n` is encountered. If the file does not end with a newline, the final row
would never be pushed. This flushes it. The condition guards against pushing an empty row when the
file *does* end with a newline.

**The blank-row filter:**

```js
return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
```

- `.filter(fn)` — returns a new array containing only elements for which `fn` returns true.
- `.some(fn)` — returns `true` if *at least one* element satisfies `fn`.
- `.trim()` — removes whitespace from both ends of a string.

Together: keep a row only if at least one of its cells contains something other than whitespace.
This drops the trailing blank lines that spreadsheet exports routinely leave behind.

#### Part 3 — the normalisers

```js
// Nepali lakh grouping ("1,25,000.00") doesn't follow 3-digit Western
// grouping, so a locale-aware parser would guess wrong — strip every comma
// and space instead of trying to interpret them.
function normaliseAmount(raw) {
  if (raw == null || raw.trim() === '') return null;
  const cleaned = raw.replace(/[,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return undefined;
  return cleaned;
}
```

Note there is no `export` — this is private to the file.

**The three-way return, which is the subtle part.** This function can return three different kinds of
thing, and each means something distinct:

| Return | Meaning |
|---|---|
| `null` | The cell was empty. That is *fine* — a statement row has either a debit or a credit, so one of the two columns is always blank. |
| `undefined` | The cell had content, but it was not a number. That is an *error*. |
| a string | A clean numeric string. |

Distinguishing "empty" from "garbage" is what lets the caller report `Unparseable amount "abc"` for
one and silently accept the other. Collapsing both into `null` would either reject every valid row
or accept every invalid one.

**Why the lakh comment matters.** In the South Asian numbering system, 125,000 is written
`1,25,000` — grouping by two after the first three digits, not by three. A parser using
`Number.parseFloat` with locale awareness set to a Western locale would misread it. Stripping every
comma and space sidesteps the whole question: `1,25,000.00` becomes `125000.00`, which is correct
under either convention.

**The validation regex, character by character:**

```
/^-?\d+(\.\d+)?$/
```

| Piece | Meaning |
|---|---|
| `^` | Start of the string |
| `-?` | An optional minus sign (`?` = zero or one) |
| `\d+` | One or more digits (`+` = one or more) |
| `(\.\d+)?` | Optionally, a literal dot followed by one or more digits |
| `$` | End of the string |

The `^` and `$` are what make this strict. Without them the pattern would match *anywhere* inside
the string, so `"abc123"` would pass. Anchored, the whole string must be a number and nothing else.

`.test(str)` returns `true` or `false`. The `!` in front inverts it: "if this does **not** look like
a number, return `undefined`."

```js
function normaliseDate(raw, format) {
  const value = raw.trim();
  if (format === 'YYYY-MM-DD') {
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
  }
  if (format === 'DD/MM/YYYY') {
    const m = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : undefined;
  }
  return undefined;
}
```

**Capture groups.** The parentheses in `(\d{2})\/(\d{2})\/(\d{4})` are *capture groups*. When
`.match()` succeeds it returns an array where index 0 is the whole match and indices 1, 2, 3 are the
captured pieces. So for `"05/03/2026"`: `m[1]` is `"05"`, `m[2]` is `"03"`, `m[3]` is `"2026"`.

`` `${m[3]}-${m[2]}-${m[1]}` `` is a **template literal** — backticks with `${...}` placeholders. It
rebuilds the pieces in the opposite order, converting `05/03/2026` into `2026-03-05`.

Both branches return the same format, so everything downstream only ever deals with `YYYY-MM-DD`.
Normalising early means the rest of the file has one less thing to think about.

#### Part 4 — validation and the all-or-nothing rule

```js
const NormalisedRowSchema = z.object({
  rowIndex: z.number().int().nonnegative(),
  txnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().min(1),
  reference: z.string().nullable(),
  debit: z.string(),
  credit: z.string(),
  runningBalance: z.string().nullable(),
}).refine((r) => !(Number(r.debit) > 0 && Number(r.credit) > 0), 'a row cannot have both a debit and a credit')
  .refine((r) => Number(r.debit) > 0 || Number(r.credit) > 0, 'a row needs a nonzero debit or credit');
```

**What is Zod?** A validation library. You describe the shape data must have, and Zod checks a value
against that description, either returning the validated value or reporting exactly what was wrong.

**Why validate here when the parser already ran?** Because the parser checks *format* and this checks
*meaning*. `"0"` is a perfectly well-formed number, but a statement row where both debit and credit
are zero is meaningless.

**`.refine()`** adds a custom rule that plain type checking cannot express — specifically, rules that
involve more than one field at once. The two here are the business rules:

1. A row cannot be both money-in and money-out. (This mirrors the database `CHECK` constraint —
   belt and braces: the same rule enforced at the application boundary for a good error message, and
   at the database for guaranteed enforcement.)
2. A row must be *something*. A row with no debit and no credit is not a transaction.

```js
export function parseAndValidateStatement(csvText, columnMapping) {
  if (!DATE_FORMATS.includes(columnMapping.dateFormat)) {
    throw businessRule('unsupported_date_format', `dateFormat must be one of ${DATE_FORMATS.join(', ')}`);
  }

  const table = parseCsvText(csvText);
  if (table.length < 2) throw businessRule('empty_statement', 'CSV has no data rows');

  const header = table[0].map((h) => h.trim());
  const dataRows = table.slice(1);
  if (dataRows.length > MAX_STATEMENT_ROWS) {
    throw businessRule('too_many_rows', `Statement has ${dataRows.length} rows, maximum is ${MAX_STATEMENT_ROWS}`);
  }

  const { columns } = columnMapping;
  const colIndex = {};
  for (const [field, headerName] of Object.entries(columns)) {
    const idx = header.indexOf(headerName);
    if (idx === -1) throw businessRule('unmapped_column', `Column "${headerName}" not found in statement header`);
    colIndex[field] = idx;
  }
  ...
```

**What is column mapping and why does it exist?** Different banks name their columns differently. One
writes `Date, Description, Debit, Credit, Balance`; another writes
`Txn Date, Particulars, Withdrawal, Deposit, Running Balance`. Rather than hard-coding one bank's
headers, the caller supplies a mapping:

```js
{
  dateFormat: 'YYYY-MM-DD',
  columns: { date: 'Date', description: 'Description', reference: 'Reference',
             debit: 'Debit', credit: 'Credit', balance: 'Balance' }
}
```

Read it as: "my `date` field is the column headed `Date`." In the finished product this is the
column-mapping step of the upload wizard — the user maps their bank's headers once.

**`const { columns } = columnMapping;`** is **destructuring** — shorthand for
`const columns = columnMapping.columns;`.

**`Object.entries(columns)`** turns an object into an array of `[key, value]` pairs, so
`{ date: 'Date', debit: 'Debit' }` becomes `[['date', 'Date'], ['debit', 'Debit']]`. The
`for (const [field, headerName] of ...)` form destructures each pair into two named variables as it
loops.

The result, `colIndex`, maps our field names to physical column positions: `{ date: 0, description: 1,
reference: 2, debit: 3, credit: 4, balance: 5 }`. Everything below looks up by position.

Now the row loop:

```js
  const rows = [];
  const errors = [];

  dataRows.forEach((cells, i) => {
    const cell = (field) => (colIndex[field] != null ? (cells[colIndex[field]] ?? '') : '');

    const txnDate = normaliseDate(cell('date'), columnMapping.dateFormat);
    if (txnDate === undefined) {
      errors.push({ rowIndex: i, message: `Unparseable date "${cell('date')}"` });
      return;
    }
    ...
    const candidate = { rowIndex: i, txnDate, description, reference, debit, credit, runningBalance };
    const parsed = NormalisedRowSchema.safeParse(candidate);
    if (!parsed.success) {
      errors.push({ rowIndex: i, message: parsed.error.issues[0].message });
      return;
    }
    rows.push(parsed.data);
  });

  if (errors.length > 0) {
    const err = businessRule('invalid_statement_rows', 'One or more rows failed validation');
    err.details = errors;
    throw err;
  }

  return rows;
}
```

**Two accumulator arrays, and why that shape.** Notice the structure: every row is processed, good
rows go into `rows`, bad rows go into `errors`, and only *after the whole loop* is a decision made.

This is the **all-or-nothing rule**, and the plan is explicit about it: *"Reject the WHOLE file if
any row fails; a half-imported statement is worse than none."*

**Why is a half-import worse than no import?** Because it is invisible. If rows 1–40 import and row
41 fails, the user sees a statement in the system. It looks complete. The reconciliation will not
balance and nobody will know why. Refusing the entire file makes the failure loud and the fix
obvious.

**Why collect all errors instead of throwing on the first?** Usability. Throwing at row 3 means the
user fixes row 3, re-uploads, and discovers row 7 is also broken. Collecting every error means one
round trip: "rows 3, 7, and 22 have unparseable dates."

**`const cell = (field) => ...`** is an **arrow function** — a compact way to write a function. It is
declared inside the loop callback, so it *closes over* `cells` and `colIndex` (a **closure**: a
function that remembers the variables from where it was defined). That is what lets the body below
write `cell('date')` instead of `cells[colIndex.date]` with a null check each time.

**`??` is the nullish coalescing operator** — `a ?? b` gives `a` unless `a` is `null` or `undefined`,
in which case `b`. Here `cells[colIndex[field]] ?? ''` guards against a row that has fewer cells than
the header promised.

**`return` inside `forEach`** does not exit the loop — it exits only the current callback, moving to
the next row. That is exactly what is wanted: record the error and continue so remaining rows are
still checked.

**`err.details = errors;`** attaches the full per-row error list to the error object. `businessRule`
(from `backend/src/lib/accounting/errors.js`) creates a plain `Error` with `.status = 422` and a
`.code`; adding `.details` gives the frontend the per-row breakdown it needs to highlight the bad
rows.

- **Data in:** raw CSV text and a column mapping.
- **Processing:** parse → map columns → normalise each row → validate each row → collect errors.
- **Data out:** an array of clean row objects, or a thrown 422 carrying every row-level problem.
- **Who calls it:** `statement-import-service.js`, once, before any database write.

---

### 3.3 The matching engine

---

**File:** `backend/src/lib/banking/matching-engine.js`

**Status:** Created

**Purpose:** Given a list of freshly imported statement lines, work out which ledger movement each
one corresponds to, how confident we are, and whether that confidence is high enough to assert the
match without asking a human.

**Why does this file exist?** This is the part of the project that is a genuine algorithm rather than
CRUD. Keeping it in its own file, with no HTTP knowledge and no writes to the database, means it can
be reasoned about and tested as a pure decision function: lines in, decisions out.

**How does it connect to other files?** `statement-import-service.js` calls `matchStatementLines()`
and is responsible for persisting whatever it returns. It imports `dec` and `eq` from `../money.js`.
It receives a Prisma transaction object as its first argument, so its queries run inside the caller's
transaction.

**The critical design property: it never writes.** `matchStatementLines()` returns an array of
decisions. It does not update a single row. The caller persists them. That separation is what makes
the engine safe to run inside someone else's transaction, and easy to reason about — you can read the
whole file and know it cannot corrupt data.

#### The constants

```js
import { dec, eq } from '../money.js';

const AMOUNT_WEIGHT = 0.55;
const DATE_WEIGHT = 0.25;
const REFERENCE_WEIGHT = 0.20;
export const AUTO_MATCH_THRESHOLD = 0.90;
export const SUGGEST_THRESHOLD = 0.45;
const TIE_EPSILON = 1e-9;
```

The three weights sum to exactly 1.0, which is what keeps a score in the range `[0, 1]` and therefore
interpretable as a percentage confidence.

The weights encode a judgement about which evidence is most trustworthy:

- **Amount (0.55)** — the strongest signal. If the amounts do not match exactly, nothing else
  matters (see the hard gate below).
- **Date (0.25)** — strong but not decisive. Bank settlement lags: you record a receipt on the day
  the cheque arrives, the bank clears it two days later.
- **Reference (0.20)** — the smallest weight but often the most *specific* evidence. When a
  description contains the actual invoice number, that is nearly conclusive; but many bank
  descriptions contain nothing useful at all, so it cannot carry a large weight.

`AUTO_MATCH_THRESHOLD = 0.90` and `SUGGEST_THRESHOLD = 0.45` come straight from the plan. Both are
`export`ed even though nothing imports them yet — they are the numbers the frontend's confidence
badge will need.

`TIE_EPSILON = 1e-9` is scientific notation for `0.000000001`. It exists because of how computers
store decimal numbers. Two scores that are mathematically identical can differ in the last few bits
of a floating-point representation, so `scoreA === scoreB` is unreliable. Comparing
`scoreA - scoreB < TIE_EPSILON` asks the question that was actually meant: "are these the same score
for all practical purposes?"

#### The date score

```js
function dateScore(days) {
  const d = Math.abs(days);
  if (d === 0) return 1.0;
  if (d === 1) return 0.9;
  if (d <= 3) return 0.7;
  if (d <= 7) return 0.4;
  return 0;
}

function daysBetween(a, b) {
  return Math.round((new Date(a) - new Date(b)) / 86_400_000);
}
```

`Math.abs()` returns the absolute value — it discards the sign. This matters because the ledger entry
could be dated *before* the statement line (you recorded the cheque, the bank cleared it later) or
*after* (the bank charged you on the 25th, you recorded it on the 28th when you noticed). Both are
equally plausible; only the size of the gap matters.

The steps are not linear, and the shape is deliberate. Same day is near-certain. One day apart is
routine settlement lag, barely penalised. Two or three days is plausible. A week is the outer edge.
Beyond seven days the score is zero — and note the candidate query below never returns anything
beyond seven days anyway, so this is a second line of defence.

**`daysBetween`, explained from zero.**

`new Date(a) - new Date(b)` looks odd — subtracting two dates. In JavaScript, using a `Date` object in
arithmetic converts it to a number: milliseconds since 1 January 1970 (the "Unix epoch"). So the
subtraction gives a difference in milliseconds.

`86_400_000` is the number of milliseconds in a day (24 × 60 × 60 × 1000). **The underscores are digit
separators** — a JavaScript feature that makes long numbers readable. `86_400_000` and `86400000` are
the identical number; the underscores exist purely for the human reader.

`Math.round()` handles the fact that the two dates might not sit at exactly the same time of day.

#### The candidate query

```js
// Posted journal lines on the bank account's GL account, not already claimed
// by another statement line, within a week of the statement line's date
// (§7 candidate pool). One query per statement line — the date window and
// the trigram similarity against THIS line's description both depend on it.
async function findCandidates(tx, { organizationId, glAccountId, statementLine }) {
  return tx.$queryRaw`
    SELECT jl.id, jl.debit, jl.credit, je."entryDate" AS entry_date,
           d."docNo" AS doc_no, d."referenceNo" AS reference_no,
           similarity(lower(${statementLine.description}), lower(COALESCE(p.name, ''))) AS name_similarity
    FROM "JournalLine" jl
    JOIN "JournalEntry" je ON je.id = jl."journalEntryId"
    LEFT JOIN "Document" d ON d."journalEntryId" = je.id
    LEFT JOIN "Party" p ON p.id = d."partyId"
    WHERE jl."organizationId" = ${organizationId}
      AND jl."accountId" = ${glAccountId}
      AND je.status = 'POSTED'
      AND je."entryDate" BETWEEN ${statementLine.txnDate}::date - INTERVAL '7 days'
                              AND ${statementLine.txnDate}::date + INTERVAL '7 days'
      AND jl.id NOT IN (
        SELECT "matchedJournalLineId" FROM "BankStatementLine" WHERE "matchedJournalLineId" IS NOT NULL
      )
  `;
}
```

**What is `$queryRaw`?** Prisma's generated client covers ordinary queries, but this one needs
`similarity()` (a `pg_trgm` function Prisma knows nothing about) and an interval date window.
`$queryRaw` sends SQL directly.

**Is that a SQL injection risk?** No, and the reason is important. This is a **tagged template
literal** — note there are no parentheses after `$queryRaw`, just a backtick string. Prisma intercepts
the template's `${...}` slots and sends them to PostgreSQL as *parameters*, separately from the SQL
text. The database never confuses data with instructions. The dangerous version is `$queryRawUnsafe`
with a concatenated string; the plan's security section explicitly says to grep for it before
submitting, and this codebase has zero occurrences in application code.

**Reading the SQL, clause by clause.**

`FROM "JournalLine" jl` — start from journal lines. `jl` is an *alias*, a short name used later.

`JOIN "JournalEntry" je ON je.id = jl."journalEntryId"` — a plain `JOIN` (also called an inner join)
requires a match on both sides. Every journal line belongs to an entry, so this never drops rows; it
is here to reach `entryDate` and `status`.

`LEFT JOIN "Document" d ON d."journalEntryId" = je.id` — a **`LEFT JOIN` keeps the left row even when
the right side has no match**, filling the right side's columns with `NULL`. That is essential here: a
*manual* journal entry has no source document at all. With an inner join, every manual entry would
vanish from the candidate pool.

**This is the exact join that exposed the Day 4 receipt bug** (Problem 8). It only finds a document
when `Document.journalEntryId` points at the entry — which, for receipts, was `NULL` for every row.

`LEFT JOIN "Party" p ON p.id = d."partyId"` — reach the customer name through the document. Also a
left join, because the previous join might have produced no document.

`similarity(lower(...), lower(COALESCE(p.name, '')))` — the trigram comparison. `lower()` makes it
case-insensitive. **`COALESCE(a, b)` returns the first non-null argument** — so when there is no party
(a manual entry, or the receipt bug), it compares against an empty string instead of `NULL`. Without
`COALESCE`, `similarity()` would return `NULL`, and `NULL` propagating into the score arithmetic would
poison it.

`AND je.status = 'POSTED'` — only posted entries. A draft is not real money. Note this deliberately
excludes `REVERSED` too: a reversed entry should not be matchable.

`AND je."entryDate" BETWEEN ... - INTERVAL '7 days' AND ... + INTERVAL '7 days'` — the ±7 day window.
`::date` is PostgreSQL's cast syntax, forcing the parameter to be treated as a date.
`INTERVAL '7 days'` is a native duration type, so the arithmetic handles month and year boundaries
correctly — no manual day counting.

**Why a window at all?** Two reasons. It bounds the work (without it, every journal line ever posted
to that account is a candidate). And it encodes real knowledge: bank settlement takes days, not
months. A ledger entry six months away from a statement line is not the same transaction, whatever
the amount says.

`AND jl.id NOT IN (SELECT "matchedJournalLineId" FROM "BankStatementLine" WHERE ... IS NOT NULL)` —
exclude journal lines already claimed by any statement line. This is a **subquery**: a query nested
inside another. The `IS NOT NULL` filter inside it matters, because `NOT IN` with a list containing
`NULL` produces surprising results in SQL — every comparison against `NULL` is "unknown" rather than
false, so the whole `NOT IN` yields no rows at all.

**Why one query per statement line rather than one query for all of them?** Because two parts of the
query depend on the individual line: the date window is centred on *that line's* date, and the
`similarity()` call compares against *that line's* description. The comment in the file says exactly
this. The cost is N queries for N lines, which is why `MAX_STATEMENT_ROWS` exists.

#### The scoring function

```js
// Amount is a hard gate, not a weight (§7): off by even one paisa, or on the
// wrong side of the entry (RECON-6 — a statement credit only ever matches a
// journal DEBIT on the bank account, never a credit), and the score is zero.
function scoreCandidate(statementLine, candidate) {
  const stmtIsCredit = dec(statementLine.credit).gt(0);
  const stmtAmount = stmtIsCredit ? dec(statementLine.credit) : dec(statementLine.debit);
  const matchAmount = stmtIsCredit ? dec(candidate.debit) : dec(candidate.credit);

  if (matchAmount.isZero() || !eq(matchAmount, stmtAmount)) return 0;

  const dScore = dateScore(daysBetween(statementLine.txnDate, candidate.entry_date));

  const docNoHit = candidate.doc_no && statementLine.description.toUpperCase().includes(String(candidate.doc_no).toUpperCase()) ? 1 : 0;
  const referenceHit = candidate.reference_no && statementLine.reference && candidate.reference_no === statementLine.reference ? 1 : 0;
  const nameSimilarity = Number(candidate.name_similarity ?? 0);
  const rScore = Math.max(docNoHit, referenceHit, nameSimilarity);

  return AMOUNT_WEIGHT * 1 + DATE_WEIGHT * dScore + REFERENCE_WEIGHT * rScore;
}
```

**The three lines that implement RECON-6 — the direction rule.**

This is the classic first-day reconciliation bug, and it is worth being very slow and explicit about,
because the reversal is genuinely counter-intuitive.

From **your** books' point of view, the bank account is an *asset* — something you own. In
double-entry accounting, an asset increases with a **debit** and decreases with a **credit**.

From **the bank's** point of view, your account is a *liability* — money they owe you. So the bank's
statement uses the opposite convention. When money arrives, the bank **credits** your account.

Put together:

| Real event | Bank statement says | Your ledger says |
|---|---|---|
| Customer pays you 100,000 | **Credit** 100,000 (money in) | **Debit** the bank GL account 100,000 |
| Bank charges you 1,130 | **Debit** 1,130 (money out) | **Credit** the bank GL account 1,130 |

So a statement **credit** must be matched against a journal **debit**, and vice versa. Getting this
backwards produces a matcher that appears to work — it finds pairs, the amounts agree — while pairing
every transaction with something that moved money the opposite way.

The code:

```js
const stmtIsCredit = dec(statementLine.credit).gt(0);
const stmtAmount = stmtIsCredit ? dec(statementLine.credit) : dec(statementLine.debit);
const matchAmount = stmtIsCredit ? dec(candidate.debit) : dec(candidate.credit);
```

Line 1 asks "is this statement line money coming in?" — `dec()` wraps the value as a `Decimal`,
`.gt(0)` means "greater than zero."

Line 2 picks the statement line's amount from whichever column is populated.

Line 3 is the direction rule: if the statement says credit, look at the candidate's **debit**;
otherwise look at its **credit**. The opposite side, always.

Test RECON-6 proves it: it posts a receipt (which debits the bank account), then imports a statement
line that is a *debit* of the same amount on the same day. Everything else about it is a perfect
match. The test asserts it stays `unmatched` — because the directions disagree, no score is produced.

**The hard gate:**

```js
if (matchAmount.isZero() || !eq(matchAmount, stmtAmount)) return 0;
```

Two conditions, joined by `||` (logical OR — true if either side is true):

1. `matchAmount.isZero()` — the candidate has nothing on the side we care about. A journal line has
   either a debit or a credit, so if we are looking at the debit column and it is zero, this line
   moved money the wrong way. Rejected.
2. `!eq(matchAmount, stmtAmount)` — the amounts are not exactly equal. `eq()` from `money.js` does a
   `Decimal` comparison, exact to the last paisa. `!` inverts it.

Either one returns `0`, and a score of 0 is below `SUGGEST_THRESHOLD`, so the candidate is filtered
out entirely.

**Why is amount a gate rather than a weighted component?** The plan is emphatic and the reasoning is
worth internalising: *a system that "helpfully" matches 100,000 against 100,500 will silently hide a
NPR 500 error forever.* The entire purpose of reconciliation is to surface discrepancies. Fuzzy amount
matching does the exact opposite of the job.

**The reference score — three sources, best one wins:**

```js
const docNoHit = candidate.doc_no && statementLine.description.toUpperCase().includes(String(candidate.doc_no).toUpperCase()) ? 1 : 0;
```

`candidate.doc_no && ...` uses `&&` as a guard: if `doc_no` is `null`, JavaScript stops evaluating and
the expression is falsy, so the ternary yields `0`. This avoids calling `.toUpperCase()` on `null`,
which would throw.

`.includes(x)` asks whether one string contains another. Both sides are upper-cased first so
`inv-2082-0001` inside a description matches `INV-2082-0001`.

A hit scores a full `1` — the invoice number appearing in the bank's own description is about as
strong as evidence gets.

```js
const referenceHit = candidate.reference_no && statementLine.reference && candidate.reference_no === statementLine.reference ? 1 : 0;
```

An exact match between the payment reference recorded on the document and the reference column on the
statement. Also scores `1`.

```js
const nameSimilarity = Number(candidate.name_similarity ?? 0);
const rScore = Math.max(docNoHit, referenceHit, nameSimilarity);
```

The trigram score, defaulting to `0` if the query returned `NULL`. `Number(...)` converts it from
whatever the database driver produced into a JavaScript number.

`Math.max(a, b, c)` takes the **best** of the three signals rather than adding them. That is
deliberate: they are three different ways of detecting the same fact ("this statement line is about
that document"). Adding them would let a lucky combination of weak signals outrank one conclusive one,
and could push the total above 1.0.

**The final sum:**

```js
return AMOUNT_WEIGHT * 1 + DATE_WEIGHT * dScore + REFERENCE_WEIGHT * rScore;
```

`AMOUNT_WEIGHT * 1` looks strange — why multiply by a literal `1`? Because by the time execution
reaches this line, the amount gate has already passed, so the amount score *is* exactly 1. Writing it
as `* 1` keeps the formula visually parallel with the other two terms and matches the plan's written
formula. It documents the structure rather than optimising the arithmetic.

**Worked example.** A statement line credit of 10,000 on 2026-01-05, description `NEFT RCP-2082-0001`,
against a receipt posted the same day whose document number is `RCP-2082-0001`:

```
amount:    exact match           → gate passes, contributes 0.55 × 1  = 0.55
date:      same day              → dateScore = 1.0,  0.25 × 1.0       = 0.25
reference: doc_no in description → docNoHit = 1,     0.20 × 1         = 0.20
                                                             total    = 1.00
```

Score 1.00 ≥ 0.90, so it auto-matches. That is RECON-1's happy path.

Now the same line, but the bank cleared it two days late and the description is just `NEFT TRANSFER`:

```
amount:    exact match           → 0.55 × 1                           = 0.55
date:      2 days apart          → dateScore = 0.7,  0.25 × 0.7       = 0.175
reference: nothing matches       → rScore = 0,       0.20 × 0         = 0.00
                                                             total    = 0.725
```

0.725 falls between 0.45 and 0.90 — a *suggestion*. The system says "this is probably it" and a human
clicks confirm. Which is exactly right: the amount agrees and the date is close, but there is no
corroborating evidence, so asserting it would be overconfident.

#### Assignment, the tie rule, and the decisions

```js
export async function matchStatementLines(tx, { organizationId, glAccountId, statementLines }) {
  const perLine = new Map(); // statementLineId -> sorted [{journalLineId, score}]

  for (const line of statementLines) {
    const candidates = await findCandidates(tx, { organizationId, glAccountId, statementLine: line });
    const scored = candidates
      .map((c) => ({ journalLineId: c.id, score: scoreCandidate(line, c) }))
      .filter((c) => c.score > SUGGEST_THRESHOLD)
      .sort((a, b) => b.score - a.score);
    perLine.set(line.id, scored);
  }
```

**What is a `Map`?** A built-in JavaScript collection of key-value pairs. Similar to a plain object,
but keys can be any type and it preserves insertion order. `.set(key, value)` stores, `.get(key)`
retrieves.

**The method chain:**

- `.map(fn)` — transform every element. Each raw database row becomes `{ journalLineId, score }`.
- `.filter(fn)` — keep only elements passing the test. Drops everything at or below 0.45, including
  everything the amount gate zeroed.
- `.sort((a, b) => b.score - a.score)` — sort descending. JavaScript's `sort` takes a comparator
  returning a negative number, zero, or a positive number. `b.score - a.score` is positive when `b`
  is larger, which puts larger scores first. (Writing `a.score - b.score` would sort ascending — a
  very easy bug to introduce.)

```js
  // A line whose own top two candidates score equally is ambiguous — the
  // matcher cannot tell which one is right, so it must never auto-confirm
  // for that line even if the tied score clears 0.90 (§7 edge cases: "two
  // identical amounts on the same day" — RECON-3). Computed against the
  // FULL per-line candidate list, before any candidate is claimed below.
  const ambiguous = new Set();
  for (const [lineId, scored] of perLine) {
    if (scored.length >= 2 && scored[0].score - scored[1].score < TIE_EPSILON) {
      ambiguous.add(lineId);
    }
  }
```

**What is a `Set`?** A collection of unique values with fast membership testing. `.add(x)` inserts,
`.has(x)` asks whether it is present.

**Why this check must happen here, before assignment.** This is the subtle part.

Consider RECON-3: two receipts of 5,000 from the same customer on the same day, and two statement
lines matching them. Every candidate list looks like this:

```
statement line A: [ {journalLine1, 1.0}, {journalLine2, 1.0} ]
statement line B: [ {journalLine1, 1.0}, {journalLine2, 1.0} ]
```

Both lines have two candidates scoring identically. Neither line has any evidence distinguishing
journalLine1 from journalLine2.

Now watch what greedy assignment does: it sorts all four triples (all scoring 1.0), walks them, and
pairs A→journalLine1 and B→journalLine2 — or the reverse, depending purely on sort order. Both score
1.0, comfortably above 0.90, so both would auto-confirm.

The system would have asserted a specific pairing it has no evidence for.

Checking *before* assignment, against the full candidate list, catches this: line A's top two
candidates are tied, so A is ambiguous; same for B. Neither can auto-confirm, so both come out as
`SUGGESTED`.

Checking *after* assignment would not work, because by then each line has exactly one assigned
candidate and the tie is invisible.

```js
  const triples = [];
  for (const [statementLineId, scored] of perLine) {
    for (const c of scored) triples.push({ statementLineId, journalLineId: c.journalLineId, score: c.score });
  }
  triples.sort((a, b) => b.score - a.score);

  const claimedLines = new Set();
  const claimedJournalLines = new Set();
  const assignments = new Map();

  for (const t of triples) {
    if (claimedLines.has(t.statementLineId) || claimedJournalLines.has(t.journalLineId)) continue;
    claimedLines.add(t.statementLineId);
    claimedJournalLines.add(t.journalLineId);
    assignments.set(t.statementLineId, t);
  }
```

**This is the greedy bipartite assignment**, and it is only nine lines.

**What does "bipartite" mean?** A bipartite graph has two separate groups of nodes, with connections
only ever running *between* the groups, never within one. Here: statement lines on one side, journal
lines on the other, and each possible pairing is an edge carrying a score. The task is to choose a set
of edges such that no node is used twice — a *matching*.

**What does "greedy" mean?** An algorithm that always takes the best available option right now,
without looking ahead. Here: take the highest-scoring pair, then the next highest that is still
available, and so on.

The two `Set`s track which nodes are used. `continue` skips to the next iteration of the loop, so a
triple whose statement line or journal line is already claimed is simply passed over.

**Why greedy can be non-optimal — the honest version.** Suppose:

```
A→X scores 0.95    A→Y scores 0.90
B→X scores 0.94    B→Y scores 0.50
```

Greedy takes A→X (0.95, the highest), which forces B→Y (0.50). Total: 1.45.
The optimal choice is A→Y (0.90) plus B→X (0.94). Total: 1.84.

Greedy got it wrong. So why ship it?

Because look at *where* it went wrong: B ended up at 0.50, well below 0.90, so **a human reviews it
anyway**. The auto-confirmed set is only ever the near-1.0 pairs, and in that region the amount gate
plus the date window mean there is rarely more than one plausible candidate for greedy to get wrong.

The full answer, which is the one to give if asked: *"Greedy, because at statement scale it is within
a rounding error of optimal when top scores cluster near 1.0, and everything below 0.9 is
human-confirmed regardless. The globally optimal solution is the Hungarian algorithm or min-cost
max-flow; I would reach for it if statements got large enough that assignment quality actually
mattered."*

```js
  return statementLines.map((line) => {
    const a = assignments.get(line.id);
    if (!a) return { statementLineId: line.id, journalLineId: null, status: 'UNMATCHED', matchedBy: null, confidence: null };

    const canAutoConfirm = a.score >= AUTO_MATCH_THRESHOLD && !ambiguous.has(line.id);
    return {
      statementLineId: line.id,
      journalLineId: a.journalLineId,
      status: canAutoConfirm ? 'MATCHED' : 'SUGGESTED',
      matchedBy: canAutoConfirm ? 'AUTO' : null,
      confidence: a.score,
    };
  });
}
```

The two conditions for auto-confirming, joined by `&&` (both must be true): the score clears 0.90,
**and** the line was not flagged ambiguous.

Every input line produces exactly one decision object, so the caller can iterate the result and update
rows without any lookup logic.

- **Data in:** a transaction handle, the org and GL account ids, and the statement lines.
- **Processing:** score every candidate for every line → detect ties → greedy assignment → classify.
- **Data out:** one decision per line: `{ statementLineId, journalLineId, status, matchedBy, confidence }`.
- **Who calls it:** `statement-import-service.js`, inside its transaction.
- **What it calls:** `findCandidates` (which queries the database) and `scoreCandidate` (pure).

---

### 3.4 The import service

---

**File:** `backend/src/lib/banking/statement-import-service.js`

**Status:** Created

**Purpose:** The end-to-end import pipeline: check for a duplicate upload, parse and validate the
whole file, derive the statement's period and balances, write the statement and its lines, run the
matcher, persist the decisions, and return a summary.

**Why does this file exist?** It is the *orchestrator*. `csv.js` knows about text, `matching-engine.js`
knows about scoring, and neither knows about the database. This file knows the order things must
happen in and owns the transaction.

**How does it connect to other files?** Called by `routes/banking.js`. Calls `csv.js` for parsing and
hashing, `matching-engine.js` for the decisions, and Prisma for all writes.

```js
export async function importStatement(actor, { bankAccountId, fileName, csvContent, columnMapping }, tx = prisma) {
  const run = async (tx) => {
    const bankAccount = await tx.bankAccount.findFirst({
      where: { id: bankAccountId, organizationId: actor.organizationId },
    });
    if (!bankAccount) throw notFound('Bank account not found');

    const sha256 = fileSha256(csvContent);
```

**The `tx = prisma` default parameter — the optional-transaction pattern.**

This appears three times in this session (`postDocument`, `importStatement`, and already existed on
`postReceipt`), so it is worth understanding once, properly. Section 4.5 covers it in full; the short
version:

`tx = prisma` is a **default parameter** — if the caller does not pass a third argument, `tx` becomes
the ordinary Prisma client. The function body always uses `tx`, so it works either way, and the last
line decides whether to open a transaction:

```js
  return tx === prisma ? prisma.$transaction(run, { isolationLevel: 'ReadCommitted' }) : run(tx);
```

If `tx` is still the default, nobody gave us a transaction, so we open our own. If it is something
else, the caller is already inside a transaction and we join theirs.

**Why does this function need it?** Because when the request carries an `Idempotency-Key`, the route
wraps the import in `runIdempotent()`, which opens a transaction so the idempotency-key row and the
statement land in the *same commit*. That is the whole argument for keeping idempotency keys in
Postgres rather than Redis: if the transaction rolls back, so does the key, and the client's retry
correctly re-attempts. Two systems that can disagree about whether an import happened is exactly the
failure you were trying to prevent.

**The duplicate check:**

```js
    // Re-uploading the same file is idempotent by construction (§7 edge
    // cases, RECON-2): return the ORIGINAL statement, import nothing new.
    const existing = await tx.bankStatement.findFirst({
      where: { bankAccountId, fileSha256: sha256 },
      include: { lines: true },
    });
    if (existing) {
      const counts = existing.lines.reduce(
        (acc, l) => {
          if (l.status === 'MATCHED') acc.autoMatched++;
          else if (l.status === 'SUGGESTED') acc.suggested++;
          else if (l.status === 'UNMATCHED') acc.unmatched++;
          return acc;
        },
        { autoMatched: 0, suggested: 0, unmatched: 0 }
      );
      return { statement: existing, imported: 0, replayed: true, ...counts, lines: existing.lines };
    }
```

**`.reduce(fn, initialValue)` explained from zero.** `reduce` walks an array and accumulates a single
result. The callback receives the accumulator so far (`acc`) and the current element (`l`), and
returns the new accumulator. Starting from `{ autoMatched: 0, suggested: 0, unmatched: 0 }`, each line
increments one counter, and the final object is the tally.

**`...counts` is the spread operator.** It expands an object's properties into the object being built,
so `{ statement, imported: 0, replayed: true, ...counts }` becomes
`{ statement, imported: 0, replayed: true, autoMatched: 3, suggested: 0, unmatched: 1 }`.

**Why re-count rather than store the counts on the statement?** Because statuses change after import —
a human confirms a suggestion, a reversal un-matches a line. Counting live means the replay response
reflects reality now, not at import time.

`imported: 0` is the honest answer to "how many rows did this call insert?" — zero. And
`replayed: true` lets the route distinguish a real import from a replay, which matters because a
replay must not write an audit entry claiming a statement was imported.

**Deriving the statement period and balances:**

```js
    const rows = parseAndValidateStatement(csvContent, columnMapping);
    if (rows.length === 0) throw businessRule('empty_statement', 'CSV has no data rows');

    const txnDates = rows.map((r) => r.txnDate).sort();
    const periodStart = new Date(txnDates[0]);
    const periodEnd = new Date(txnDates[txnDates.length - 1]);
    const lastBalance = [...rows].reverse().find((r) => r.runningBalance != null)?.runningBalance;
    const firstBalance = rows.find((r) => r.runningBalance != null)?.runningBalance;
    if (firstBalance == null || lastBalance == null) {
      throw businessRule('missing_balance_column', 'Statement rows must carry a running balance to derive opening/closing balance');
    }
    const openingBalance = dec(firstBalance).minus(dec(rows[0].credit)).plus(dec(rows[0].debit));
    const closingBalance = dec(lastBalance);
```

**Sorting dates as strings works here — and only because of the format.** `.sort()` with no comparator
sorts as text. For dates that is normally a bug (`"9 Jan"` sorts after `"10 Jan"`). It is correct here
*only* because every date has already been normalised to `YYYY-MM-DD`, where alphabetical order and
chronological order coincide. That is a hidden benefit of normalising early in `csv.js`.

**`[...rows].reverse()`** — `.reverse()` mutates the array it is called on, which would scramble the
caller's row order. `[...rows]` spreads into a *new* array first, so the original is untouched. A small
habit that prevents a whole class of confusing bugs.

**`?.` is optional chaining.** `find(...)?.runningBalance` means: if `find` returned an object, read
`.runningBalance`; if it returned `undefined`, produce `undefined` rather than throwing "cannot read
property of undefined."

**The opening balance calculation deserves a slow read:**

```js
const openingBalance = dec(firstBalance).minus(dec(rows[0].credit)).plus(dec(rows[0].debit));
```

The CSV has no "opening balance" field. What it has is a *running balance* on each row — the balance
**after** that row's transaction. So the balance before the first transaction is:

`(balance after row 1) − (money row 1 added) + (money row 1 removed)`

Working through the plan's sample statement: the first row is a debit of 25,000 leaving a running
balance of 475,000. So opening = 475,000 − 0 + 25,000 = **500,000**. Correct.

Note the arithmetic uses `Decimal` methods (`.minus()`, `.plus()`), never `-` and `+`. Mixing a
`Prisma.Decimal` with a JavaScript number is the exact failure mode the plan's danger table warns
about: it produces a string or `NaN` silently, and the first symptom is a trial balance that will not
foot.

**Writing the rows:**

```js
    const lines = [];
    for (const row of rows) {
      const line = await tx.bankStatementLine.create({
        data: {
          organizationId: actor.organizationId,
          statementId: statement.id,
          bankAccountId,
          txnDate: new Date(row.txnDate),
          description: row.description,
          reference: row.reference,
          debit: row.debit,
          credit: row.credit,
          runningBalance: row.runningBalance,
          rowHash: rowHash(row),
          status: 'UNMATCHED',
        },
      });
      lines.push(line);
    }
```

A sequential `for...of` loop with `await` inside, rather than `createMany` — because we need each
created row back (with its generated `id`) to hand to the matcher. Every row starts `UNMATCHED`; the
matcher decides afterwards.

```js
    const decisions = await matchStatementLines(tx, {
      organizationId: actor.organizationId,
      glAccountId: bankAccount.accountId,
      statementLines: lines,
    });

    const updatedLines = [];
    for (const d of decisions) {
      const updated = await tx.bankStatementLine.update({
        where: { id: d.statementLineId },
        data: {
          status: d.status,
          matchedJournalLineId: d.journalLineId,
          matchConfidence: d.confidence,
          matchedBy: d.matchedBy,
          matchedAt: d.journalLineId ? new Date() : null,
        },
      });
      updatedLines.push(updated);
    }

    const counts = summarize(decisions);
    return { statement, imported: rows.length, replayed: false, ...counts, lines: updatedLines };
  };
```

Note `glAccountId: bankAccount.accountId` — the matcher searches the **general ledger account**, not
the `BankAccount` row. That is the `Account`-versus-`BankAccount` distinction from section 3.1 doing
real work.

`matchedAt: d.journalLineId ? new Date() : null` — only stamp a match time if there actually is a
match.

**Everything above happens inside one transaction.** If the matcher throws on line 40 of 60, the
statement, all 60 lines, and every update are rolled back together. There is no state in which a
statement exists but was never matched.

---

### 3.5 The reconciliation service

---

**File:** `backend/src/lib/banking/reconciliation-service.js`

**Status:** Created

**Purpose:** Everything that happens *after* import — the three resolution paths for a line, the book
balance calculation, and creating and completing a reconciliation.

**How does it connect to other files?** Called by `routes/banking.js` (all five exported functions)
and by `routes/reports.js` (which imports `computeBookBalance` so the summary report and the
reconciliation itself cannot drift apart). It calls `postDocument` and `findFiscalYearForDate` from
the accounting library.

#### Manual match (RECON-4)

```js
export async function manualMatchLine(actor, statementLineId, journalLineId) {
  return prisma.$transaction(async (tx) => {
    const line = await loadStatementLine(tx, actor.organizationId, statementLineId);
    if (['RECONCILED', 'IGNORED'].includes(line.status)) {
      throw businessRule('line_not_matchable', `Statement line is already ${line.status.toLowerCase()}`);
    }

    const bankAccount = await tx.bankAccount.findFirstOrThrow({ where: { id: line.bankAccountId } });
    const journalLine = await tx.journalLine.findFirst({
      where: { id: journalLineId, organizationId: actor.organizationId, accountId: bankAccount.accountId },
    });
    if (!journalLine) throw notFound('Journal line not found on this bank account');

    try {
      return await tx.bankStatementLine.update({
        where: { id: line.id },
        data: { status: 'MATCHED', matchedJournalLineId: journalLine.id, matchConfidence: 1.0, matchedBy: 'MANUAL', matchedAt: new Date() },
      });
    } catch (err) {
      if (err.code === 'P2002') throw conflict('journal_line_already_matched', 'That journal line is already matched to another statement line');
      throw err;
    }
  });
}
```

**Three guards, each closing a different hole.**

*Guard 1 — status.* A `RECONCILED` line belongs to a completed reconciliation and is frozen. An
`IGNORED` line was deliberately excluded with a written reason; silently matching it would discard
that decision.

*Guard 2 — the journal line must be on this bank account.* Look at the `where` clause: it filters on
`organizationId` **and** `accountId: bankAccount.accountId`. Without the account filter, a user could
match a statement line from their Nabil account to a journal line on their petty-cash account — or to
a revenue line. The reconciliation would balance while being complete nonsense. The `organizationId`
filter is the tenancy check: a journal line ID from another company returns `notFound`, a 404 rather
than a 403, because confirming that a record exists is itself a leak.

*Guard 3 — the `P2002` catch.* `P2002` is Prisma's error code for "unique constraint violated." The
only unique constraint this update can violate is `matchedJournalLineId @unique`, which means another
statement line already claimed that journal line. Rather than letting a raw Prisma error become a 500,
it is translated into a clean `409 journal_line_already_matched`.

**Why catch rather than check first?** Checking first would be a *race*: between "is it claimed?" and
"claim it," another request could claim it. The database constraint cannot be raced, because it is
evaluated at write time. Letting the database be the referee and translating its answer is the correct
pattern.

**`matchConfidence: 1.0` and `matchedBy: 'MANUAL'`** — a human looked at it and asserted it, so
confidence is total. Recording *how* a match was made is what lets the reconciliation summary report
say "3 auto-matched, 1 manually matched," and what lets an auditor ask who asserted it.

#### Create entry from line (RECON-5)

This is the plan's resolution path 2, and the piece rebuilt during the "no cuttings" pass.

```js
export async function createEntryFromLine(actor, statementLineId, { accountId, narration }) {
  return prisma.$transaction(async (tx) => {
    const line = await loadStatementLine(tx, actor.organizationId, statementLineId);
    if (line.status !== 'UNMATCHED' && line.status !== 'SUGGESTED') {
      throw businessRule('line_not_matchable', `Statement line is already ${line.status.toLowerCase()}`);
    }

    const bankAccount = await tx.bankAccount.findFirstOrThrow({ where: { id: line.bankAccountId } });
    const isBankDebit = dec(line.credit).gt(0); // statement credit -> bank account debit
    const amount = isBankDebit ? line.credit : line.debit;
    const lineDescription = narration ?? `Bank statement: ${line.description}`;

    const fiscalYear = await findFiscalYearForDate(tx, actor.organizationId, line.txnDate);

    const draft = await tx.document.create({
      data: {
        organizationId: actor.organizationId,
        fiscalYearId: fiscalYear.id,
        docType: 'BANK_ADJUSTMENT',
        docDate: line.txnDate,
        grandTotal: amount,
        status: 'DRAFT',
        createdById: actor.userId,
        lines: {
          create: [
            {
              lineNo: 1, description: lineDescription, accountId: bankAccount.accountId,
              quantity: 1, unitPrice: amount, taxableAmount: amount, lineTotal: amount,
              debit: isBankDebit ? amount : 0, credit: isBankDebit ? 0 : amount,
            },
            {
              lineNo: 2, description: lineDescription, accountId,
              quantity: 1, unitPrice: amount, taxableAmount: amount, lineTotal: amount,
              debit: isBankDebit ? 0 : amount, credit: isBankDebit ? amount : 0,
            },
          ],
        },
      },
    });

    const entry = await postDocument(draft.id, actor, tx);
```

**The direction logic again, from the other end.** `isBankDebit = dec(line.credit).gt(0)` — if the
statement line is a credit (money arrived), then the bank GL account must be **debited**. Same rule as
the matcher, applied to creation instead of comparison.

The two document lines are mirror images. Line 1 hits the bank account, line 2 hits the account the
user chose. Whichever side line 1 is on, line 2 is on the other — which is what makes the entry
balance.

Working through the RECON-5 test: a statement **debit** of 1,130 (a service charge; money left the
bank). `isBankDebit` is `false`. So line 1 credits the bank account 1,130, and line 2 debits Bank
Charges 1,130. In plain English: the bank has 1,130 less, and we have incurred 1,130 of expense.
Correct.

**The nested `create`.** `lines: { create: [...] }` is Prisma's nested-write syntax: create the
`Document` and its two `DocumentLine` rows in one operation, with the foreign key wired automatically.

**`status: 'DRAFT'`** — this is the key to the whole rebuild. The document is created as a draft,
exactly as an invoice is, and then `postDocument()` posts it. Two steps, the same two steps every
invoice goes through.

**`postDocument(draft.id, actor, tx)`** — the third argument is the transaction. Without the
optional-tx parameter added this session, `postDocument` would open its *own* transaction, which could
not see the draft document created moments ago in *this* uncommitted transaction. It would fail with
"Document not found." Section 4.5 explains why in detail; this was caught by reading rather than by a
test failure.

```js
    const bankLine = entry.lines
      ? entry.lines.find((l) => l.accountId === bankAccount.accountId)
      : await tx.journalLine.findFirstOrThrow({ where: { journalEntryId: entry.id, accountId: bankAccount.accountId } });

    const updated = await tx.bankStatementLine.update({
      where: { id: line.id },
      data: { status: 'MATCHED', matchedJournalLineId: bankLine.id, matchConfidence: 1.0, matchedBy: 'AUTO', matchedAt: new Date() },
    });

    return { statementLine: updated, journalEntry: entry };
  });
}
```

The new entry has two journal lines; we need the one on the bank account, because that is the one
representing this statement line's movement. The ternary handles both shapes `postDocument` might
return depending on whether it included `lines` — defensive, and cheap.

`matchedBy: 'AUTO'` because no human chose *which* line to match. They chose which account to post to;
the pairing itself was mechanical and certain.

**Why the whole thing is one transaction.** Three writes happen: the draft document, the posting, and
the statement-line match. If the match failed after the posting succeeded, you would have a real
journal entry in the ledger and a statement line still claiming to be unexplained — and re-running
would post it a second time. One transaction makes all three atomic.

#### Ignore (resolution path 3)

```js
export async function ignoreLine(actor, statementLineId, reason) {
  const line = await loadStatementLine(prisma, actor.organizationId, statementLineId);
  if (['MATCHED', 'RECONCILED'].includes(line.status)) {
    throw businessRule('line_not_matchable', `Statement line is already ${line.status.toLowerCase()}`);
  }
  return prisma.bankStatementLine.update({
    where: { id: line.id },
    data: { status: 'IGNORED', ignoreReason: reason },
  });
}
```

The shortest of the three paths, and the only one with no transaction — it performs exactly one write,
and a single statement is atomic on its own.

**Why a reason is mandatory.** The route's Zod schema is `z.object({ reason: z.string().min(1) })`, so
an empty reason is a 400. Ignoring a line is the one action that makes a discrepancy disappear without
explaining it in the ledger. Requiring a written reason means the record always says *why* — which is
precisely what an auditor asks about first.

The guard blocks ignoring an already-matched line: it is explained, so there is nothing to ignore.

#### Book balance

```js
// Same formula as the report (§7 "Closing a reconciliation") — the ledger's
// own truth, independent of what has or hasn't been matched.
export async function computeBookBalance(tx, { organizationId, glAccountId, asOfDate }) {
  const [row] = await tx.$queryRaw`
    SELECT COALESCE(SUM(jl.debit), 0) AS total_debit, COALESCE(SUM(jl.credit), 0) AS total_credit
    FROM "JournalLine" jl
    JOIN "JournalEntry" je ON je.id = jl."journalEntryId"
    WHERE jl."organizationId" = ${organizationId} AND jl."accountId" = ${glAccountId}
      AND je.status IN ('POSTED', 'REVERSED') AND je."entryDate" <= ${asOfDate}::date
  `;
  return sub(dec(row.total_debit), dec(row.total_credit));
}
```

**`const [row] = await ...` is array destructuring** — take the first element. `$queryRaw` always
returns an array; an aggregate query returns exactly one row.

**`COALESCE(SUM(...), 0)`** — `SUM` over zero rows returns `NULL`, not `0`. Without `COALESCE`, a
brand-new bank account with no entries would produce `NULL`, and `dec(null)` would throw.

**Debits minus credits, because the bank account is an asset.** Assets increase with debits. For a
liability or revenue account the formula would be the other way round.

**`je.status IN ('POSTED', 'REVERSED')` — why include reversed entries?**

This looks wrong at first and is worth being precise about. When an entry is reversed, LedgerLine does
*not* delete it — it creates a second, offsetting entry and flags the original `REVERSED`. Both entries
stay in the ledger forever, because a financial record must never be erased.

The two entries net to zero: the original debits 1,000, the reversal credits 1,000. So including both
is correct. **Excluding** the original would leave only the reversal's credit of 1,000, making the
balance wrong by exactly the reversed amount. Every report in this codebase filters on this same pair
of statuses for exactly this reason.

**Why is this function exported and shared with the report?** Because `POST /reconciliations/:id/complete`
and `GET /reports/bank-reconciliation` must agree to the paisa. If the report says the difference is
zero and completion refuses, the user has no way forward and no explanation. Sharing one function makes
disagreement impossible.

#### Creating and completing a reconciliation (RECON-7)

```js
export async function completeReconciliation(actor, reconciliationId) {
  return prisma.$transaction(async (tx) => {
    const [reconciliation] = await tx.$queryRaw`
      SELECT * FROM "Reconciliation" WHERE id = ${reconciliationId} AND "organizationId" = ${actor.organizationId} FOR UPDATE
    `;
    if (!reconciliation) throw notFound('Reconciliation not found');
    if (reconciliation.status === 'COMPLETED') {
      throw conflict('already_completed', 'Reconciliation is already completed');
    }

    const bankAccount = await tx.bankAccount.findFirstOrThrow({ where: { id: reconciliation.bankAccountId } });
    const bookBalance = await computeBookBalance(tx, {
      organizationId: actor.organizationId, glAccountId: bankAccount.accountId, asOfDate: reconciliation.asOfDate,
    });
    const bankBalance = dec(reconciliation.bankBalance);
    const difference = sub(bankBalance, bookBalance);
    const unreconciledCount = await tx.bankStatementLine.count({
      where: { statementId: reconciliation.statementId, status: { in: ['UNMATCHED', 'SUGGESTED'] } },
    });

    if (!isZero(difference) || unreconciledCount > 0) {
      throw businessRule('reconciliation_not_balanced', `Difference ${difference.toFixed(2)}, ${unreconciledCount} line(s) still unresolved`);
    }

    await tx.bankStatementLine.updateMany({
      where: { statementId: reconciliation.statementId, status: 'MATCHED' },
      data: { status: 'RECONCILED' },
    });

    return tx.reconciliation.update({
      where: { id: reconciliationId },
      data: {
        status: 'COMPLETED', difference, bookBalance, unreconciledCount: 0,
        completedById: actor.userId, completedAt: new Date(),
      },
    });
  });
}
```

**`FOR UPDATE` — what is a row lock?**

`SELECT ... FOR UPDATE` tells PostgreSQL: read this row *and* lock it until my transaction ends. Any
other transaction trying to lock the same row waits.

**Why is that needed here?** Imagine two requests completing the same reconciliation simultaneously.
Both read status `IN_PROGRESS`, both see difference zero, both proceed, both write. Statement lines get
flipped to `RECONCILED` twice and two `completedAt` timestamps race. With `FOR UPDATE`, the second
request blocks until the first commits, then reads status `COMPLETED` and correctly fails with 409.

**Recompute, never trust.** Note that `bookBalance` and `unreconciledCount` are recalculated here rather
than read from the row. The reconciliation may have been created hours ago; since then someone may have
matched lines, created entries, or posted a backdated journal. The numbers stored at creation are a
snapshot; completion needs the truth *now*.

`bankBalance` is the exception — it comes from the stored row, because it is the bank's own statement
figure and does not change.

**The two conditions for refusal.** `!isZero(difference)` and `unreconciledCount > 0` are *both*
checked, because they are genuinely different failures. A zero difference with unresolved lines is
possible — two unmatched lines that happen to cancel out. Money agreeing by coincidence is not the same
as every line being explained, and reconciliation requires both.

**`updateMany` flips only `MATCHED` lines.** `IGNORED` lines stay `IGNORED` — they were deliberately
excluded and that decision is preserved with its reason.

**And the third layer.** Even if every check above were deleted, the database `CHECK` constraint would
still refuse to write `status = 'COMPLETED'` with a nonzero difference. RECON-7 tests both: it asserts
the endpoint returns 422, then fires a raw `UPDATE` at the table and asserts that fails too.

---

### 3.6 Changes to the existing posting engine

These four files already existed. Understanding *why each one had to change* is more instructive than
the changes themselves.

---

**File:** `backend/src/lib/accounting/posting-rules.js`

**Status:** Modified — one function added

**Purpose of the file:** It holds the *posting rules* — pure functions that turn a business document
into a list of journal lines. "Pure" means no database access, no clock, no randomness: the same input
always produces the same output. That is what makes them trivially testable.

```js
// A bank-charge/interest line discovered during reconciliation (§7 resolution
// path 2) — two plain debit/credit lines, same shape as manual(), but its
// own rule name because it flows through postDocument() (a real Document +
// DocumentLine pair), not postManualEntry()'s document-less path.
function bankAdjustment(document) {
  return document.lines.map((docLine, i) => ({
    accountId: docLine.accountId,
    debit: dec(docLine.debit ?? 0),
    credit: dec(docLine.credit ?? 0),
    partyId: null,
    description: docLine.description,
    lineNumber: i + 1,
  }));
}

export const POSTING_RULES = { invoice, manual, receipt, creditNote, bankAdjustment };
```

**Compare this to the `invoice` rule** in the same file. The invoice rule builds an AR line from
`grandTotal`, a revenue line per document line, and groups VAT by tax account. It knows about
accounts receivable, tax codes, and parties.

`bankAdjustment` knows about none of that. It passes the debit and credit straight through. That is
the whole rule.

**Why does it exist at all, if it is so simple?** Two reasons.

First, `postDocument()` dispatches by document type. Every type needs a rule, even a trivial one.

Second — and this is the real answer — **it is nearly identical to `manual()`, but it is deliberately
not the same function.** Look at the comment: `manual()` serves `postManualEntry()`, which creates a
journal entry with *no document at all* (`sourceId: null`). `bankAdjustment` serves `postDocument()`,
which always has a real `Document`. They happen to transform data identically today, but they sit on
different code paths with different guarantees. Merging them would couple two things that are only
coincidentally alike.

**`docLine.debit ?? 0`** — nullish coalescing again. The `debit` and `credit` columns on
`DocumentLine` are nullable (they only mean something for this document type), so a `null` becomes
`0` before `dec()` sees it.

**`partyId: null`** — a bank charge has no customer or supplier. The bank charged the company, not a
party in the ledger sense.

**`lineNumber: i + 1`** — `.map((item, i) => ...)` gives the index as a second argument, starting at 0.
Journal line numbers are 1-based for humans, hence `+ 1`.

---

**File:** `backend/src/lib/accounting/post-document.js`

**Status:** Modified — two changes, both structural

This is the most important file in the codebase: the plan calls it the single entry point, and says
*"no second code path writes to JournalEntry."* Changing it required care, and the invoice path had to
come out byte-for-byte equivalent.

**Change 1 — the rules table gained a second entry.**

```js
// credit_note/receipt/bill/supplier_payment have their own posting rules and
// permission codes on the days that build them (§6 posting rule table) and
// don't route through here — BANK_ADJUSTMENT is the one other type wired
// in, since §7's "create an entry from the line" explicitly posts through
// this same engine.
const DOC_TYPE_RULES = {
  INVOICE: { rulesKey: 'invoice', prefix: 'INV', permission: 'invoice.post', label: 'Sales Invoice' },
  BANK_ADJUSTMENT: { rulesKey: 'bankAdjustment', prefix: 'BADJ', permission: 'bank.reconcile', label: 'Bank Adjustment' },
};
```

Each entry configures four things:

| Key | Purpose |
|---|---|
| `rulesKey` | Which posting rule builds the journal lines |
| `prefix` | The document number prefix — invoices get `INV-2082-0001`, adjustments get `BADJ-2082-0001` |
| `permission` | Which permission the actor must hold |
| `label` | The human-readable text in the journal entry's description |

**The `permission` value is the interesting one.** Posting an invoice requires `invoice.post`. Posting
a bank adjustment requires **`bank.reconcile`** — a different permission entirely.

That is correct and worth being able to explain: creating a bank-charge entry is a *reconciliation*
action, performed by whoever reconciles the bank account. Someone with permission to reconcile should
be able to record a bank charge without also being able to post sales invoices. Looking at the seeded
role permissions in `backend/src/test/helpers.js`, `bank.reconcile` is held by Owner and Accountant
but **not** by Clerk — so a clerk cannot create adjustments, which is the right control.

**Change 2 — the journal-line builder became a dispatch.**

Before, the function hard-coded `POSTING_RULES.invoice(...)`. Now:

```js
      let journalLines;
      if (doc.docType === 'INVOICE') {
        const arAccount = await tx.account.findFirst({
          where: { organizationId: actor.organizationId, code: AR_ACCOUNT_CODE },
        });
        if (!arAccount) throw internal(`Accounts Receivable account (${AR_ACCOUNT_CODE}) not found for this organization`);

        journalLines = POSTING_RULES.invoice({
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
      } else if (doc.docType === 'BANK_ADJUSTMENT') {
        // No AR line, no party, no tax — a plain debit/credit pair straight
        // off the document lines (§7 resolution path 2).
        journalLines = POSTING_RULES.bankAdjustment({
          lines: docLines.map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit, description: l.description })),
        });
      } else {
        throw internal(`No journal-line builder wired for document type ${doc.docType}`);
      }
```

**Note what moved.** The AR account lookup used to run unconditionally, before the rule was called. It
is now *inside* the invoice branch. That is not cosmetic: a bank adjustment has no accounts-receivable
line, so looking up the AR account for one would be a pointless query — and worse, the `if (!arAccount)
throw internal(...)` would make a bank adjustment fail in an organisation that had not yet created a
`1100` account.

**The `else` branch throws rather than silently doing nothing.** If someone adds a document type to
the enum and to `DOC_TYPE_RULES` but forgets a builder here, the failure is loud and names the type.
Silence would produce an entry with zero journal lines, which the balance assertion below would
reject anyway — but with a far more confusing message.

**Change 3 — the optional transaction parameter.**

```js
// Same optional-tx pattern as postReceipt (§6 receipt-service.js): called
// bare, it opens its own transaction like every invoice post does today.
// Called with an already-open tx — the reconciliation workspace's "create
// entry from line" needs the draft, the post, and the statement-line match
// to commit or roll back together — it joins that transaction instead.
export async function postDocument(documentId, actor, tx = prisma) {
  const run = async (tx) => {
      // ... the entire original body, unchanged ...
      return entry;
  };

  return tx === prisma ? prisma.$transaction(run, { isolationLevel: 'ReadCommitted' }) : run(tx);
}
```

The body was not rewritten — it was wrapped. The original code already used a variable named `tx`
throughout (it was the transaction callback's parameter), so moving it into a named `run` function
with the same parameter name left every line inside untouched.

This is section 4.5's topic and was the subtle problem of the session. It was found by reading rather
than by a failing test, which is worth noting: the test that would have caught it did not exist yet at
the time.

---

**File:** `backend/src/lib/accounting/receipt-service.js`

**Status:** Modified — the Day 4 bug fix (Problem 8)

```js
    const documentDraft = await tx.document.create({
      data: {
        organizationId: actor.organizationId, fiscalYearId: fiscalYear.id,
        docType: 'RECEIPT', docNo, docDate, partyId: party.id,
        // ...
      },
    });

    const journalEntry = await tx.journalEntry.create({
      data: {
        // ...
        status: 'POSTED', sourceId: documentDraft.id, postedAt: new Date(), postedById: actor.userId,
        // ...
      },
      include: { lines: true },
    });

    // postDocument()'s invoice/credit-note path links this back in the same
    // create call; a receipt creates document and entry in the opposite
    // order (create-and-post, no draft), so the link is a second write.
    // Without it, every join from JournalEntry back to its source Document
    // — the general ledger's "click a number, land on the source doc" and
    // the bank matcher's doc_no/party-name reference pass (§7/§8.2) — misses
    // every receipt.
    const document = await tx.document.update({
      where: { id: documentDraft.id },
      data: { journalEntryId: journalEntry.id },
    });
```

**Understanding the two links, because there are two and they point opposite ways.**

| Column | Direction | Set by |
|---|---|---|
| `JournalEntry.sourceId` | entry → document | Was always set correctly |
| `Document.journalEntryId` | document → entry | **This was missing for receipts** |

Why have both? Because queries run in both directions. Given an entry, "what document produced this?"
uses `sourceId`. Given a document, "what did this post as?" uses `journalEntryId`. And crucially, the
`LEFT JOIN "Document" d ON d."journalEntryId" = je.id` in the matcher's candidate query and in the
general ledger report uses the *second* one.

**Why the variable rename?** The original code named the created row `document` and used it further
down (for the allocation loop and the return value). Since the row now needs updating, the create
result became `documentDraft` and the *updated* row became `document` — so every later reference
automatically gets the version with the link populated, with no other line changed.

**Why did this go unnoticed on Day 4?** Because nothing depended on it. Every Day 4 test asserted
amounts, statuses, and allocations. None asserted that a receipt's document could be reached from its
journal entry. The bug was latent until the matching engine needed exactly that join.

**The lesson worth keeping:** a data-integrity bug with no consumer is invisible. It becomes a
correctness bug the moment a feature relies on it — and then it presents as a failure in the *new*
feature, which is a misleading place to start debugging. Section 7.3 covers how this was actually
tracked down.

---

**File:** `backend/src/lib/accounting/reverse-entry.js`

**Status:** Modified — the RECON-8 guard and a new cascade branch

**The guard, inserted before any reversal work happens:**

```js
    // RECON-8 / §7 edge cases: a line whose journal entry is reversed must
    // return to 'unmatched' so the reconciliation workspace picks it up
    // again — unless the reconciliation that consumed it has already
    // completed, in which case the DB CHECK on Reconciliation.difference
    // would be violated the moment matched lines flip; block first instead.
    const matchedStatementLines = await tx.bankStatementLine.findMany({
      where: { matchedJournalLineId: { in: originalLines.map((l) => l.id) } },
    });
    if (matchedStatementLines.some((l) => l.status === 'RECONCILED')) {
      throw businessRule('reconciled_period', 'Journal entry has a reconciled bank statement line and cannot be reversed');
    }
    for (const line of matchedStatementLines) {
      await tx.bankStatementLine.update({
        where: { id: line.id },
        data: { status: 'UNMATCHED', matchedJournalLineId: null, matchConfidence: null, matchedBy: null, matchedAt: null },
      });
    }
```

**`{ in: [...] }` is Prisma's syntax for SQL's `IN`** — "where the column matches any value in this
list." `originalLines.map((l) => l.id)` produces the list of the entry's journal line IDs. So this
finds every statement line pointing at *any* line of the entry being reversed.

**`.some(fn)` returns `true` if at least one element passes.** Here: is any matched line already
reconciled?

**Why check-all-then-act, rather than handling each line as you find it?** Because the decision is
all-or-nothing. If an entry has three journal lines and only one is reconciled, the *entire* reversal
must be refused — you cannot un-match two lines and refuse the third. Checking every line first, then
acting, gets that right.

**Why does reconciled block, while merely matched does not?**

- **Matched** means "we believe this ledger line explains this statement line," in an open
  reconciliation. Reversing the entry invalidates that belief, so the honest response is to return the
  line to `UNMATCHED` and let the workspace pick it up again.
- **Reconciled** means a reconciliation was *completed*: someone certified that book and bank agreed
  to the paisa as at a date. Reversing an entry inside that certified period changes the book balance,
  which would make the certificate false.

And note the comment's second reason, which is mechanical rather than philosophical: if a reversal
did flip reconciled lines back, the `Reconciliation` row would still say `status = 'COMPLETED'` with
`difference = 0` while the actual difference had changed. The database `CHECK` only fires when a row
is written, so it would not catch this — the stale certificate would just sit there being wrong.
Blocking first is the only correct answer.

**Why put this in `reverseEntry()` rather than in the banking module?** Because `reverseEntry` is the
single choke point every reversal goes through. Putting the guard here covers receipt reversals,
invoice reversals, and bank-adjustment reversals with one piece of code. A guard in the banking module
would only cover reversals the banking module knew about — which is none of them.

**The new cascade branch:**

```js
  // A "create entry from line" bank adjustment (§7 resolution path 2) — no
  // allocation, no party ledger to unwind, just the status flip so the
  // source document doesn't stay stuck at POSTED once its entry is reversed.
  // The matched statement line itself is unmatched earlier in reverseEntry,
  // independent of documentType.
  if (documentType === 'bankAdjustment') {
    return tx.document.update({ where: { id: doc.id }, data: { status: 'REVERSED', version: { increment: 1 } } });
  }
```

`cascadeReversal` handles the *document-level* consequences of reversing an entry. For an invoice it
checks for payments and credit notes and refuses if any exist. For a receipt it unwinds every
allocation and restores invoice outstanding amounts. For a bank adjustment there is nothing to unwind
— no allocations, no party ledger — so it just flips the document's status.

**Why is this branch needed at all?** Without it, `cascadeReversal` falls through to `return null` and
the `Document` row stays at `status = 'POSTED'` while its journal entry says `REVERSED`. The document
list would show a live bank adjustment whose ledger entry had been undone.

**Note this branch only became reachable because of the "no cuttings" rebuild.** Under the original
`postManualEntry()` version, a bank adjustment had no `Document` at all, so `sourceId` was `null` and
`cascadeReversal` was never called. Routing through `postDocument()` created a document — and
therefore created the obligation to handle its reversal. That is a good illustration of how following
a specification more closely surfaces work the shortcut had quietly avoided.

---

### 3.7 The HTTP routes

---

**File:** `backend/src/routes/banking.js`

**Status:** Created

**Purpose:** Exposes the banking and reconciliation services over HTTP.

**Why does this file exist?** It is the *boundary layer*. Its job is to translate between the HTTP
world (URLs, headers, JSON, status codes) and the service world (function calls with plain
JavaScript objects). It contains no business logic — every route validates input, calls a service,
records an audit entry, and serialises the result.

**How does it connect to other files?** Mounted by `backend/src/app.js`. Calls the two banking
services, `runIdempotent`, and Prisma directly for simple reads.

Before any route runs:

```js
const router = Router();
router.use(authenticate, resolveTenant);
```

**What is middleware?** A function that runs *before* the route handler, in order, and can either pass
control onward or stop the request. `router.use(a, b)` says every route in this file runs `a` then `b`
first.

The three-question chain, established on Day 2:

1. **`authenticate`** — *who is this?* Reads the `Authorization: Bearer <token>` header, verifies the
   JWT's signature, and sets `req.userId`. No valid token → 401, and the route never runs.
2. **`resolveTenant`** — *which company, and are they allowed in it?* Reads the `X-Organization-Id`
   header and looks up an active membership. The header alone is never trusted. Sets
   `req.organizationId` and `req.roleId`. Not a member → 403.
3. **`authorize('...')`** — *may they do this specific thing?* Applied per route rather than globally,
   because different routes need different permissions.

**The permission choices in this file are worth reading as a set:**

| Route | Permission | Reasoning |
|---|---|---|
| `GET /bank-accounts` | `report.view` | Reading is the lowest tier — even a Viewer can see which bank accounts exist |
| `POST /bank-accounts` | `org.manage` | Creating a bank account is configuration, Owner-only — the same tier as creating GL accounts |
| `POST /bank-accounts/:id/statements` | `bank.reconcile` | Importing is a reconciliation action |
| `GET /statements/:id/lines` | `report.view` | Reading again |
| `POST /lines/:id/match` | `bank.reconcile` | |
| `POST /lines/:id/create-entry` | `bank.reconcile` | Note this *posts to the ledger*, but the gate is the reconciliation permission, matching `DOC_TYPE_RULES` |
| `POST /lines/:id/ignore` | `bank.reconcile` | |
| `POST /reconciliations` | `bank.reconcile` | |
| `POST /reconciliations/:id/complete` | `bank.reconcile` | |

#### The multipart upload

This is the piece rebuilt during the "no cuttings" pass, and it implements the plan's import pipeline
step 1 literally.

```js
// §7 import pipeline step 1: mimetype allowlist + a 2 MB cap, memory storage
// only — never write an uploaded file to disk in this app.
const ALLOWED_MIMETYPES = ['text/csv', 'application/vnd.ms-excel'];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (!ALLOWED_MIMETYPES.includes(file.mimetype)) {
      return cb(businessRule('unsupported_file_type', `Unsupported content type: ${file.mimetype}`));
    }
    cb(null, true);
  },
});
```

**What is multipart/form-data?** A way of encoding an HTTP request body that can hold several distinct
parts, including binary file content, each with its own name and content type. It is what a browser
sends when a form contains `<input type="file">`. A normal JSON body cannot carry a file.

**What is multer?** Express middleware that parses `multipart/form-data`. It puts uploaded files on
`req.file` (or `req.files`) and ordinary text fields on `req.body`.

**`multer.memoryStorage()`** — keep the file in RAM as a `Buffer` rather than writing it to disk. This
is deliberate and the comment says why: *never write user files to disk in this app.* Files written to
disk need a cleanup strategy, create a path-traversal surface, and persist after a crash. This CSV is
parsed immediately and never needed again, so RAM is both simpler and safer.

**`limits: { fileSize: 2 * 1024 * 1024 }`** — 2 MB, written as multiplication so it reads as
"2 × 1024 × 1024 bytes" rather than as `2097152`. This is what makes memory storage safe: without a
cap, a large upload would consume server memory.

**`fileFilter`** — runs per file. `cb` is a **callback**: a function you call to report your decision,
rather than returning a value. `cb(error)` rejects; `cb(null, true)` accepts. This shape exists
because filtering can be asynchronous.

**Why an allowlist and not a blocklist?** An allowlist says what is permitted and rejects everything
else. A blocklist tries to enumerate what is forbidden, which fails the moment something unanticipated
appears. Allowlists are the default correct choice for any security filter.

**Why is `application/vnd.ms-excel` on the list?** Because Windows frequently reports `.csv` files with
that MIME type, since Excel registers itself as their handler. Rejecting it would break uploads for
many real users on a technicality.

**A caveat worth being honest about:** the MIME type is supplied by the *client* and can be lied about.
This filter is not a security boundary against a hostile uploader — it is a guard against honest
mistakes (uploading a PDF by accident). The real protection is that the content is only ever parsed as
text and never executed. That distinction is worth stating plainly rather than overselling the check.

```js
// multer errors (oversize, bad mimetype) surface via this callback rather
// than a thrown exception — translate them into the same tagged-error shape
// every other route's error handler expects (app.js reads err.status/code).
function uploadStatementFile(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return next(businessRule('file_too_large', 'CSV file exceeds the 2 MB limit'));
    }
    next(err);
  });
}
```

**Why wrap multer instead of using it directly?** Because multer reports failures by calling `next(err)`
with *its own* error type. `backend/src/app.js`'s error handler reads `err.status` and `err.code` —
properties a `MulterError` does not have — so an oversized upload would surface as a generic 500.

This wrapper is an **adapter**: it converts one component's error vocabulary into the one the rest of
the application speaks. `upload.single('file')` returns a middleware function, and this calls it
manually with its own callback so it can inspect the error before passing it on.

**`instanceof`** checks whether an object was created from a particular class — here, whether the error
came from multer rather than from `fileFilter`.

#### The import route and idempotency

```js
router.post('/bank-accounts/:id/statements', authorize('bank.reconcile'), uploadStatementFile, async (req, res, next) => {
  try {
    const bankAccountId = z.string().uuid().parse(req.params.id);
    if (!req.file) throw businessRule('missing_file', 'A CSV file is required (multipart field "file")');

    let columnMappingRaw;
    try {
      columnMappingRaw = JSON.parse(req.body.columnMapping ?? '');
    } catch {
      throw businessRule('invalid_column_mapping', 'columnMapping must be a JSON-encoded string field');
    }
    const columnMapping = columnMappingSchema.parse(columnMappingRaw);

    const actor = actorFrom(req);
    const fileName = req.file.originalname;
    const csvContent = req.file.buffer.toString('utf8');
    const key = req.headers['idempotency-key'];
```

**Note the middleware order in the route signature:** `authorize(...)` runs *before*
`uploadStatementFile`. That is deliberate — there is no point spending memory parsing a 2 MB upload
from someone who is not allowed to import statements. Reject first, parse second.

**Why is `columnMapping` parsed from a string?** In multipart form data every non-file field is text.
A nested object cannot be expressed directly, so the client JSON-encodes it and the server decodes it.
The `try/catch` around `JSON.parse` converts malformed JSON into a clean 422 rather than an unhandled
`SyntaxError`.

**`catch { ... }`** without a parameter is *optional catch binding* — valid modern JavaScript for when
you do not need to inspect the error object.

**`req.file.buffer.toString('utf8')`** turns the raw bytes into a string. A `Buffer` is Node's type for
binary data; `.toString('utf8')` decodes it as text.

```js
    let body;
    let replayed = false;
    if (key) {
      const outcome = await runIdempotent(
        { key, endpoint: 'POST /bank-accounts/:id/statements', requestBody: { bankAccountId, fileName, fileSha256: fileSha256(csvContent), columnMapping } },
        async (tx) => {
          const result = await importStatement(actor, { bankAccountId, fileName, csvContent, columnMapping }, tx);
          return { status: 200, body: respond(result) };
        }
      );
      replayed = outcome.replayed;
      body = outcome.body;
      // ...
```

**What is idempotency, and why does an import already protected by a file hash need it too?**

*Idempotent* means an operation can be performed many times with the same effect as performing it
once. The classic case is a payment: the user clicks Pay, the network drops the response, the client
retries — and the customer must not be charged twice.

This endpoint has *two independent* idempotency mechanisms, and they protect different things:

| Mechanism | Protects against | How |
|---|---|---|
| `fileSha256` unique index | The same *file* being imported twice, ever, by anyone | Content hash; works even days apart |
| `Idempotency-Key` header | The same *request* being retried in flight | Client-supplied key stored in Postgres |

The header version handles the case where the first request succeeded but its response never arrived.
Without it, the retry would take the "already exists" path and return `imported: 0` — technically
correct, but the client cannot tell that from a genuine duplicate upload. With the key, the retry
replays the *original* response byte for byte and sets `Idempotent-Replay: true`.

**Look closely at what goes into `requestBody`:** not the CSV content itself, but `fileSha256(csvContent)`.
`runIdempotent` hashes this object to detect "same key, different request." Putting a potentially
2 MB string in there would mean hashing 2 MB on every request; the file's own 64-character hash
identifies it exactly as well.

**Why does `runIdempotent` pass a `tx` into the callback?** So the idempotency-key row and the
statement commit together. This is the argument for keeping idempotency keys in Postgres rather than
Redis: with Redis you would have two systems that could disagree about whether the import happened.

```js
      if (!outcome.replayed) {
        req.auditEntry = { action: 'statement.imported', entityType: 'BankStatement', entityId: body.statement.id, before: null, after: { fileName, imported: body.imported, autoMatched: body.autoMatched } };
      }
```

**`req.auditEntry` — how the audit log works here.** The route does not write the audit row itself. It
attaches a description to the request, and the `auditLog` middleware (registered globally in `app.js`)
writes it in a `res.on('finish')` handler — *after* the response has been sent and the business
transaction has committed.

**Why after?** Because an audit entry must never claim something happened if the transaction rolled
back. This is mistake #10 on the plan's danger list.

**Why is it skipped on a replay?** Because nothing happened. A replay returns a stored response; no
statement was imported. Writing an audit row would put a second "statement.imported" event in the
trail for an import that occurred once.

#### The other routes

The remaining eight follow the same shape, so one example covers them all:

```js
const ignoreLineSchema = z.object({ reason: z.string().min(1) }).strict();

router.post('/lines/:id/ignore', authorize('bank.reconcile'), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const { reason } = ignoreLineSchema.parse(req.body);
    const actor = actorFrom(req);

    const line = await ignoreLine(actor, id, reason);

    req.auditEntry = { action: 'statementLine.ignored', entityType: 'BankStatementLine', entityId: line.id, before: null, after: { reason } };
    res.json(serializeStatementLine(line));
  } catch (err) {
    next(err);
  }
});
```

**`.strict()` on every schema.** By default Zod ignores unknown keys. `.strict()` makes it *reject*
them. That is a security measure, not tidiness: it is how **mass-assignment** bugs are prevented.
Without it, a client could send `{ reason: "x", status: "RECONCILED" }` and, if any code ever spread
the parsed object into a database write, set a field they had no business setting. Rejecting unknown
keys at the boundary closes the whole class.

**`z.string().uuid().parse(req.params.id)`** — validate the URL parameter is actually a UUID. Without
this, a malformed id reaches Prisma and produces a database-level error rather than a clean 400.

**`try/catch` with `next(err)`.** Express 5 does forward rejected promises automatically, but the
explicit `try/catch` matches the convention used by every other route file in this repository.
Consistency inside a codebase is worth more than saving four lines.

**The serialiser functions** (`serializeStatementLine`, `serializeStatement`, `serializeReconciliation`,
`serializeBankAccount`) all do the same three jobs:

1. **Choose which fields the API exposes.** `rowHash` and `organizationId` are deliberately absent —
   internal machinery the client has no use for.
2. **Format money as fixed-decimal strings.** `l.debit.toFixed(2)` produces `"1130.00"`. Money is
   never sent as a JSON number, because JSON numbers are IEEE 754 floats and would reintroduce exactly
   the precision problem `Decimal` exists to avoid.
3. **Translate vocabulary.** `status.toLowerCase()` turns the database's `UNMATCHED` into the API
   contract's `unmatched`. The database convention is uppercase enums; the API contract is lowercase.
   Translating at the boundary means neither side has to accommodate the other.

---

### 3.8 The three new reports

---

**File:** `backend/src/routes/reports.js`

**Status:** Modified — one shared helper and three new endpoints

The rule stated at the top of this file, from Day 3, still governs everything added here:

> Every report is a pure function of `journal_lines WHERE status = 'posted'` — no cached total, no
> denormalised balance, no invoice's own numbers.

#### The shared P&L calculation

```js
// Shared by /reports/profit-loss and the Current Year Earnings line of
// /reports/balance-sheet (§8.4) — REVENUE credits-positive, EXPENSE
// debits-positive, over a date range (a *period* report, unlike the
// point-in-time balance sheet — §8.3's distinction).
async function computeProfitAndLoss(organizationId, from, to) {
  const rows = await prisma.$queryRaw`
    SELECT a.code, a.name, a.type, SUM(jl.debit) AS total_debit, SUM(jl.credit) AS total_credit
    FROM "JournalLine" jl
    JOIN "JournalEntry" je ON je.id = jl."journalEntryId"
    JOIN "Account" a       ON a.id = jl."accountId"
    WHERE jl."organizationId" = ${organizationId}
      AND je.status IN ('POSTED', 'REVERSED')
      AND a.type IN ('REVENUE', 'EXPENSE')
      AND je."entryDate" BETWEEN ${from}::date AND ${to}::date
    GROUP BY a.id, a.code, a.name, a.type
    HAVING SUM(jl.debit) <> 0 OR SUM(jl.credit) <> 0
    ORDER BY a.code
  `;
```

**`GROUP BY` and `SUM` from zero.** Without grouping, this query returns one output row per journal
line. `GROUP BY a.id, ...` collapses all lines that share an account into a single row, and `SUM()`
adds up their debits and credits. So instead of two hundred individual movements you get one row per
account with its totals.

**`HAVING` versus `WHERE`.** `WHERE` filters individual rows *before* grouping. `HAVING` filters the
*groups* after. Since the condition here is about a summed total, it can only be expressed with
`HAVING`. Its purpose is to drop accounts with no activity in the period so the report shows only
lines with numbers on them.

```js
  for (const r of rows) {
    const debit = dec(r.total_debit);
    const credit = dec(r.total_credit);
    if (r.type === 'REVENUE') {
      const amount = sub(credit, debit);
      revenueTotal = add(revenueTotal, amount);
      revenue.push({ code: r.code, name: r.name, amount: amount.toFixed(2) });
    } else {
      const amount = sub(debit, credit);
      expenseTotal = add(expenseTotal, amount);
      expense.push({ code: r.code, name: r.name, amount: amount.toFixed(2) });
    }
  }

  return { revenue, revenueTotal, expense, expenseTotal, netProfit: sub(revenueTotal, expenseTotal) };
```

**Why is the subtraction the other way round for the two types?** This is the concept of a *normal
balance*, and it comes straight from the accounting equation.

- **Revenue** accounts are **credit-normal**: revenue increases with a credit. So a revenue account's
  meaningful figure is `credits − debits`.
- **Expense** accounts are **debit-normal**: an expense increases with a debit. So its figure is
  `debits − credits`.

Doing it the same way for both would render every revenue figure as a negative number.

**Why subtract at all rather than just reporting the credit column?** Because an account can have
movement on both sides. A sales return debits revenue. Reporting only credits would overstate revenue
by the amount of every return.

`netProfit = revenue − expenses`. Positive is a profit, negative is a loss.

#### Profit & Loss

```js
router.get('/reports/profit-loss', authorize('report.view'), async (req, res, next) => {
  try {
    const query = z.object({ from: z.string().regex(DATE_RE).optional(), to: z.string().regex(DATE_RE).optional() }).parse(req.query);
    const to = query.to ?? new Date().toISOString().slice(0, 10);
    const from = query.from ?? (await findFiscalYearForDate(prisma, req.organizationId, new Date(to))).startDate.toISOString().slice(0, 10);
    // ...
```

**The default `from` is the interesting line.** If the caller does not supply a start date, it defaults
to **the start of the fiscal year containing the end date** — not "30 days ago," not "the beginning of
time."

That is because a P&L is conventionally read year-to-date. "Profit as at 28 February" means profit
*for this fiscal year* up to 28 February. And LedgerLine's fiscal year is the Nepali one (2082/83,
running mid-July to mid-July), so hard-coding a January start would be wrong for this product.

**Why is this a *period* report?** `BETWEEN from AND to` — only movements *between* two dates. Compare
with the balance sheet below, which uses `<= asOf` and is therefore cumulative. Section 4.7 covers the
distinction in full.

#### Balance Sheet

The Current Year Earnings mechanic:

```js
    const fiscalYear = await findFiscalYearForDate(prisma, req.organizationId, new Date(asOf));
    const { netProfit } = await computeProfitAndLoss(req.organizationId, fiscalYear.startDate.toISOString().slice(0, 10), asOf);
    equity.push({ code: null, name: 'Current Year Earnings', amount: netProfit.toFixed(2) });
    totalEquity = add(totalEquity, netProfit);

    const difference = sub(totalAssets, add(totalLiabilities, totalEquity));

    res.json({
      asOf,
      assets, liabilities, equity,
      totals: { assets: totalAssets.toFixed(2), liabilities: totalLiabilities.toFixed(2), equity: totalEquity.toFixed(2) },
      integrity: { balanced: isZero(difference), difference: difference.toFixed(2) },
    });
```

`code: null` because this is not a real account — no journal line ever points at it. It is computed at
render time, every time. section 4.6 explains exactly why in full, because this is the mechanic the
plan singles out as the most commonly botched.

**The `integrity` envelope.** Like the trial balance from Day 3, the response carries its own proof:
`assets − (liabilities + equity)` must be zero. The UI renders it as a green check. A report that
audits itself and shows the result on screen is a specific, checkable claim to point at in a demo.

#### Bank Reconciliation Summary

```js
    const bookBalance = await computeBookBalance(prisma, { organizationId: req.organizationId, glAccountId: bankAccount.accountId, asOfDate: asOf });
    const bankBalance = dec(statement.closingBalance);
    const difference = sub(bankBalance, bookBalance);

    const lines = await prisma.bankStatementLine.findMany({ where: { statementId: statement.id } });
    const counts = { autoMatched: 0, manualMatched: 0, suggested: 0, unmatched: 0, ignored: 0 };
    for (const l of lines) {
      if (['MATCHED', 'RECONCILED'].includes(l.status)) {
        if (l.matchedBy === 'MANUAL') counts.manualMatched++; else counts.autoMatched++;
      } else if (l.status === 'SUGGESTED') counts.suggested++;
      else if (l.status === 'IGNORED') counts.ignored++;
      else counts.unmatched++;
    }
```

**This endpoint imports `computeBookBalance` from the reconciliation service** rather than re-writing
the query. That shared function is what guarantees the report and the completion check can never
disagree.

**`difference = bankBalance − bookBalance`.** Sign matters and is worth internalising: a *positive*
difference means the bank holds more than the books say; *negative* means the books claim more than
the bank has. In the summary report test, the bank shows 3,750 while the books say 4,000 — a
difference of −250, because a 250 service charge appears on the statement but has not been recorded in
the ledger yet.

**Both `MATCHED` and `RECONCILED` count as matched**, split by `matchedBy`. This is what produces the
plan's §8.6 footer line: `Matched 4 · Auto-matched 3 · Manually matched 1 · Unmatched 0`.

**Why not use the stored `Reconciliation` row?** Because a reconciliation may not exist yet. This report
is the live view *during* the process, which is exactly when it is most useful — the workspace's sticky
footer showing the difference in red until it reaches zero.

---

### 3.9 The tests

---

**File:** `backend/src/routes/banking.test.js`

**Status:** Created — 12 tests

**Purpose:** Proves RECON-1 through RECON-8 from the plan, plus the upload guards and the summary
report.

**What kind of tests are these?** **Integration tests.** They run the real Express app via `supertest`,
against a real PostgreSQL database, exercising real HTTP requests. Nothing is mocked.

**Why integration rather than unit tests?** Because most of the behaviour being proved *lives in the
seams*: the database `CHECK` constraint, the unique index, the transaction boundaries, the trigram
extension. A unit test with a fake database would prove the JavaScript is self-consistent while
proving nothing about the constraints that actually enforce correctness. The cost is that `npm test`
truncates the development database and needs a running PostgreSQL.

#### The per-test bank account helper

```js
let bankCounter = 0;
// Every test gets its own GL bank account + BankAccount master row, so the
// matcher's candidate pool and the file_sha256 uniqueness never leak between
// scenarios that would otherwise share the same organization.
async function makeBankAccount() {
  bankCounter += 1;
  const code = `10${20 + bankCounter}`;
  const glAccount = await prisma.account.create({
    data: { organizationId: owner.orgId, code, name: `Bank — Test ${bankCounter}`, type: 'ASSET', isBankAccount: true },
  });
  const res = await request(app).post('/api/v1/bank-accounts').set(owner.headers).send({
    accountId: glAccount.id, bankName: `Test Bank ${bankCounter}`, accountNoMasked: `****${1000 + bankCounter}`,
  });
  expect(res.status).toBe(201);
  return { glAccount, bankAccountId: res.body.id };
}
```

**Why does every test need its own bank account?** Two reasons, both about isolation.

First, the matcher's candidate query searches *all* posted journal lines on a GL account. If two tests
shared one account, the second would find the first's receipts as candidates and its counts would be
wrong.

Second, `UNIQUE(bankAccountId, fileSha256)` is scoped per bank account. Two tests uploading similar
CSVs to the same account could collide, and one would silently take the "already imported" path.

This is a general principle worth carrying: **integration tests that share a database must partition
their data.** Here the partition key is the bank account.

#### The multipart helper

```js
function importCsv(bankAccountId, fileName, rows, { idempotencyKey, contentType = 'text/csv' } = {}) {
  const req = request(app)
    .post(`/api/v1/bank-accounts/${bankAccountId}/statements`)
    .set(owner.headers)
    .field('columnMapping', JSON.stringify(columnMapping))
    .attach('file', Buffer.from(csvText(rows), 'utf8'), { filename: fileName, contentType });
  return idempotencyKey ? req.set('Idempotency-Key', idempotencyKey) : req;
}
```

**`.field(...)` and `.attach(...)`** are supertest's multipart helpers — the first adds a text field,
the second a file part. Together they produce exactly the request shape a browser's `<form
enctype="multipart/form-data">` would send.

**`{ idempotencyKey, contentType = 'text/csv' } = {}`** — a destructured parameter with defaults, and
the trailing `= {}` makes the whole options argument optional so existing calls with three arguments
still work.

`Buffer.from(text, 'utf8')` builds the file's bytes in memory — no temporary file on disk.

#### RECON-1: the happy path

```js
    const r1 = await postReceipt(10000, '2026-01-05', glAccount.id);
    const r2 = await postReceipt(20000, '2026-01-12', glAccount.id);
    const r3 = await postReceipt(15000, '2026-01-20', glAccount.id);

    const res = await importCsv(bankAccountId, 'jan-2026.csv', [
      { date: '2026-01-05', description: `NEFT ${r1.receipt.docNo}`, credit: '10000.00', balance: '10000.00' },
      { date: '2026-01-12', description: `NEFT ${r2.receipt.docNo}`, credit: '20000.00', balance: '30000.00' },
      { date: '2026-01-20', description: `NEFT ${r3.receipt.docNo}`, credit: '15000.00', balance: '45000.00' },
      { date: '2026-01-25', description: 'MONTHLY SERVICE CHARGE', debit: '250.00', balance: '44750.00' },
    ]);

    expect(res.body.autoMatched).toBe(3);
    expect(res.body.unmatched).toBe(1);
```

Three receipts are posted, then a statement is imported whose first three lines correspond to them
exactly — same amount, same date, and the receipt's document number embedded in the description. Each
scores 1.00 and auto-matches.

The fourth line is a bank charge with no ledger counterpart. It stays unmatched, and it is the line
RECON-5 later resolves.

**What would break if the implementation were wrong?** If the direction rule were inverted, all three
would fail to match (`autoMatched: 0`). If the amount gate were fuzzy, the 250 charge might spuriously
match something. If the reference pass were broken, the scores would drop to 0.80 and all three would
be *suggested* rather than matched — which is exactly what happened when the receipt link bug was
present (section 7.3).

#### RECON-3: the tie rule

```js
    // Same party, same amount, same date on both receipts: every score
    // component (amount, date, trigram name similarity) ties exactly between
    // the two candidates, so each statement line's own top-2 candidates tie.
    await postReceipt(5000, '2026-01-10', glAccount.id);
    await postReceipt(5000, '2026-01-10', glAccount.id);

    const res = await importCsv(bankAccountId, 'duplicate-amounts.csv', [
      { date: '2026-01-10', description: party.name, credit: '5000.00', balance: '5000.00' },
      { date: '2026-01-10', description: party.name, credit: '5000.00', balance: '10000.00' },
    ]);

    expect(res.body.autoMatched).toBe(0);
    expect(res.body.suggested).toBe(2);
```

Note the descriptions use `party.name` rather than a document number — that is deliberate. Using
document numbers would let the reference pass distinguish the two candidates and break the tie
legitimately. Using the party name makes every score component identical, which is what creates the
genuine ambiguity the rule exists for.

**What this proves:** that the system refuses to guess. Without the tie rule, `autoMatched` would be 2.

#### RECON-7: the control at two layers

```js
    const completeRes = await request(app).post(`/api/v1/reconciliations/${recRes.body.id}/complete`).set(owner.headers).send();
    expect(completeRes.status).toBe(422);
    expect(completeRes.body.error.code).toBe('reconciliation_not_balanced');

    await expect(
      prisma.$executeRaw`UPDATE "Reconciliation" SET status = 'COMPLETED' WHERE id = ${recRes.body.id}`
    ).rejects.toThrow();
```

**This is the most important test in the file.** The first half proves the *service* refuses. The
second half bypasses the service entirely — a raw SQL `UPDATE`, exactly what a rogue script or a
buggy migration would do — and proves the *database* refuses too.

**`await expect(promise).rejects.toThrow()`** is Vitest's way of asserting that a promise fails.
Without `.rejects`, the assertion would run against the promise object rather than its outcome and
would pass no matter what.

#### RECON-8: both halves

The two tests in this block are mirror images:

- The first matches a statement line, reverses the entry while the reconciliation is *open*, and
  asserts the line went back to `UNMATCHED` with `matchedJournalLineId` cleared.
- The second completes the reconciliation first, then attempts the same reversal and asserts
  `422 reconciled_period` — and, importantly, asserts the statement line is **still** `RECONCILED`
  afterwards.

That last assertion matters: it proves the refusal happened *before* any mutation. A guard that threw
after already un-matching some lines would leave the data in a broken half-state.

---

**File:** `backend/src/routes/reports.test.js`

**Status:** Modified — two tests added

```js
describe('GET /reports/balance-sheet', () => {
  it('balances via the computed Current Year Earnings line (§8.4)', async () => {
    // Deliberately not isolated to its own postings — the accounting
    // equation must hold no matter what the rest of this file has already
    // posted, since every entry above balanced by construction.
    const res = await request(app).get('/api/v1/reports/balance-sheet').query({ asOf: '2025-11-05' }).set(owner.headers);
    expect(res.status).toBe(200);
    expect(res.body.integrity.balanced).toBe(true);
    expect(res.body.integrity.difference).toBe('0.00');
```

**Why is this test deliberately *not* isolated?** Most tests set up exactly the data they need. This
one runs against whatever the rest of the file has already posted, and the comment says why: the
accounting equation is an **invariant** — a property that must hold at all times, regardless of what
happened. Every journal entry balances by construction, so assets must always equal liabilities plus
equity.

Testing it against accumulated, unpredictable data is *stronger* than testing it against a controlled
fixture, because it proves the property survives arbitrary history.

**What would break without the Current Year Earnings line?** `integrity.balanced` would be `false` and
`difference` would equal the net profit exactly. That is precisely the failure mode section 4.6
describes, and this test is what catches it.

---

## 4. The code explained from zero

Section 3 walked the files. This section takes the ideas that span several files and explains each one
properly, from first principles.

---

### 4.1 What a bank reconciliation actually is

Before any code, the accounting concept — because the entire session is an implementation of it.

**The situation.** Your accounting system says the bank account holds 625,850. The bank says it holds
624,720. Both records describe the same real money. They disagree by 1,130.

Somebody has to find out why. That process is a *bank reconciliation*.

**Why do they ever disagree?** Three categories, and every real difference falls into one:

1. **Timing.** You wrote a cheque on the 26th and recorded it immediately. The recipient banks it on
   the 3rd. Between those dates your books say the money is gone and the bank says it is still there.
   Both are correct — this is called an *outstanding cheque*. The mirror case, money you recorded as
   received that the bank has not yet processed, is a *deposit in transit*.
2. **Things only the bank knows.** Service charges, interest credited, a bounced cheque. The bank did
   these without asking; you find out when the statement arrives.
3. **Errors.** Someone typed 1,530 instead of 1,350. Or a transaction was recorded twice. These are
   the ones the whole exercise exists to catch.

**The procedure**, which is the same on paper as in this software:

```
1. Take the bank statement and your ledger for the same account.
2. Tick off every pair that matches.               ← this is the matching engine
3. Whatever remains is a difference.
4. Explain each difference:
     - Timing?          → leave it; it will clear next month
     - Bank-only item?  → record it in the books    ← this is create-entry-from-line
     - Error?           → correct it
5. When book balance and bank balance agree, sign it off.  ← this is completeReconciliation
```

Step 5 is the point. Signing off means asserting: *as at this date, these two records agree and every
line is explained.* That assertion is a genuine internal control — it is how an organisation catches
theft, double-payments, and clerical errors before they compound.

**Which is why `CHECK ("status" <> 'COMPLETED' OR "difference" = 0)` matters so much.** It is that
assertion, expressed in a form the database will not let anyone violate.

---

### 4.2 Direction: the concept beginners get wrong

Section 3.3 covered the code. This is the underlying idea, because it is genuinely confusing the first
several times.

**Start with what debit and credit actually mean.** They do not mean "increase" and "decrease." They
mean *left side* and *right side* of an account. Whether a left-side entry increases or decreases the
balance depends on the account type:

| Account type | Increases with | Decreases with |
|---|---|---|
| Asset (bank, receivables, equipment) | **Debit** | Credit |
| Expense (rent, bank charges) | **Debit** | Credit |
| Liability (loans, VAT payable) | Debit | **Credit** |
| Equity (owner's capital) | Debit | **Credit** |
| Revenue (sales) | Debit | **Credit** |

This is a convention, not a law of nature — but it is universal, and it is what makes every entry
balance.

**Now the trap.** Your bank account, in *your* books, is an **asset**. Money arriving increases it, so
money arriving is a **debit**.

But the bank keeps its own books. To the bank, your deposit is money they *owe you* — a **liability**.
Money arriving increases their liability, so on their books it is a **credit**.

The statement you receive is printed from *their* books. So:

```
        YOUR BOOKS                          THE BANK'S STATEMENT
        (bank account = asset)              (your account = their liability)

Money   Debit  ↑ increases your asset       Credit ↑ increases their liability
in

Money   Credit ↓ decreases your asset       Debit  ↓ decreases their liability
out
```

**Every statement credit corresponds to a journal debit, and vice versa.** Always. It is not a quirk
of a particular bank; it is what double-entry accounting requires when two parties record the same
transaction from opposite sides.

**Why this is worth a dedicated test.** A matcher with the direction inverted still finds pairs. The
amounts agree, the dates agree, and it produces confident-looking matches. It is silently pairing
every deposit with a withdrawal. RECON-6 exists specifically to prove this cannot happen:

```js
// The receipt puts a DEBIT on the bank account. A statement DEBIT
// (money out) can only ever match a journal CREDIT — never this line.
await postReceipt(5000, '2026-01-10', glAccount.id);

const res = await importCsv(bankAccountId, 'wrong-direction.csv', [
  { date: '2026-01-10', description: 'SOME PAYMENT', debit: '5000.00', balance: '-5000.00' },
]);

expect(res.body.autoMatched).toBe(0);
expect(res.body.unmatched).toBe(1);
```

Same amount, same day, and it must still not match.

---

### 4.3 Hashing, and the two different hashes in this session

**What is a hash function?** A function that takes input of any size and produces output of a fixed
size. SHA-256 always produces 256 bits, written as 64 hexadecimal characters.

Three properties matter here:

1. **Deterministic** — the same input always produces the same output.
2. **Avalanche** — changing one bit of input changes about half the output bits. Similar inputs
   produce completely dissimilar outputs.
3. **One-way** — given an output, there is no practical way to recover the input.

**Where hashes appear in this codebase, and why each is different:**

| Hash | Algorithm | Purpose | Why this algorithm |
|---|---|---|---|
| Password (Day 2) | Argon2id | Store passwords safely | Deliberately **slow** and memory-hungry, so brute-forcing is expensive |
| Refresh token (Day 2) | SHA-256 | Store tokens safely | Fast; the input is already 32 random bytes, so there is nothing to brute-force |
| `fileSha256` (Day 5) | SHA-256 | Detect a duplicate upload | Fast; not a secret, just a fingerprint |
| `rowHash` (Day 5) | SHA-256 | Detect a duplicate row | Same |

**The question worth being able to answer:** why is a password hashed with something deliberately slow,
while a refresh token — which is also a secret — uses something fast?

Because passwords are chosen by humans, and humans choose from a small space. `Password123` is one of a
few million realistic guesses. Slowness is what makes guessing infeasible. A refresh token is 32 bytes
from a cryptographic random source — the space is 2²⁵⁶. Nobody is guessing it, so slowing the hash buys
nothing and would slow every request.

**And why hash a file at all rather than comparing filenames?** Because filenames lie. `statement.csv`
downloaded twice might be identical or completely different. The hash describes the *content*, which is
the thing that actually matters.

---

### 4.4 Writing a CSV parser by hand — the state machine

Section 3.2 walked the code. The concept underneath is a **finite state machine**, which is worth
recognising because it appears everywhere in parsing.

**The idea:** the meaning of a character depends on what has come before. A comma inside quotes is
data; a comma outside quotes is a separator. So the parser carries a piece of memory — `inQuotes` —
that changes how it interprets each character.

Two states, four inputs:

```
        ┌─────────────────────────────────────────────┐
        │                                             │
        ▼                                             │
   ┌─────────┐   sees  "                       ┌──────────┐
   │ NORMAL  │ ─────────────────────────────►  │ IN_QUOTE │
   │         │  ◄────────────────────────────  │          │
   └─────────┘   sees  " (not followed by ")   └──────────┘
     │  │  │                                     │      │
     │  │  └─ sees , → end field                 │      └─ sees "" → append one "
     │  └──── sees \n → end field, end row       └───────── any other char → append
     └─────── any other char → append
```

Read the code with this picture and every branch has an obvious place:

```js
if (inQuotes) {
  if (c === '"') {
    if (clean[i + 1] === '"') { field += '"'; i++; }   // "" → literal quote, stay
    else { inQuotes = false; }                          // closing quote, leave state
  } else {
    field += c;                                         // commas and newlines are DATA here
  }
} else if (c === '"') {
  inQuotes = true;                                      // enter state
} else if (c === ',') {
  row.push(field); field = '';                          // separator
} else if (c === '\n') {
  row.push(field); rows.push(row); row = []; field = ''; // row end
} else {
  field += c;
}
```

**Why this cannot be done with `split()`.** `text.split('\n').map(line => line.split(','))` looks
correct and handles the plan's sample CSV fine. It breaks the moment a description contains a comma —
which bank descriptions routinely do — and it breaks silently, shifting every subsequent column by one
without any error.

**Why not a library?** A library is a legitimate choice here. The reasoning for hand-writing: the
requirement is small and fully specified by the plan's edge-case list, thirty lines covers it, and the
alternative is a dependency whose behaviour on BOM bytes and lakh grouping you would still have to
verify. On a larger project with more varied input, reach for the library.

---

### 4.5 The optional-transaction pattern

This is the most architecturally interesting thing in the session, and it was found by reading rather
than by a test failure.

**What is a database transaction?** A group of operations treated as one indivisible unit. Either all
of them take effect, or none do. Two properties matter:

1. **Atomicity** — no partial application. If step 3 of 5 fails, steps 1 and 2 are undone.
2. **Isolation** — until it commits, nobody outside the transaction can see its changes.

**Property 2 is what caused the problem.**

Consider `createEntryFromLine`. It needs three writes to be atomic:

```
1. Create the draft Document (+ two DocumentLine rows)
2. Post it → creates a JournalEntry + JournalLines, updates the Document
3. Match the statement line to the new journal line
```

If step 3 failed after step 2 succeeded, you would have a real ledger entry and a statement line still
claiming to be unexplained — and re-running would post a *second* entry. So all three must share one
transaction.

**The problem.** `postDocument()` opened its own transaction unconditionally:

```js
export async function postDocument(documentId, actor) {
  return prisma.$transaction(async (tx) => {
    const [doc] = await tx.$queryRaw`SELECT * FROM "Document" WHERE id = ${documentId} ...`;
    if (!doc) throw notFound('Document not found');
    // ...
  });
}
```

Now trace what would happen:

```
Transaction A (createEntryFromLine)          Transaction B (postDocument)
─────────────────────────────────────        ────────────────────────────────
BEGIN
  INSERT Document (draft)  ← uncommitted
  call postDocument(draft.id)
                                             BEGIN            ← a SEPARATE connection
                                               SELECT Document WHERE id = draft.id
                                               → 0 rows. Transaction A hasn't committed,
                                                 so B cannot see its INSERT.
                                               throw notFound('Document not found')
```

The draft exists, but only inside transaction A. Transaction B is a different connection and by the
isolation property cannot see uncommitted work. It would fail with a confusing "Document not found"
for a document created microseconds earlier.

**The fix — the same pattern `postReceipt` already used:**

```js
export async function postDocument(documentId, actor, tx = prisma) {
  const run = async (tx) => {
    // ... entire original body, using `tx` throughout ...
  };

  return tx === prisma ? prisma.$transaction(run, { isolationLevel: 'ReadCommitted' }) : run(tx);
}
```

Reading it:

- `tx = prisma` — a **default parameter**. Omit the third argument and `tx` is the ordinary client.
- The body is moved into a named function `run` that takes `tx`. Nothing inside changed, because the
  original code already called its transaction parameter `tx`.
- The final line is a ternary: **if `tx` is still the default, nobody gave us a transaction, so open
  one. Otherwise, run inside the caller's.**

So `postDocument(id, actor)` behaves exactly as before — every invoice post is unaffected — while
`postDocument(id, actor, tx)` joins an existing transaction.

**Why not always require a transaction?** It would mean changing every existing caller, including
`routes/invoices.js` and the Day 3 tests, for no benefit to them. The default parameter is
backwards-compatible by construction.

**Why not use nested transactions?** PostgreSQL has savepoints, and Prisma does support some nesting,
but a nested transaction that rolls back independently would break the atomicity requirement — the
whole point is that all three writes succeed or fail together.

**How this was caught.** Not by a test — by reading `postDocument` while wiring the call and noticing
`prisma.$transaction` was unconditional. The lesson: **when composing two functions that each manage
their own transaction, check whether they can actually nest.** It is a failure that would have
appeared as a nonsensical error message far from its cause.

---

### 4.6 Why `Current Year Earnings` is computed and never stored

The plan singles this out as "the single most common mistake in home-grown accounting systems." It is
worth understanding completely.

**Start with the accounting equation:**

```
ASSETS  =  LIABILITIES  +  EQUITY
```

Everything the business owns equals everything it owes plus what the owners have. This is not a
guideline — it is true by construction, because every journal entry has equal debits and credits.

**Now the problem.** A balance sheet lists asset, liability, and equity accounts. Consider a simple
business:

```
ASSETS
  1020  Bank                       624,720
  1100  Accounts Receivable         69,500
                    Total Assets   694,220

LIABILITIES
  2200  VAT Payable                 25,350
               Total Liabilities    25,350

EQUITY
  3100  Owner's Capital            500,000
                    Total Equity   500,000

  Liabilities + Equity  =  525,350
  Assets                =  694,220
  Difference            =  168,870     ✗ DOES NOT BALANCE
```

It is out by exactly 168,870. Which is exactly the net profit for the year.

**Why does this happen?** Because revenue and expense accounts are not on the balance sheet — they are
on the P&L. But every sale *did* increase an asset (cash or receivables). The debit landed on the
balance sheet; the corresponding credit landed on a revenue account, which the balance sheet does not
show.

So the profit is sitting in accounts the balance sheet ignores, and the sheet is short by exactly that
amount.

**How real accounting solves it.** At the end of a fiscal year there is a *closing* process: every
revenue and expense account is zeroed out and the net result is transferred into a permanent equity
account (Retained Earnings). After closing, the balance sheet balances again.

**But mid-year, no closing has happened yet.** So the balance sheet must show the profit *so far* as a
line in equity — computed on the spot:

```js
const fiscalYear = await findFiscalYearForDate(prisma, req.organizationId, new Date(asOf));
const { netProfit } = await computeProfitAndLoss(req.organizationId, fiscalYear.startDate.toISOString().slice(0, 10), asOf);
equity.push({ code: null, name: 'Current Year Earnings', amount: netProfit.toFixed(2) });
totalEquity = add(totalEquity, netProfit);
```

With it:

```
EQUITY
  3100  Owner's Capital            500,000
        Current Year Earnings      168,870   ← computed, not stored
                    Total Equity   668,870

  Liabilities + Equity  =  694,220
  Assets                =  694,220
  Difference            =        0     ✓ BALANCED
```

**Why is it computed rather than stored in an account?**

Because it changes every time anything is posted. Store it, and every invoice, receipt and journal
entry would have to remember to update it. Miss one — or post a backdated entry — and the stored figure
is wrong, with nothing to reveal it.

Computed at render, it is *always* right, because it is derived from the same journal lines the rest of
the report is derived from. This is the same principle stated at the top of `reports.js`: every report
is a pure function of `journal_lines`, never a cached total.

**Note `code: null`.** There is no account `3900`. No journal line points at it. It is a *presentation*
line, existing only in the report's output. Giving it a code would imply it was a real account someone
could post to.

**The date range matters too:** `fiscalYear.startDate` to `asOf` — profit *for this fiscal year* to the
report date. Using all-time would double-count prior years' profits, which have already been closed
into Owner's Capital.

---

### 4.7 Period reports versus point-in-time reports

A small distinction that the plan says a knowledgeable reviewer specifically checks.

**Point-in-time (a *stock*):** "How much is in the bank right now?" The answer accumulates everything
that ever happened up to that moment.

**Period (a *flow*):** "How much did we earn in February?" The answer counts only what happened between
two dates.

The difference shows up directly in the SQL:

```sql
-- Balance Sheet — point in time, cumulative
AND je."entryDate" <= ${asOf}::date

-- Profit & Loss — period, bounded on both ends
AND je."entryDate" BETWEEN ${from}::date AND ${to}::date
```

**Why does each report use the one it does?**

A balance sheet answers "what does the business own and owe *as at* this date." An asset balance is the
sum of every movement since the business started. Bounding it on the left would produce a meaningless
partial balance.

A P&L answers "how did the business perform *during* this period." Performance is inherently about a
span. "Total revenue since inception" is not a useful measure of how February went.

**A useful physical analogy:** a balance sheet is the water level in a tank; a P&L is how much flowed
through the pipe this month. Same system, two different kinds of question — and the level is the
accumulation of all past flows.

**Where the two meet:** the Current Year Earnings line. It is a *period* figure (this fiscal year to
date) appearing on a *point-in-time* report — which is exactly why section 4.6's calculation needs a
`from` as well as a `to`.

---

### 4.8 Multipart uploads versus JSON bodies

**What is an HTTP request body?** After the method, URL, and headers, a request can carry a body. The
`Content-Type` header says how to interpret it.

**`application/json`** — the body is text in JSON format:

```
POST /api/v1/receipts HTTP/1.1
Content-Type: application/json

{"partyId":"abc-123","amount":5000}
```

`express.json()` parses this into `req.body`.

**`multipart/form-data`** — the body is split into parts by a generated boundary string:

```
POST /api/v1/bank-accounts/abc/statements HTTP/1.1
Content-Type: multipart/form-data; boundary=----X7MA

------X7MA
Content-Disposition: form-data; name="columnMapping"

{"dateFormat":"YYYY-MM-DD","columns":{...}}
------X7MA
Content-Disposition: form-data; name="file"; filename="jan-2026.csv"
Content-Type: text/csv

Date,Description,Reference,Debit,Credit,Balance
2026-01-05,NEFT RCP-2082-0001,,,10000.00,10000.00
------X7MA--
```

Each part has its own name, optional filename, and optional content type. This is what a browser sends
when a form includes a file input.

**Why not just put the CSV in a JSON string?** That was the original shortcut, and it did work. The
reasons it was replaced:

1. **It is what the plan specifies.** Step 1 of the import pipeline is explicitly "mimetype allowlist
   (text/csv, application/vnd.ms-excel), ≤ 2 MB." A JSON string has no mimetype to check.
2. **Separate size limits.** With the CSV in the JSON body, `express.json()`'s limit had to be raised
   to 2 MB — which raised it for *every* endpoint, including ones that should never accept a large
   body. Multipart bypasses `express.json()` entirely, so the JSON cap could go back to the spec's
   1 MB while the file gets its own 2 MB.
3. **It is what the frontend will send.** The Day 5 frontend spec calls for drag-and-drop upload.
   Browsers send files as multipart; a JSON-string API would force the frontend to read the file into
   memory and JSON-encode it, which is slower and wasteful.
4. **JSON string encoding is lossy in practice.** Embedding a CSV in JSON requires escaping quotes and
   newlines. It works, but it means the exact bytes the user uploaded pass through two encodings before
   being hashed — one more place for a subtle mismatch.

**The cost:** one dependency and about forty lines. Given that all four reasons are real, it is the
right trade.

---

### 4.9 Belt and braces: the same rule enforced at several layers

A pattern that recurs throughout this session, and one worth naming, because at first glance it looks
like duplicated code.

**Example: "a statement line cannot be both a debit and a credit."**

Enforced in three places:

```js
// 1. csv.js — Zod refinement, at the parsing boundary
.refine((r) => !(Number(r.debit) > 0 && Number(r.credit) > 0), 'a row cannot have both a debit and a credit')
```

```sql
-- 2. the migration — a database CHECK constraint
ALTER TABLE "BankStatementLine" ADD CONSTRAINT "BankStatementLine_debit_credit_check"
  CHECK (NOT ("debit" > 0 AND "credit" > 0));
```

```js
// 3. matching-engine.js — the score is built from one side or the other, never both
const stmtAmount = stmtIsCredit ? dec(statementLine.credit) : dec(statementLine.debit);
```

**Why three times?** Because each layer catches a different failure and gives a different quality of
answer:

| Layer | Catches | Quality of failure |
|---|---|---|
| Zod at the boundary | A malformed CSV | Excellent: "row 7: a row cannot have both a debit and a credit" |
| Database `CHECK` | A bug in *any* code path, a migration, a console `UPDATE` | Absolute, but a cryptic constraint-violation message |
| The engine's structure | Makes the invalid case unrepresentable in the scoring | No failure — it simply cannot arise |

Layer 1 alone is insufficient: it only protects data arriving via that one function. Layer 2 alone is
insufficient for usability: users would see raw PostgreSQL errors. Together they give both good errors
and real guarantees.

**The same shape appears in the reconciliation control:**

| Layer | Mechanism |
|---|---|
| Service | `completeReconciliation` recomputes and throws 422 |
| Database | `CHECK ("status" <> 'COMPLETED' OR "difference" = 0)` |

And in period locking (from Day 3): a service-layer check for the message, a database trigger for the
guarantee.

**The principle:** *validate at the boundary for good errors; constrain at the database for real
guarantees.* Application code can be bypassed — by another service, a script, a future refactor. The
database cannot.

---

## 5. Complete request and runtime flows

### 5.1 The architecture

```
                          BROWSER  (not built yet — Day 5 frontend)
                             │
                             │  HTTP + JSON  /  multipart for the upload
                             ▼
┌────────────────────────────────────────────────────────────────────────┐
│  EXPRESS APP   backend/src/app.js                                      │
│                                                                        │
│   request-id  →  auditLog  →  helmet  →  cors  →  express.json(1mb)    │
│                                                                        │
│   routers mounted at /api/v1:                                          │
│     auth · orgs · masters · invoices · journal-entries                 │
│     reports · receipts · credit-notes · banking   ← new this session   │
└────────────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌────────────────────────────────────────────────────────────────────────┐
│  ROUTE LAYER   routes/banking.js                                       │
│    authenticate → resolveTenant → authorize('bank.reconcile')          │
│    [ multer: mimetype allowlist, 2 MB, memory storage ]                │
│    Zod validation · serialisers · req.auditEntry                       │
└────────────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌────────────────────────────────────────────────────────────────────────┐
│  SERVICE LAYER   lib/banking/                                          │
│                                                                        │
│   statement-import-service.js ──► csv.js          (parse, hash)        │
│              │                                                         │
│              └────────────────► matching-engine.js (score, assign)     │
│                                                                        │
│   reconciliation-service.js ───► lib/accounting/post-document.js       │
│                                          │                             │
│                                          └──► posting-rules.js         │
└────────────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌────────────────────────────────────────────────────────────────────────┐
│  PRISMA CLIENT   db/client.js  (+ tenant extension from Day 2)         │
└────────────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌────────────────────────────────────────────────────────────────────────┐
│  POSTGRESQL                                                            │
│    tables · UNIQUE indexes · CHECK constraints · immutability triggers │
│    pg_trgm extension                                                   │
└────────────────────────────────────────────────────────────────────────┘
```

The important structural property: **each layer only knows about the one below it.** `csv.js` knows
nothing about HTTP or the database. `matching-engine.js` knows about the database but not about HTTP.
`routes/banking.js` knows about HTTP but contains no business rules. That is what makes each piece
independently testable and independently replaceable.

---

### 5.2 Importing a statement, end to end

The scenario: an accountant uploads `jan-2026.csv` containing four rows, against a bank account that
already has three matching receipts posted.

```
 1. BROWSER
    Builds a multipart body: the file plus a columnMapping text field.
    POST /api/v1/bank-accounts/<id>/statements
    Headers: Authorization: Bearer <jwt>, X-Organization-Id: <org>

 2. app.js — request id
    req.id = randomUUID(); response gets X-Request-Id.
    Every log line and error response carries it, so one request can be traced.

 3. app.js — auditLog middleware
    Registers a res.on('finish') listener. Runs LAST, after the response.
    Does nothing yet.

 4. app.js — helmet, cors
    Security headers.

 5. app.js — express.json({ limit: '1mb' })
    Sees Content-Type: multipart/form-data. NOT JSON, so it passes straight
    through untouched. The 1 MB cap is irrelevant to this request.

 6. routes/banking.js — authenticate
    Reads the Bearer token, verifies the signature with JWT_SECRET.
    Sets req.userId.                        Invalid → 401, stop.

 7. routes/banking.js — resolveTenant
    Reads X-Organization-Id, looks up an ACTIVE membership for req.userId.
    Sets req.organizationId, req.roleId, and enters the AsyncLocalStorage
    context the tenant extension reads.     Not a member → 403, stop.

 8. routes/banking.js — authorize('bank.reconcile')
    Queries RolePermission for req.roleId.  No permission → 403, stop.
    NOTE: this runs BEFORE multer — no point buffering 2 MB for someone
    who is not allowed to import.

 9. uploadStatementFile (multer)
    Parses the multipart body.
      • fileFilter checks mimetype ∈ {text/csv, application/vnd.ms-excel}
                                            Wrong type → 422 unsupported_file_type
      • size cap 2 MB                       Too big   → 422 file_too_large
    Sets req.file = { originalname, buffer, mimetype }
         req.body.columnMapping = '<json string>'

10. The route handler
    z.string().uuid().parse(req.params.id)  Bad id → 400 validation_error
    JSON.parse(req.body.columnMapping)      Bad JSON → 422 invalid_column_mapping
    columnMappingSchema.parse(...)          Bad shape → 400
    csvContent = req.file.buffer.toString('utf8')

11. importStatement(actor, {...})           — no Idempotency-Key in this flow
    tx === prisma, so it opens its own transaction:
    ┌─ BEGIN (ReadCommitted) ──────────────────────────────────────────┐
    │                                                                  │
    │ 11a. Look up the BankAccount, scoped to organizationId.          │
    │      Not found → 404. (A valid id from another tenant also       │
    │      gives 404, never 403 — existence is itself information.)    │
    │                                                                  │
    │ 11b. sha256 = fileSha256(csvContent)                             │
    │      SELECT BankStatement WHERE bankAccountId, fileSha256        │
    │      Found → return { imported: 0, replayed: true, ... }         │
    │              and COMMIT. Nothing written.        ← RECON-2       │
    │                                                                  │
    │ 11c. parseAndValidateStatement(csvContent, columnMapping)        │
    │        • strip BOM, normalise CRLF                               │
    │        • state-machine parse into rows of cells                  │
    │        • map header names → column positions                     │
    │        • normalise each date and amount                          │
    │        • Zod-validate each row                                   │
    │        • ANY row bad → throw 422 with the full error list,       │
    │          ROLLBACK, nothing written at all                        │
    │                                                                  │
    │ 11d. Derive periodStart/End from the min/max dates.              │
    │      Derive openingBalance from row 1's running balance,         │
    │      closingBalance from the last running balance.               │
    │                                                                  │
    │ 11e. INSERT BankStatement                                        │
    │                                                                  │
    │ 11f. INSERT BankStatementLine × 4, all status = UNMATCHED,       │
    │      each with its rowHash (which includes the row index).       │
    │                                                                  │
    │ 11g. matchStatementLines(tx, ...)                                │
    │      For EACH of the 4 lines:                                    │
    │        • SELECT candidate journal lines on the bank GL account,  │
    │          POSTED, within ±7 days, not already claimed,            │
    │          LEFT JOIN Document and Party, computing                 │
    │          similarity(description, party name) via pg_trgm         │
    │        • score each candidate:                                   │
    │             amount gate (exact + correct direction) else 0       │
    │             + 0.25 × dateScore                                   │
    │             + 0.20 × max(docNo hit, reference hit, similarity)   │
    │        • keep those > 0.45, sort descending                      │
    │      Then: flag lines whose top-2 candidates tie (RECON-3)       │
    │      Then: greedy assignment over all triples, one-to-one        │
    │      Return one decision per line — WITHOUT writing anything     │
    │                                                                  │
    │ 11h. UPDATE each BankStatementLine with its decision.            │
    │      Rows 1–3 → MATCHED, matchedBy AUTO, confidence 1.000        │
    │      Row 4    → UNMATCHED (the bank charge)                      │
    │      The @unique on matchedJournalLineId guarantees no journal   │
    │      line was claimed twice.                                     │
    │                                                                  │
    └─ COMMIT ─────────────────────────────────────────────────────────┘

12. Back in the route
    req.auditEntry = { action: 'statement.imported', ... }
    (skipped entirely if this was a replay — nothing happened)

13. res.status(200).json({ statement, imported: 4, autoMatched: 3,
                           suggested: 0, unmatched: 1 })

14. res.on('finish') fires — the auditLog middleware from step 3
    Status is 2xx and req.auditEntry exists, so writeAuditLog() inserts
    the audit row. AFTER the response, AFTER the transaction committed.
    If it fails, it is logged and swallowed — an audit failure must never
    break a successful business operation.
```

**The one thing to take from this trace:** steps 11a–11h are inside a single transaction. Any failure
anywhere in that range leaves the database exactly as it was before step 11. There is no state in which
a statement exists with unparsed lines, or lines that were never run through the matcher.

---

### 5.3 Create-entry-from-line — the demo's best moment

The scenario: row 4 above is the unmatched `MONTHLY SERVICE CHARGE 1,130.00`. The accountant clicks
"Create entry", picks account `5500 Bank Charges`, and the difference falls to zero on screen.

```
 1. POST /api/v1/lines/<lineId>/create-entry
    Body: { "accountId": "<5500's id>" }

 2. authenticate → resolveTenant → authorize('bank.reconcile')

 3. Zod: the line id is a UUID; the body is exactly { accountId, narration? }
    .strict() rejects any extra key.

 4. createEntryFromLine(actor, lineId, { accountId })
    ┌─ BEGIN ──────────────────────────────────────────────────────────┐
    │                                                                  │
    │ 4a. Load the statement line, scoped to organizationId.           │
    │     Status must be UNMATCHED or SUGGESTED.                       │
    │     Already MATCHED/RECONCILED/IGNORED → 422 line_not_matchable  │
    │                                                                  │
    │ 4b. Load its BankAccount → gives the bank GL account id.         │
    │                                                                  │
    │ 4c. DIRECTION:                                                   │
    │       line.credit = 0, line.debit = 1130                         │
    │       → isBankDebit = false  (money LEFT the bank)               │
    │       → the bank GL account must be CREDITED                     │
    │                                                                  │
    │ 4d. findFiscalYearForDate(tx, org, line.txnDate)                 │
    │     No fiscal year covers that date → 422 no_fiscal_year         │
    │                                                                  │
    │ 4e. INSERT Document (BANK_ADJUSTMENT, status DRAFT)              │
    │     + INSERT DocumentLine × 2, in one nested write:              │
    │         line 1: bank GL account   credit 1130                    │
    │         line 2: 5500 Bank Charges  debit 1130                    │
    │                                                                  │
    │ 4f. postDocument(draft.id, actor, tx)   ← THE SAME ENGINE        │
    │     Because tx was passed, it JOINS this transaction rather      │
    │     than opening its own — so it can see the draft from 4e.      │
    │     ┌──────────────────────────────────────────────────────┐     │
    │     │ • SELECT Document ... FOR UPDATE   (locks the row)    │     │
    │     │ • status must be DRAFT             → else 409         │     │
    │     │ • organization must be active      → else 422         │     │
    │     │ • assertPeriodOpen(txnDate)        → else 422         │     │
    │     │      period_locked                                    │     │
    │     │ • DOC_TYPE_RULES['BANK_ADJUSTMENT'] →                 │     │
    │     │      permission 'bank.reconcile'   → else 403         │     │
    │     │ • nextDocNumber → 'BADJ-2082-0001'                    │     │
    │     │      (locked counter, never MAX()+1)                  │     │
    │     │ • nextEntryNumber → 'JE-2082-0042'                    │     │
    │     │      (one shared series across all doc types)         │     │
    │     │ • POSTING_RULES.bankAdjustment(...) → 2 journal lines │     │
    │     │ • assert Σdebits === Σcredits      → else 500         │     │
    │     │ • INSERT JournalEntry + 2 JournalLines, status POSTED │     │
    │     │ • UPDATE Document: POSTED, docNo, journalEntryId      │     │
    │     └──────────────────────────────────────────────────────┘     │
    │                                                                  │
    │ 4g. Find the new journal line on the bank GL account.            │
    │                                                                  │
    │ 4h. UPDATE BankStatementLine:                                    │
    │       status MATCHED, matchedJournalLineId = that line,          │
    │       confidence 1.000, matchedBy AUTO                           │
    │                                                                  │
    └─ COMMIT ─────────────────────────────────────────────────────────┘
        ▲
        └── The DEFERRED balance trigger from Day 1 re-checks at COMMIT:
            every journal entry must have Σdebits = Σcredits.

 5. 201 { statementLine: {...status: 'matched'}, journalEntryId }

 6. Audit row written post-response: 'statementLine.createEntry'
```

**What just changed in the books.** Before: the ledger said the bank held 4,000; the statement said
3,750; difference 250 — or in the plan's demo numbers, 625,850 versus 624,720, difference 1,130. After:
a real journal entry credits the bank account and debits Bank Charges. The book balance now equals the
bank balance, the difference is zero, and the reconciliation can be completed.

**And note what it inherited for free** by going through `postDocument`: a document number in the
`BADJ` series, an entry number in the shared `JE` series, period-lock enforcement, the balance
assertion, the immutability trigger, and reversibility through the standard `reverseEntry` path. None
of that had to be written for bank adjustments — it came from using the same engine.

---

### 5.4 Reversing a matched entry (RECON-8)

```
 1. POST /api/v1/journal-entries/<entryId>/reverse
    Body: { "reason": "wrong receipt", "reversalDate": "2026-01-11" }

 2. authenticate → resolveTenant → authorize('journal.post')

 3. reverseEntry(entryId, { reason, reversalDate }, actor)
    ┌─ BEGIN ──────────────────────────────────────────────────────────┐
    │                                                                  │
    │ 3a. SELECT JournalEntry ... FOR UPDATE                           │
    │     Must be POSTED → else 409 already_reversed                   │
    │                                                                  │
    │ 3b. findFiscalYearForDate + assertPeriodOpen for the             │
    │     REVERSAL date (not the original date)                        │
    │                                                                  │
    │ 3c. Load the original's journal lines.                           │
    │                                                                  │
    │ 3d. ★ THE RECON-8 GUARD                                          │
    │     SELECT BankStatementLine                                     │
    │       WHERE matchedJournalLineId IN (those line ids)             │
    │                                                                  │
    │     if any is RECONCILED:                                        │
    │         throw 422 reconciled_period                              │
    │         → ROLLBACK. Nothing changes. The statement line is       │
    │           still RECONCILED, the entry is still POSTED.           │
    │                                                                  │
    │     otherwise, for each matched line:                            │
    │         UPDATE → status UNMATCHED,                               │
    │                  matchedJournalLineId NULL,                      │
    │                  matchConfidence NULL, matchedBy NULL,           │
    │                  matchedAt NULL                                  │
    │         (clearing matchedJournalLineId also releases the         │
    │          @unique slot, so the line can be re-matched later)      │
    │                                                                  │
    │ 3e. Build the reversal: a mechanical debit↔credit swap of        │
    │     every original line.                                         │
    │                                                                  │
    │ 3f. INSERT the reversal JournalEntry (POSTED, reversalOfId set)  │
    │                                                                  │
    │ 3g. UPDATE the original: status → REVERSED.                      │
    │     This is the ONLY permitted update to a posted entry — the    │
    │     Day 4 migration carved a narrow trigger exception for        │
    │     exactly this transition and nothing else.                    │
    │                                                                  │
    │ 3h. cascadeReversal by documentType:                             │
    │       invoice        → refuse if payments/credit notes exist     │
    │       receipt        → unwind every allocation, restore          │
    │                        invoice outstanding amounts               │
    │       creditNote     → restore the parent invoice                │
    │       bankAdjustment → flip the document to REVERSED  ← new      │
    │                                                                  │
    └─ COMMIT ─────────────────────────────────────────────────────────┘

 4. 200 { original: {status:'reversed'}, reversal: {...} }
```

**The guard runs at 3d — before anything is written.** That ordering is the point. If it ran after the
reversal entry was inserted, a refusal would have to roll back work already done. Checking first means
the refusal path never touches a row.

**Both halves are tested.** One test reverses while the reconciliation is open and asserts the line
returned to `UNMATCHED`. The other completes the reconciliation first, attempts the reversal, asserts
`422 reconciled_period`, *and* asserts the line is still `RECONCILED` — proving nothing was half-done.

---

### 5.5 Completing a reconciliation

```
 1. POST /api/v1/reconciliations              { bankAccountId, statementId, asOfDate }
    → creates the reconciliation, storing a SNAPSHOT of book/bank/difference

 2. ... the accountant works: confirms suggestions, creates entries,
       ignores internal transfers ...

 3. POST /api/v1/reconciliations/<id>/complete
    ┌─ BEGIN ──────────────────────────────────────────────────────────┐
    │                                                                  │
    │ 3a. SELECT Reconciliation ... FOR UPDATE                         │
    │     Locks the row. A second concurrent complete() waits here,    │
    │     then reads status COMPLETED and fails with 409.              │
    │                                                                  │
    │ 3b. RECOMPUTE — do not trust the snapshot:                       │
    │       bookBalance = Σdebit − Σcredit on the bank GL account,     │
    │                     entries POSTED or REVERSED, date <= asOf     │
    │       difference  = bankBalance − bookBalance                    │
    │       unreconciledCount = COUNT(lines UNMATCHED or SUGGESTED)    │
    │                                                                  │
    │ 3c. if difference ≠ 0  OR  unreconciledCount > 0:                │
    │       throw 422 reconciliation_not_balanced       ← RECON-7      │
    │                                                                  │
    │ 3d. UPDATE all MATCHED lines → RECONCILED                        │
    │     (IGNORED lines keep their status and their reason)           │
    │                                                                  │
    │ 3e. UPDATE Reconciliation → COMPLETED, completedBy, completedAt  │
    │       ▲                                                          │
    │       └── the CHECK constraint evaluates HERE.                   │
    │           Even if 3c were deleted, this write would be rejected  │
    │           unless difference = 0.                                 │
    │                                                                  │
    └─ COMMIT ─────────────────────────────────────────────────────────┘
```

**Why recompute at 3b rather than using the stored numbers?** Because the reconciliation may have been
created hours earlier. Between then and now, lines were matched, entries created, possibly a backdated
journal posted. The stored values describe the moment of creation. Completion is an assertion about
*now*, so it needs current numbers.

**Why does the row keep the recomputed values?** Because once completed it becomes a historical
certificate — a record of what was true when it was signed off. The live view is the report endpoint,
which recomputes on every call.

---

## 6. New concepts introduced

Only concepts that appear for the first time in this session. Earlier concepts — JWT, middleware,
multi-tenancy, RBAC, transactions, idempotency, Decimal money — are covered in the Day 2, 3 and 4
documents.

### Bank reconciliation

Comparing your own ledger's record of a bank account against the bank's own statement, explaining
every difference, and certifying that the two agree as at a date. It is one of the oldest internal
controls in accounting, and its purpose is to catch errors and theft before they compound.

### Bank statement

The bank's record of every movement on your account over a period, with a running balance. It is
authoritative about what the bank did — but not about what *should* have happened, which is what your
books are for.

### Book balance versus bank balance

*Book balance* is what your ledger says the account holds: Σdebits − Σcredits on the bank GL account,
up to a date. *Bank balance* is the closing balance the statement shows. A reconciliation is complete
when the two are equal.

### Difference

`bankBalance − bookBalance`. Positive means the bank holds more than your books say; negative means
your books claim more than the bank has. Zero is the goal.

### Deposit in transit

Money you have recorded as received that the bank has not yet processed. Your books show it; the
statement does not. Not an error — a timing difference that resolves itself.

### Outstanding cheque

A cheque you have written and recorded that the recipient has not yet banked. Your books show the money
gone; the bank still holds it. The mirror image of a deposit in transit.

### Matching engine

Software that pairs statement lines with ledger movements. Distinguished from a simple lookup by
producing a *confidence score* rather than a yes/no answer, which is what allows high-confidence pairs
to be auto-confirmed while uncertain ones are shown to a human.

### Confidence score

A number in `[0, 1]` expressing how strongly the evidence supports a proposed match. Here it is a
weighted sum of an amount check (as a gate), date proximity, and reference similarity.

### Hard gate

A condition that, if failed, produces a score of zero regardless of every other factor. Amount equality
is a hard gate here. Contrast with a *weight*, where a poor result merely lowers the total. Using a gate
for amount is a deliberate refusal to ever fuzzy-match money.

### Trigram similarity

A way of measuring how alike two strings are by breaking each into overlapping three-character
sequences and measuring the overlap of the two sets. PostgreSQL's `pg_trgm` extension provides it as
`similarity(a, b)`, returning `[0, 1]`. It is how `"IPS/EVEREST CAFE PVT LTD"` can be recognised as
probably referring to `"Everest Cafe Pvt. Ltd."`.

### PostgreSQL extension

An optional add-on package that adds functions, types, or index methods to a database. Installed per
database with `CREATE EXTENSION`. `pg_trgm` is the one used here.

### Bipartite matching

An assignment problem over two distinct groups where connections only run between groups. Here:
statement lines and journal lines. A valid *matching* uses each node at most once.

### Greedy algorithm

One that always takes the best option currently available, without considering how that limits future
choices. Fast and simple; not guaranteed optimal. Used here deliberately, with a stated reason.

### Hungarian algorithm

The classical algorithm that finds the *globally optimal* assignment in a bipartite graph. Mentioned
here because knowing it exists and choosing greedy anyway, for a stated reason, is the point.

### Assignment problem

The general problem of pairing items from two sets to maximise total value subject to each item being
used once. Bank reconciliation is a small instance of it.

### Content hash / file fingerprint

A hash of a file's exact bytes, used as an identifier for its content. Two uploads of the same file
produce the same hash; changing one character produces a completely different one. Used here to make
re-importing a statement idempotent.

### Idempotent by construction

A design where repeating an operation *cannot* have a duplicate effect because a database constraint
forbids it — as opposed to a design that merely remembers to check first. `UNIQUE(bankAccountId,
fileSha256)` is the constraint that makes statement import idempotent by construction.

### `CHECK` constraint

A rule attached to a database table that every row must satisfy, evaluated by the database on every
insert and update. Cannot be bypassed by any application code path.

### DDL versus DML

*Data Definition Language* is the SQL that defines structure (`CREATE TABLE`, `ADD CONSTRAINT`). *Data
Manipulation Language* is the SQL that moves data (`SELECT`, `INSERT`, `UPDATE`). The reconciliation
control is notable for being expressed in DDL.

### Internal control

A procedural or structural safeguard that prevents or detects error and fraud. "A reconciliation cannot
be marked complete unless the difference is zero" is an internal control; expressing it as a `CHECK`
constraint makes it one the software genuinely enforces.

### Denormalisation

Deliberately storing a fact in more than one place to avoid a join at query time. `BankStatementLine`
carries `bankAccountId` even though its statement already knows it. Safe here because the duplicate is
written once and never updated.

### Index

A sorted auxiliary structure the database maintains so it can locate rows without scanning the whole
table.

### Enum (database)

A column type whose value must be one of a fixed, named list, enforced by the database.

### `LEFT JOIN`

A join that keeps every row from the left table even when the right table has no match, filling the
right side with `NULL`. Essential in the candidate query, where a journal entry may legitimately have
no source document.

### `COALESCE`

A SQL function returning its first non-null argument. Used to turn a missing party name into an empty
string so `similarity()` returns a number rather than `NULL`.

### Subquery

A query nested inside another. Used here to exclude journal lines already claimed by a statement line.

### Aggregate function

A function like `SUM()` or `COUNT()` that collapses many rows into one value, usually with `GROUP BY`.

### `HAVING` versus `WHERE`

`WHERE` filters rows before grouping; `HAVING` filters groups afterwards. A condition on a `SUM()` can
only be expressed with `HAVING`.

### Row lock (`SELECT ... FOR UPDATE`)

Reads a row and holds it locked until the transaction ends, so concurrent transactions must wait rather
than acting on stale data. Used when completing a reconciliation.

### Optional-transaction pattern

A function signature like `fn(args, tx = prisma)` that lets a service either open its own transaction
or join a caller's. Necessary when two operations that each manage transactions must be composed
atomically.

### Multipart form data

An HTTP body format that carries several named parts, including binary files, separated by a boundary
string. What browsers send for file uploads.

### Memory storage (uploads)

Keeping an uploaded file in RAM as a `Buffer` rather than writing it to disk. Chosen here because the
file is consumed immediately, and disk files would need cleanup and create a path-handling surface.

### MIME type allowlist

Accepting only an explicit list of content types and rejecting everything else. Note it guards against
mistakes rather than attackers, since the client supplies the value.

### Finite state machine

A model where the interpretation of the next input depends on the current state. The CSV parser is one:
`inQuotes` determines whether a comma is a separator or data.

### Byte order mark (BOM)

An invisible `U+FEFF` character some programs write at the start of a text file. Invisible when read,
but a real character in the string — it silently breaks header matching if not stripped.

### All-or-nothing import

Validating every row before writing any, and rejecting the entire file if any row fails. A
half-imported statement is worse than none because it looks complete while being wrong.

### Profit & Loss (income statement)

A *period* report: revenue minus expenses between two dates. Measures performance over a span.

### Balance Sheet

A *point-in-time* report: assets, liabilities, and equity as at a date. Measures position at a moment.

### Period report versus point-in-time report

The distinction between a flow (`BETWEEN from AND to`) and a stock (`<= asOf`). A P&L is a flow; a
balance sheet is a stock.

### The accounting equation

`Assets = Liabilities + Equity`. True by construction, because every journal entry balances.

### Current Year Earnings

The profit for the fiscal year to date, shown as a line in equity on the balance sheet. **Computed at
render, never stored.** Without it, assets exceed liabilities plus equity by exactly the net profit.

### Normal balance

Whether an account type increases with debits or credits. Assets and expenses are debit-normal;
liabilities, equity, and revenue are credit-normal. It determines which way round the subtraction goes
in every report.

### Closing the books

The year-end process that zeroes revenue and expense accounts and transfers the net result into
retained earnings. Mid-year, before closing has happened, the balance sheet must compute Current Year
Earnings instead.

### Mass assignment

A vulnerability where a client sends extra fields that get written to the database because the code
blindly spread the request body into a write. Prevented here by `.strict()` on every Zod schema.

### Belt and braces

Enforcing the same rule at more than one layer — the boundary for good error messages, the database for
guarantees. Used throughout this session.

---

## 7. Errors and debugging

Every problem below actually happened during this session, in this order. None are hypothetical.

---

### 7.1 Prisma refused the schema — a missing opposite relation field

**What happened.** The four new models were written into `schema.prisma` and `npx prisma migrate dev
--create-only` was run. It failed before generating anything.

**The error:**

```
Error: Prisma schema validation - (validate wasm)
Error code: P1012
error: Error validating field `bankAccount` in model `BankStatementLine`: The relation field
`bankAccount` on model `BankStatementLine` is missing an opposite relation field on the model
`BankAccount`. Either run `prisma format` or add it manually.
  -->  prisma\schema.prisma:496
```

**Why it happened.** `BankStatementLine` declared a relation to `BankAccount`:

```prisma
bankAccount  BankAccount   @relation(fields: [bankAccountId], references: [id], onDelete: Restrict)
```

But `BankAccount` had no matching field pointing back. It listed `statements` and `reconciliations` —
the relation to statement *lines* had been forgotten.

**The underlying concept.** In Prisma, a relation is always declared on **both** sides, even though only
one side becomes a real database column. The side with `@relation(fields: ...)` creates the foreign
key; the other side is a *back-relation* that exists purely so Prisma can navigate the relationship in
queries (`include: { statementLines: true }`).

This is different from raw SQL, where a foreign key is declared once, on one table. Prisma needs both
because it generates a typed client for both directions.

**How it was diagnosed.** The error message is unusually good — it names the model, the field, the
missing side, and the line number. It was read literally.

**The fix.** One line added to `BankAccount`:

```prisma
  statements     BankStatement[]
  statementLines BankStatementLine[]     // ← added
  reconciliations Reconciliation[]
```

**Why the fix works.** With both sides declared, Prisma can generate navigation in both directions. The
`[]` means "many" — one bank account has many statement lines.

**The lesson.** When adding a Prisma relation, add both halves at once. And when a validation error
names a file and line, read it literally before theorising — this class of error message is precise.

---

### 7.2 `Cannot read properties of undefined (reading 'findMany')` — the regenerated-client trap

**What happened.** The RECON-8 guard was added to `reverse-entry.js`, the migration had been applied,
and the test suite was run. Three previously-passing tests in `reverse-entry.test.js` began failing
with HTTP 500.

**The error, from the server log:**

```
TypeError: Cannot read properties of undefined (reading 'findMany')
    at C:/Projects/Ledgerline/backend/src/lib/accounting/reverse-entry.js:38:62
```

Line 38 was the new guard:

```js
const matchedStatementLines = await tx.bankStatementLine.findMany({ ... });
```

**Why it happened.** `tx.bankStatementLine` was `undefined`, so calling `.findMany()` on it threw.

The reason is a two-step process that is easy to half-complete. Prisma has **two** separate artifacts:

1. **The migration** — SQL that changes the actual database.
2. **The generated client** — JavaScript in `backend/src/generated/prisma/` that knows which models
   exist.

`npx prisma migrate dev` had created the tables. But the *client* had not been regenerated, so the
JavaScript object had no `bankStatementLine` property. The database was ready; the code did not know
it.

**Why the error is so unhelpful.** JavaScript does not complain about reading a missing property — it
returns `undefined`. The failure only surfaces one step later, when something is called on that
`undefined`. So the message points at `.findMany` rather than at the real problem, which is the
property before it.

**How it was diagnosed.** Two steps. First, `grep` for the model name in the generated client:

```bash
grep -rl "bankStatementLine\|BankStatementLine" src/generated/prisma/
```

which returned nothing. That confirmed the client, not the database, was stale.

**The fix.**

```bash
npx prisma generate
```

All 108 tests passed again immediately.

**It happened a second time.** Later, after adding `BANK_ADJUSTMENT` to the `DocType` enum, the RECON-5
test failed with a different message from the same root cause:

```
PrismaClientValidationError:
Invalid `tx.document.create()` invocation
  docType: "BANK_ADJUSTMENT",
           ~~~~~~~~~~~~~~~~~
Invalid value for argument `docType`. Expected DocType.
```

The database enum had the new value; the generated client's copy of the enum did not. Same fix, same
cause.

**The lesson, and it is the most practical one in this document.** After **any** change to
`schema.prisma`, two commands are needed, not one:

```bash
npx prisma migrate dev     # change the database
npx prisma generate        # change the code that talks to it
```

`migrate dev` usually runs `generate` automatically, which is exactly what makes this trap so easy to
fall into — it works most of the time, so when it does not, the failure feels inexplicable.

**The recognisable signature:** if a Prisma model or enum value that plainly exists in
`schema.prisma` behaves as though it does not, suspect a stale client before suspecting anything else.

---

### 7.3 RECON-1 auto-matched zero instead of three — the real bug of the session

**What happened.** The banking test suite ran for the first time. Eight of twelve tests passed. Four
failed, and they failed in an unusual way:

```
FAIL  src/routes/banking.test.js > RECON-1 > 3 of 4 lines auto-match at >=0.90, 1 stays unmatched
AssertionError: expected +0 to be 3

- Expected
+ Received

- 3
+ 0
```

Not an exception. No error message. The matcher ran cleanly and simply matched nothing.

**How it was diagnosed.** The reasoning ran like this:

*Zero matches, not wrong matches.* If the direction rule were inverted, or the amount gate broken,
there would still be scores — just wrong ones. Zero across the board pointed at something structural.

*Which tests failed?* RECON-1, RECON-7, and both RECON-8 tests. What did they share? **Every one of them
imported a statement line intended to match a receipt.** RECON-3 (which expects zero auto-matches) and
RECON-6 (which expects zero) both passed — because zero was the correct answer for them.

*So: no statement line could ever match a receipt.* That narrowed it to the scoring path for receipts
specifically.

*Working through the arithmetic:* the amount gate must have been passing, because the amounts were
correct and the direction was correct. The date score must have been 1.0, same day. So the maximum
achievable score was:

```
0.55 (amount) + 0.25 (date) + 0.20 × rScore
```

If `rScore` were 0, the total would be **0.80** — below the 0.90 auto-confirm threshold, but above the
0.45 suggest threshold. Which predicts the lines should have been *suggested*, not unmatched.

But the test reported `unmatched: 1` for RECON-7's single line, not `suggested: 1`. So the score was
below 0.45 — meaning the amount gate itself was failing, or there were no candidates at all.

*Reading the candidate query with that in mind:*

```sql
LEFT JOIN "Document" d ON d."journalEntryId" = je.id
LEFT JOIN "Party" p ON p.id = d."partyId"
```

The test descriptions were `NEFT ${r1.receipt.docNo}` — they relied on `doc_no` for the reference pass.
If `d` were always `NULL`, then `doc_no` would be `NULL`, `p` would be `NULL`, and `rScore` would
always be 0.

*Checking whether receipts populate that column:* opening `receipt-service.js` and reading it end to
end showed it created the `Document`, created the `JournalEntry` with `sourceId` pointing at the
document — and **never set `Document.journalEntryId`**.

**Why it happened.** `postDocument()` (used by invoices) sets `journalEntryId` when it posts. But a
receipt does not go through `postDocument` — it create-and-posts in one step, in the opposite order,
and that final link was simply never written. It had been missing since Day 4.

**Why nobody noticed for a day.** Nothing depended on it. Every Day 4 test asserted amounts, statuses,
and allocations. None asserted that a receipt's document could be reached *from* its journal entry.

It had also been silently degrading a Day 3 feature: `GET /reports/general-ledger` uses the identical
join to return `sourceDocumentId`, so clicking a receipt row in the general ledger would never have
linked back to the receipt.

**The fix.** One write added to `receipt-service.js`, inside the existing transaction:

```js
const document = await tx.document.update({
  where: { id: documentDraft.id },
  data: { journalEntryId: journalEntry.id },
});
```

with the created row renamed to `documentDraft` so every later reference picks up the updated version.

**Why the fix works.** With the link populated, the `LEFT JOIN` finds the document, `doc_no` and the
party name become available, the reference pass scores 1.0, and the total reaches 1.00. All four tests
passed, and the full suite went from 117 to 122 passing with no other change.

**Three lessons, and they are the most valuable in this document.**

1. **A data-integrity bug with no consumer is invisible.** It becomes a correctness bug the moment a
   feature depends on it — and it presents as a failure in the *new* feature, which is a misleading
   place to start looking.

2. **"Zero results" and "wrong results" are different diagnostic signals.** Wrong results suggest a
   logic error. Zero results suggest something structural: a filter that excludes everything, a join
   that never matches, an empty candidate set. That distinction narrowed this bug quickly.

3. **Group the failures before reading any code.** Four failed and eight passed. Asking "what do the
   four have in common, and why are the eight fine?" localised the problem to receipts before a single
   line of the matching engine was re-read.

---

### 7.4 The nested transaction that would have failed — caught by reading

**What happened.** Nothing. This is the one problem in this list that never produced an error, because
it was caught before the code ran.

**The situation.** During the "no cuttings" rebuild, `createEntryFromLine` needed to call
`postDocument()` inside its own transaction. Before wiring the call, `post-document.js` was opened to
check its signature, which read:

```js
export async function postDocument(documentId, actor) {
  return prisma.$transaction(async (tx) => {
```

**Why that would have failed.** `postDocument` opens its own transaction unconditionally, on its own
connection. `createEntryFromLine` creates the draft `Document` inside *its* transaction, which has not
committed. By the isolation property of transactions, `postDocument`'s separate transaction cannot see
uncommitted work from another one.

So `SELECT * FROM "Document" WHERE id = ${documentId}` would have returned zero rows, and the call
would have failed with `404 Document not found` — for a document created microseconds earlier, in the
same request.

**Why that error would have been hard to debug.** The message names the wrong thing entirely. "Document
not found" points at a missing row, or a bad id, or a tenancy filter. It says nothing about transaction
isolation. Time would have gone into logging the id, checking the create call, and querying the table
by hand — all of which would have shown the document was fine.

**The fix.** The optional-transaction pattern (section 4.5), copied from `postReceipt`, which had solved
the identical problem on Day 4 for the identical reason.

**The lesson.** **When composing two functions that each manage their own transaction, check whether
they can nest before wiring them together.** The signature tells you: a function whose body starts with
`prisma.$transaction(...)` and takes no `tx` parameter cannot be called from inside another
transaction and see that transaction's work.

More generally: reading the function you are about to call, rather than only its name, is cheap. This
one cost thirty seconds and would have cost far more as a runtime failure.

---

### 7.5 ESLint rejected the BOM character

**What happened.** After writing `csv.js`, `npx eslint` failed:

```
C:\Projects\Ledgerline\backend\src\lib\banking\csv.js
  20:32  error  Irregular whitespace not allowed  no-irregular-whitespace
```

**Why it happened.** The BOM strip had been written with the literal character in a regex:

```js
const clean = text.replace(/^\uFEFF-as-a-literal-character/, '')...
```

The BOM *is* a whitespace character, and it is invisible. ESLint's `no-irregular-whitespace` rule
exists precisely to catch invisible whitespace in source code, because it is a classic source of bugs
that cannot be seen while reading.

**The irony worth noting:** the rule was doing exactly its job. An invisible character in a regex is
unreadable and unmaintainable — the next person cannot tell what the pattern matches.

**The fix.** Compare by character code instead of embedding the character:

```js
const noBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
const clean = noBom.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
```

**Why this is better than silencing the rule.** `0xfeff` is visible, greppable, and self-documenting.
An `eslint-disable` comment would have kept an invisible character in the source forever. When a linter
objects, the first question should be whether it has a point — here it did.

---

### 7.6 The working directory that kept resetting, and a stray `package.json`

**What happened.** Several commands failed with:

```
/usr/bin/bash: line 1: cd: backend: No such file or directory
```

**Why it happened.** Two shells were in use — Bash and PowerShell — each with its own working
directory, and they did not agree. A `cd backend` in one did not affect the other. Sometimes the shell
was already inside `backend`, so `cd backend` looked for `backend/backend`.

**The more serious consequence.** One `npm install multer` ran while the shell was at the repository
root rather than in `backend/`. npm found no `package.json` there and created one:

```json
{
  "dependencies": {
    "multer": "^2.2.0"
  }
}
```

along with a root `package-lock.json` and a root `node_modules/` containing 16 packages.

None of this was noticed at the time, because the *next* install (run correctly from `backend/`)
succeeded and the code worked. The junk sat in the repository as untracked files.

**How it was found.** Running `git status` while gathering the file list for this document. Three
unexpected untracked entries appeared at the repository root.

**The fix.** Verified the contents first — the root `package.json` contained only the accidental multer
dependency, and root `node_modules/` contained only multer and its 15 transitive dependencies — then
removed all three. The full test suite was re-run afterwards to confirm nothing depended on them: 122
passing.

**Two lessons.**

1. **Verify the working directory before any command that writes.** `pwd` costs nothing. An install in
   the wrong directory is silent — npm does not warn that it is creating a `package.json` where none
   existed.
2. **Run `git status` before committing, and read every line.** These files would have been committed
   otherwise, and a stray root `package.json` in a repository with a `backend/` and a `frontend/`
   directory is genuinely confusing for the next person — it looks like an intentional monorepo root.

---

### 7.7 Thirteen test files failed at once, and the code was fine

**What happened.** Late in the session, after the root cleanup, the suite was re-run to confirm nothing
had broken. Thirteen of eighteen files failed:

```
Test Files  13 failed | 5 passed (18)
     Tests  21 passed | 101 skipped (122)
```

with every failure showing:

```
PrismaClientKnownRequestError:
 ❯ Jr.handleRequestError src/generated/prisma/runtime/client.js:69:8286
```

pointing at the `TRUNCATE` in `resetDb()`.

**The first instinct was wrong.** The cleanup had just deleted files. The obvious hypothesis was that
deleting root `node_modules/` had broken something.

**Why that hypothesis was testable and false.** If a dependency were missing, the failure would be an
import error at module load — `ERR_MODULE_NOT_FOUND` — not a Prisma *request* error. A request error
means the client loaded fine and the failure happened when talking to the database.

Also telling: 5 files passed. Those were the pure unit tests (`money.test.js`, `posting-rules.test.js`,
and similar) — the ones that never touch the database. Every file that failed was a database test.

**The actual cause:**

```
failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine;
check if the path is correct and if the daemon is running
```

Docker Desktop had shut down at some point during the session. PostgreSQL runs in a container. There
was no database.

**The fix.** Start Docker Desktop, then:

```bash
docker compose up -d postgres
```

then re-run: 122 passing.

**Two lessons.**

1. **When a large number of tests fail simultaneously, suspect the environment before the code.** Code
   changes usually break a related cluster of tests. Everything failing at once points at something
   shared — the database, the network, a config file, a service.

2. **Let the failure *shape* narrow the cause before reading any code.** The split here was perfectly
   clean: every database test failed, every non-database test passed. That partition named the cause
   before a single application file was opened. The instinct to blame the most recent change is strong
   and frequently wrong.

---

## 8. Final understanding check

You should be able to answer these without looking at the code. If an answer does not come, the
referenced section is worth re-reading.

### On what we built

1. What is a bank reconciliation, and what are the three categories every genuine difference falls
   into?
2. Why does the system store a `BankAccount` row separately from the `Account` row it points at? What
   does each one represent?
3. Walk through the five statuses a `BankStatementLine` can hold. Which transition does
   `completeReconciliation` perform, and why does that transition matter for reversals?
4. What are the three resolution paths for an unmatched line, and which one posts to the ledger?
5. Why does `accountNoMasked` store `****4821` rather than the full account number? What would be lost
   by storing the full number, and what would be gained?

### On the matching algorithm

6. Why is amount a *hard gate* rather than a weighted component? What specific failure does that
   prevent, and what would a system that fuzzy-matched amounts hide?
7. Walk through the score for a statement credit of 10,000 dated 2026-01-05 whose description contains
   the matching receipt's document number, against a receipt posted the same day. Show each term.
8. Now the same line, but the receipt was posted two days earlier and the description contains nothing
   useful. What is the score, what status does the line get, and why is that the right outcome?
9. Explain the direction rule. Why does a statement **credit** match a journal **debit**? What would a
   matcher with the direction inverted look like from the outside, and which test catches it?
10. What is greedy bipartite assignment, and why is it needed *in addition* to scoring? Give a concrete
    example where scoring alone produces an invalid result.
11. Construct a case where greedy assignment produces a worse total than the optimal assignment. Then
    explain why shipping greedy anyway is defensible here.
12. Why is the tie check computed *before* greedy assignment rather than after? What would go wrong if
    it ran after?
13. Why does the reference pass use `Math.max` of its three signals rather than adding them?
14. Why does the candidate query use `LEFT JOIN` for `Document` and `Party` rather than an inner join?
    What would break with an inner join?

### On the accounting reasoning

15. Why is `Current Year Earnings` computed at render rather than stored in an account? What exactly
    goes wrong if it is omitted, and by how much?
16. What is the difference between a *period* report and a *point-in-time* report? Which SQL clause
    distinguishes them, and which of the six reports is which?
17. Why does `computeProfitAndLoss` subtract debits from credits for revenue accounts but credits from
    debits for expense accounts?
18. Why do the balance queries include entries with status `REVERSED` as well as `POSTED`? What would
    the bank balance be wrong by if `REVERSED` were excluded?
19. In the reconciliation summary, `difference = bankBalance − bookBalance`. If that number is
    negative, what does it mean in plain English?

### On security and correctness

20. There are two independent idempotency mechanisms on the statement import endpoint. Name both,
    explain what each protects against, and give a scenario where one helps and the other does not.
21. Why does `requestBody` passed to `runIdempotent` contain `fileSha256(csvContent)` rather than
    `csvContent` itself?
22. What is the `CHECK ("status" <> 'COMPLETED' OR "difference" = 0)` constraint, and why is it written
    as an `OR` rather than an `IF`? Which test proves it works, and how does that test bypass the
    application?
23. The same "a row cannot have both a debit and a credit" rule is enforced in three places. Name them,
    and explain what each one catches that the others do not.
24. Why does `manualMatchLine` *catch* a `P2002` error rather than checking first whether the journal
    line is already matched?
25. What does `.strict()` on a Zod schema do, and what class of vulnerability does it prevent? Give a
    concrete example request it would reject.
26. Why does `authorize('bank.reconcile')` run *before* the multer middleware in the import route?
27. Creating a bank adjustment requires `bank.reconcile`, not `invoice.post`. Why is that the right
    permission, and which seeded role can reconcile but not post invoices?

### On architecture

28. Why does `matchStatementLines` return decisions rather than writing them itself? What does that
    buy?
29. Explain the optional-transaction pattern. What exactly would have failed if `postDocument` had been
    called from inside `createEntryFromLine`'s transaction without it, and what error message would it
    have produced?
30. Why is `computeBookBalance` exported from the reconciliation service and imported by the reports
    route, rather than each having its own copy of the query?
31. Why does `BankStatementLine` carry a denormalised `bankAccountId` when its statement already knows
    it? What makes that denormalisation safe here?
32. Why does `rowHash` include the row index? What legitimate scenario breaks without it, and what does
    the unique constraint still protect against once the index is included?
33. Why is the RECON-8 guard placed in `reverseEntry()` rather than in the banking module?
34. Why did routing bank adjustments through `postDocument()` create the *need* for a new
    `cascadeReversal` branch, when the `postManualEntry` version needed none?

### On the request lifecycle

35. Trace `POST /bank-accounts/:id/statements` from the browser to the database. Name every middleware
    it passes through, what each does, and where the transaction begins and ends.
36. In that flow, why does `express.json({ limit: '1mb' })` not reject a 1.5 MB CSV upload?
37. Why is the audit row written in `res.on('finish')` rather than inside the import transaction? What
    would go wrong if it were written inside?
38. Why is the audit entry skipped when an import is a replay?
39. Trace what happens when `createEntryFromLine` is called for a statement debit of 1,130. Which
    account is debited, which is credited, and why that way round?
40. What does the bank adjustment inherit "for free" by going through `postDocument()` rather than
    `postManualEntry()`? List at least four things.

### On debugging

41. RECON-1 reported `autoMatched: 0` instead of 3, with no exception. What was the root cause, why had
    it gone unnoticed since Day 4, and which *other*, older feature was it silently degrading?
42. In that investigation, why was "zero matches" a more useful signal than "wrong matches" would have
    been?
43. `Cannot read properties of undefined (reading 'findMany')` appeared after a schema change. What
    was the actual cause, and why does the error message point at the wrong thing?
44. What two commands must be run after any change to `schema.prisma`, and why is the second one so
    easy to forget?
45. Thirteen test files failed at once while five passed. What distinguished the five, and what did
    that partition immediately tell you about the cause?
46. ESLint rejected a line in `csv.js` for irregular whitespace. Why was the linter right, and why was
    `eslint-disable` the wrong fix?

### On the plan

47. Which Day 5 objectives are complete, and which are deliberately deferred? Which single outstanding
    item is the largest risk to the plan's 20:00 checkpoint?
48. Two shortcuts were built and then replaced with plan-exact implementations. Name both, and for
    each: what the shortcut gave up, and what the rebuild bought.
49. The plan says create-from-line posts through "*the same engine*". What concretely would have been
    lost by keeping the `postManualEntry` shortcut, even though the ledger result was identical?
50. What new deployment requirement did this session introduce, and why should it be verified before
    Day 7 rather than during it?

---

## Quick reference

**Start the database** (required for tests and for running the API)
```bash
docker compose up -d postgres
```

**Run the backend**
```bash
npm run dev --prefix backend
```

**Run the tests** (this truncates the development database)
```bash
npm test --prefix backend
```

**After any change to `schema.prisma` — both commands, always**
```bash
npx prisma migrate dev --name <descriptive_name>
```
```bash
npx prisma generate
```

**Create a migration without applying it** (needed when hand-writing `CHECK` constraints)
```bash
npx prisma migrate dev --name <name> --create-only
```

**Lint**
```bash
npm run lint --prefix backend
```

**The security grep the plan asks for before submitting** — should return only generated code
```bash
grep -rn "queryRawUnsafe" backend/src
```

### The endpoints added this session

| Method | Path | Permission |
|---|---|---|
| `GET` | `/api/v1/bank-accounts` | `report.view` |
| `POST` | `/api/v1/bank-accounts` | `org.manage` |
| `POST` | `/api/v1/bank-accounts/:id/statements` | `bank.reconcile` |
| `GET` | `/api/v1/statements/:id/lines` | `report.view` |
| `POST` | `/api/v1/lines/:id/match` | `bank.reconcile` |
| `POST` | `/api/v1/lines/:id/create-entry` | `bank.reconcile` |
| `POST` | `/api/v1/lines/:id/ignore` | `bank.reconcile` |
| `POST` | `/api/v1/reconciliations` | `bank.reconcile` |
| `POST` | `/api/v1/reconciliations/:id/complete` | `bank.reconcile` |
| `GET` | `/api/v1/reports/profit-loss` | `report.view` |
| `GET` | `/api/v1/reports/balance-sheet` | `report.view` |
| `GET` | `/api/v1/reports/bank-reconciliation` | `report.view` |

### The matching formula

```
score = 0.55 × amountScore      hard gate: 0 unless exact to the paisa
                                AND on the opposite side of the entry
      + 0.25 × dateScore        same day 1.0 · ±1 day 0.9 · ≤3 days 0.7
                                ≤7 days 0.4 · beyond that 0
      + 0.20 × referenceScore   max of: doc_no appears in description → 1.0
                                        reference_no exact match      → 1.0
                                        party name trigram similarity → 0..1

score ≥ 0.90  and not ambiguous  →  MATCHED    (matchedBy AUTO)
score ≥ 0.90  but tied top-2     →  SUGGESTED
0.45 < score < 0.90              →  SUGGESTED
no candidate above 0.45          →  UNMATCHED
```

### The RECON test map

| Test | Proves |
|---|---|
| RECON-1 | Import auto-matches 3 of 4; the bank charge stays unmatched |
| RECON-2 | Re-importing the same file returns the original statement, imports nothing |
| RECON-3 | Two identical same-day amounts both stay *suggested* — no coin-flip auto-match |
| RECON-4 | Manual match sets `matchedBy=manual`, confidence 1.0, and writes an audit row |
| RECON-5 | Create-entry posts through `postDocument()` and auto-matches the new line |
| RECON-6 | A statement credit never matches a journal credit — direction is enforced |
| RECON-7 | Completing with a nonzero difference fails at the service **and** at the database |
| RECON-8 | Reversal un-matches an open line; a reconciled line blocks the reversal entirely |
