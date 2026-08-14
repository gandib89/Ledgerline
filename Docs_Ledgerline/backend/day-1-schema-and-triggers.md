# Day 1 — Database Schema and Triggers

A plain-language walkthrough of everything we put into the database on Day 1, why each piece
exists, and how it maps back to [ledgerline-7-day-plan_1.md](../ledgerline-7-day-plan_1.md).

Read this before Day 2. Every feature from here on writes into these tables.

---

## 1. The one idea behind all of it

> "The database enforces accounting, not the application."
> — plan §1, line 51

Most applications put their rules in the code: a function checks something, and if the check is
wrong or someone forgets to call it, bad data gets saved. This project does the opposite for the
things that matter most. The rules that make accounting _accounting_ live inside PostgreSQL itself.

That means: even if we write a bug in the posting engine on Day 3, even if someone connects to the
database directly with `psql` and tries to force bad data in, the database says no.

Three rules are enforced this way (plan §5, lines 453–500):

1. A journal entry must balance — debits equal credits.
2. A posted journal entry can never be changed or deleted.
3. Nothing can be posted into a closed accounting period.

We built all three today, and proved each one by hand.

---

## 2. What is double-entry bookkeeping?

Skip this section if you already know it, but everything below depends on it.

Every financial event is recorded twice — once as a **debit**, once as a **credit** — and the two
sides must be equal. Selling something for Rs. 100 on credit:

| Account             |      Debit |     Credit |
| ------------------- | ---------: | ---------: |
| Accounts Receivable |     100.00 |            |
| Sales Revenue       |            |     100.00 |
|                     | **100.00** | **100.00** |

The customer owes us 100 (an asset went up), and we earned 100 (revenue went up). The totals match.
That matching is not a convention we could choose to skip — it is the mechanism that makes errors
visible. If the two columns of the whole ledger stop being equal, something is wrong, and you know
it immediately.

In our schema this becomes two tables:

- `JournalEntry` — the header. One per financial event. "Invoice INV-0001, dated 20 July."
- `JournalLine` — the rows underneath it. Each names one account and one amount, in either the
  debit or the credit column.

Everything else in the entire application — invoices, receipts, bank reconciliation, all six
reports — exists either to _produce_ these rows or to _read_ them.

---

## 3. The tables we built

Fourteen tables, in six groups. This is exactly the Day 1 list from the plan (§11, line 1409).

### Group 1 — Identity and tenancy

| Table          | What it holds                                 |
| -------------- | --------------------------------------------- |
| `User`         | A person. Email + password hash.              |
| `Organization` | A company (a "tenant").                       |
| `Membership`   | Links a user to an organization, with a role. |

**Why `User` has no `organizationId`:** one accountant may serve several companies. If users lived
inside a company, that same human would need a separate account per client. The plan calls this "a
mistake that is essentially unfixable later" (§5, line 320).

**Why `Membership` exists at all:** it is the join between the two. A user can belong to many
organizations, with a _different role in each_ — Owner at their own company, Viewer at a client's.
That role belongs to the membership, not to the user.

**The most important line of authorization in the system** (plan §5, line 331) will be built on this
table on Day 2:

> read the `X-Organization-Id` header → look up an **active membership** for this user in that
> organization → attach `{organizationId, permissions}` to the request.

Never trust the header on its own. Anyone can send any header. The membership lookup is what turns a
claim ("I'm working in org 42") into a fact.

```prisma
@@unique([userId, organizationId])
```

One membership row per user per organization — no duplicates, no ambiguity about which role applies.

### Group 2 — Roles and permissions (RBAC)

| Table            | What it holds                                                 |
| ---------------- | ------------------------------------------------------------- |
| `Role`           | Owner, Accountant, Clerk, Viewer.                             |
| `Permission`     | A code like `invoice.post`, `journal.post`, `bank.reconcile`. |
| `RolePermission` | Which permissions each role has (many-to-many).               |

Permissions are _strings in a table_, not values hard-coded in the application. That means the
permission set can grow without a code change, and the whole matrix can be seeded as data.

The plan's default matrix (§5, line 340) is worth internalizing, because it is a real financial
control, not just access control:

| Permission       | Owner | Accountant | Clerk | Viewer |
| ---------------- | :---: | :--------: | :---: | :----: |
| `invoice.create` |   ✓   |     ✓      |   ✓   |        |
| `invoice.post`   |   ✓   |     ✓      |       |        |
| `payment.create` |   ✓   |     ✓      |   ✓   |        |
| `journal.post`   |   ✓   |     ✓      |       |        |
| `bank.reconcile` |   ✓   |     ✓      |       |        |
| `report.view`    |   ✓   |     ✓      |   ✓   |   ✓    |
| `audit.view`     |   ✓   |     ✓      |       |        |
| `org.manage`     |   ✓   |            |       |        |

Notice the gap: a Clerk can _create_ an invoice but cannot _post_ it. That is **separation of
duties** — the person who prepares a document is not the person who commits it to the books. It is a
standard anti-fraud control in real accounting departments.

### Group 3 — Fiscal structure

| Table              | What it holds                                                       |
| ------------------ | ------------------------------------------------------------------- |
| `FiscalYear`       | A financial year, e.g. label `"2082/83"`, with start and end dates. |
| `AccountingPeriod` | A month inside that year, and whether it is open.                   |

Accounting does not run on a continuous timeline — it runs in **buckets**. At the end of each month
the accountant reconciles everything, produces reports, and then _closes_ the period. After that, no
new entries may land in it.

Why closing matters: suppose you filed a VAT return based on July's numbers. If someone can post a
backdated entry into July next month, your filed return silently becomes wrong, and every report you
ever printed becomes untrustworthy. Closing the period freezes history. Late transactions get posted
into the current open period instead — which is exactly how real accounting handles them.

Dates are stored in AD (Gregorian) only. The Nepali fiscal year is just a **label string**
(`"2082/83"`), never a converted date. Date conversion is explicitly out of scope (CLAUDE.md).

### Group 4 — Chart of Accounts

| Table     | What it holds                                        |
| --------- | ---------------------------------------------------- |
| `Account` | Every account the ledger can post to, with its type. |
| `TaxCode` | VAT rates as data, e.g. `13%` stored as `0.1300`.    |

The **Chart of Accounts** is simply the list of buckets money can move between: Cash, Accounts
Receivable, Sales Revenue, Rent Expense, and so on. The plan seeds 28 of them (§5, line 365).

Each account has a `type` — one of five, fixed by accounting itself:

```
ASSET      what we own          (Cash, Accounts Receivable, Equipment)
LIABILITY  what we owe          (Accounts Payable, VAT Payable)
EQUITY     the owner's stake    (Capital, Retained Earnings)
REVENUE    what we earned       (Sales)
EXPENSE    what we spent        (Rent, Salaries)
```

This classification is not decoration — it _is_ the reports. Trial Balance, Profit & Loss and
Balance Sheet are all the same query (`SUM(debit) - SUM(credit)` over `JournalLine`) grouped by
account type. There is no separate "reports" data model, and no stored totals anywhere. CLAUDE.md:
"every report is a pure read of `journal_lines`, never a stored/cached total."

**`isControlAccount`** deserves attention. Accounts Receivable is a _control account_: its balance
must always equal the sum of all unpaid customer invoices. If someone posts a manual journal
straight into AR, those two numbers drift apart and no receivables report is trustworthy again. So
control accounts are blocked from manual entry — only the posting engine may touch them.

**`TaxCode.rate` is `Decimal(5,4)`** — a rate is data, never a number typed into the code. The plan
is blunt about this (§5, line 439): "Hard-coding 0.13 anywhere in the codebase is an instant
deduction."

### Group 5 — The ledger itself ★

| Table          | What it holds                        |
| -------------- | ------------------------------------ |
| `JournalEntry` | The header of one financial event.   |
| `JournalLine`  | The debit/credit rows underneath it. |

```prisma
model JournalLine {
  debit   Decimal @db.Decimal(18, 4)
  credit  Decimal @db.Decimal(18, 4)
  ...
}
```

**Two columns, not one signed amount.** We could have stored `amount: +100` and `amount: -100`. We
don't, because separate debit and credit columns are the accounting convention, they make the
balance check a plain `SUM(debit) = SUM(credit)`, and they make every report read naturally.

**`Decimal(18, 4)`, never a floating-point number.** This is the same reason `money.js` exists.
Binary floating point cannot represent most decimal fractions exactly:

```js
0.1 + 0.2; // 0.30000000000000004
```

Harmless in a game score; fatal in a ledger that must balance to exactly `0.0000`. `Decimal` stores
exact digits instead. Four decimal places rather than two leaves room for intermediate values (tax
splits, per-line discounts) before the final rounding to two.

**Why there is no `status: draft | posted` field:** a journal entry in this system is never a draft.
It is created already-posted, inside a single transaction, by Day 3's `postDocument()`. Drafts live
on the _document_ (the invoice), not on the ledger entry. That is what makes immutability (trigger 2)
simple to state: if a journal entry exists at all, it is final.

### Group 6 — Supporting tables

| Table            | What it holds                                        |
| ---------------- | ---------------------------------------------------- |
| `AuditLog`       | Who did what, when, from where, in which request.    |
| `IdempotencyKey` | Prevents a retried request from being applied twice. |

**Idempotency** is worth understanding properly, because it is a genuinely fintech-specific problem.

A user clicks "Record Payment". The request reaches the server, the payment is written — and then
the network drops before the response comes back. The browser retries. Without protection, that
retry creates a **second payment**. The customer's invoice is now over-paid, and the ledger says
something that never happened.

The fix: the client generates a unique `Idempotency-Key` once, and sends it with the request. The
server stores that key **in the same database transaction as the write it protects**:

```prisma
@@unique([organizationId, key])
```

When the retry arrives with the same key, the insert violates that unique constraint. The middleware
catches the violation and replays the _stored original response_ instead of writing again.

CLAUDE.md is specific that this lives in **Postgres, not Redis**. The reason is atomicity: the key
and the payment must commit or fail together. If the key were in Redis and the payment in Postgres,
a crash between the two writes leaves them disagreeing — and you are back to double payments.

**The audit log** is written **after** the transaction commits, never inside it. If audit logging
were part of the financial transaction, a failure to log would roll back a perfectly valid payment.
Logging is important; it is not more important than the money.

`AuditLog.userId` is intentionally _not_ a foreign key — audit rows must survive even if the user
record they mention is later removed. `before` and `after` are `Json` snapshots, which will power the
diff viewer on Day 6.

---

## 4. The three triggers

This is the part that cannot be expressed in the Prisma schema language, which is why the plan
budgets two hours for it and says to do it "Day 1, first thing, before anything depends on it"
(§17, line 1903).

The workflow (plan §5, line 313):

```bash
npx prisma migrate dev --name init --create-only   # write the SQL, do NOT run it
# hand-edit prisma/migrations/<timestamp>_init/migration.sql, appending the triggers
npx prisma migrate dev                              # now run it
```

`--create-only` is the whole trick. It lets us open the generated SQL file and add things Prisma
cannot generate.

### Trigger 1 — every entry must balance

```sql
CREATE CONSTRAINT TRIGGER journal_entry_balanced
  AFTER INSERT ON "JournalEntry"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION assert_journal_entry_balanced();
```

The function sums all lines belonging to the entry and raises an exception if the two totals differ.

**The key word is `DEFERRED`,** and it solves a real problem. Lines are inserted one at a time. After
inserting the first line (debit 100), the entry is unbalanced — debits 100, credits 0. That is
normal and temporary. A normal trigger would fire right there and reject a perfectly good entry.

A **deferred constraint trigger** does not fire per-statement. It waits until `COMMIT`, when the
transaction is finished, and checks once. If the entry is unbalanced at that moment, the entire
transaction is rolled back.

This is also why the plan forbids SQLite for tests (§10, line 1162): SQLite has no deferred
constraint triggers, no `NUMERIC`, no `SELECT … FOR UPDATE`. Testing against SQLite would test a
database that does not enforce any of this.

### Trigger 2 — posted entries are immutable

```sql
CREATE TRIGGER journal_entry_immutable
  BEFORE UPDATE OR DELETE ON "JournalEntry"
  FOR EACH ROW EXECUTE FUNCTION block_journal_mutation();

CREATE TRIGGER journal_line_immutable
  BEFORE UPDATE OR DELETE ON "JournalLine"
  FOR EACH ROW EXECUTE FUNCTION block_journal_mutation();
```

The function does nothing but raise an exception. There is no condition to check — every attempt to
change or delete a journal entry or line is illegal, always.

**Why an editable audit trail is not an audit trail.** If a posted entry could be quietly corrected,
then no report from any past date could be trusted, because someone might have changed history after
it was published. Immutability means last month's Trial Balance prints the same numbers today as it
did last month.

Corrections still happen, of course — but as **new entries**: a reversal (an equal-and-opposite
entry) or a credit note. The original stays in the ledger forever, and the correction is visible
next to it. That is the accounting answer to "undo", and it is why CLAUDE.md says nothing financial
is ever `UPDATE`d or `DELETE`d, and why every financial foreign key is `ON DELETE RESTRICT`.

Both triggers use `BEFORE`, so the row is never even touched.

### Trigger 3 — the period lock

```sql
CREATE TRIGGER journal_entry_period_open
  BEFORE INSERT ON "JournalEntry"
  FOR EACH ROW EXECUTE FUNCTION assert_period_open();
```

The function joins the target period to its fiscal year and raises if the period is closed, if the
fiscal year is closed, or if the period does not exist — three separate messages, so that when it
fires you know _which_ rule blocked you rather than just "rejected".

This is the database half of the month-end close described in Group 3 above.

---

## 5. How we proved they work

A trigger you have not tested is a guarantee you are _assuming_. All three were verified by hand
against the real Postgres running in Docker.

| Trigger      | What we tried                                                    | What happened                                                                                                                                                                           |
| ------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Balance      | Inserted an entry with debit 100 / credit 90, then `COMMIT`      | Both inserts succeeded, then **COMMIT was rejected**: `Journal entry je1 is unbalanced: debit 100.0000 <> credit 90.0000`. `SELECT count(*)` afterwards returned **0** — full rollback. |
| Immutability | Inserted a valid balanced entry, then `UPDATE`d its entry number | **Blocked**: `Journal entries are immutable. Post a reversal entry instead.` The row still read `JE-0002` afterwards.                                                                   |
| Period lock  | Closed period `p1`, then tried to insert an entry into it        | **Blocked**: `Cannot post: accounting period p1 is closed`.                                                                                                                             |

The balance test is the interesting one: the two `INSERT`s reported success, and only `COMMIT`
failed. That is the deferral working exactly as designed.

Confirming the triggers actually exist in the database:

```bash
docker exec ledgerline-postgres-1 psql -U ledgerline -d ledgerline \
  -c "SELECT tgname, tgdeferrable FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname;"
```

```
          tgname           | tgdeferrable
---------------------------+--------------
 journal_entry_balanced    | t              <- deferred, as intended
 journal_entry_immutable   | f
 journal_entry_period_open | f
 journal_line_immutable    | f
```

---

## 6. Where we simplified, and what still needs doing

We built CLAUDE.md's Day 1 table list in full. But our version of several tables is _thinner_ than
plan §5 describes, and two things in the plan are genuinely missing. Writing them down now so they
are decisions, not accidents.

### Deliberately deferred (columns the later days will need)

| Table          | Not yet added                                                                                            | Needed by                                  |
| -------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `User`         | `fullName`, `isActive`, `lastLoginAt`                                                                    | Day 2 (auth)                               |
| `Organization` | `slug`, `panVatNo`, `baseCurrency`, `status: active \| read_only`                                        | Day 2–3 (posting guard checks `read_only`) |
| `Membership`   | `isOwner`, `status` enum                                                                                 | Day 2                                      |
| `Role`         | `organizationId NULL` + `isSystem` — plan clones system role templates per organization; ours are global | Day 2                                      |
| `Account`      | `parentId` (account tree), `allowManualEntry`, `controlType`                                             | Day 3 (manual JV validator)                |
| `TaxCode`      | `type` enum, `outputAccountId`, `inputAccountId`                                                         | Day 3                                      |
| `JournalEntry` | `fiscalYearId`, `sourceType` / `sourceId`, `reversalOfId`, `postedAt`, `postedById`                      | Day 3–4 (reversals)                        |
| `JournalLine`  | `organizationId`, `partyId`, `UNIQUE(entryId, lineNumber)`                                               | Day 3–4                                    |

Tables not built at all yet — `parties`, `document_series`, `documents`, `document_lines`,
`payment_allocations`, `bank_accounts`, `bank_statements`, `bank_statement_lines`, `reconciliations`
— belong to Days 3–5 and are correctly absent.

### Three gaps — found, then closed in follow-up migrations

All three were caught by comparing our schema against plan §5 line-by-line. The first two were
fixed in `prisma/migrations/20260811153532_journal_line_balance_and_sign_check/migration.sql`; the
third in `prisma/migrations/20260811164822_add_missing_indexes/migration.sql`.

**a) The sign constraint on `JournalLine` was missing.** Plan §5, line 455:

```sql
ALTER TABLE "JournalLine" ADD CONSTRAINT jl_sign_check
  CHECK (debit >= 0 AND credit >= 0
         AND NOT (debit > 0 AND credit > 0)
         AND (debit > 0 OR credit > 0));
```

A line must be a debit _or_ a credit — never both, never negative, never zero on both sides. Before
this fix, nothing stopped a line with debit 50 _and_ credit 50, which would balance arithmetically
while being meaningless. **Fixed** — the constraint is live; verified with
`pg_get_constraintdef` in psql.

**b) The balance trigger lived on `JournalEntry`; the plan puts it on `JournalLine`.**

It fired `AFTER INSERT ON "JournalEntry"` — that covers the normal path completely, since an entry
and its lines are always written together in one transaction. But if a line were ever added to an
_existing_ entry in a later transaction, no trigger would have fired and the entry could silently
go unbalanced. The plan's version (`AFTER INSERT OR UPDATE OR DELETE ON "JournalLine"`) has no such
hole. **Fixed** — `journal_entry_balanced` was dropped, `journal_line_balanced` created in its
place, confirmed still `DEFERRABLE`/deferred via `pg_trigger`.

Both fixes went in a **new migration**, not an edit to `init` — migrations are append-only, and
`init` had already been applied. See §10 below for how the first attempt at this migration actually
shipped empty, and why.

**c) Three indexes plan §5 calls for were missing.** Prisma does not automatically index a foreign
key column the way it does a primary key — only `@unique`/`@@unique` fields get an index for free.
Every plain `organizationId`/`journalEntryId`/`accountId` scalar field was, until this fix, unindexed
unless it happened to be the leftmost column of an existing `@@unique`.

Added:
```prisma
// Account
@@index([organizationId, type])

// JournalEntry
@@index([organizationId, entryDate])

// JournalLine
@@index([journalEntryId])
@@index([accountId])
```

The `JournalLine.journalEntryId` index matters most of the three: the balance trigger (§4, Trigger 1)
runs `SELECT SUM(debit), SUM(credit) FROM "JournalLine" WHERE "journalEntryId" = ...` on **every
insert**, deferred to commit. Without an index on that column, every single journal entry ever
posted would force a full table scan of `JournalLine` at commit time — a cost that grows with the
size of the ledger, on the single hottest write path in the whole application.

Not every index plan §5 lists was added — several reference columns this schema deferred entirely
(`JournalLine.organizationId`, `JournalLine.partyId`, `JournalEntry.status`, see the deferred-columns
table above). Indexing a column that doesn't exist yet isn't possible; those arrive with their
columns on Day 3–4.

---

## 7. Commands you will use constantly

```bash
docker compose up -d                 # start Postgres + Redis (first thing every session)
docker compose ps                    # both should say "healthy"

cd backend
npx prisma validate                  # is schema.prisma syntactically valid?
npx prisma migrate dev --create-only # generate migration SQL without running it
npx prisma migrate dev               # apply migrations + regenerate the client
npx prisma studio                    # browse the database in a GUI

docker exec -it ledgerline-postgres-1 psql -U ledgerline -d ledgerline   # raw SQL
```

Note: the containers do not start automatically with your machine. `P1001: Can't reach database
server` almost always means Docker Desktop restarted and the containers are down.

---

## 8. What you should be able to explain

If someone asks you about this part of the project, you should be able to answer these without
looking anything up:

1. **Why is there a `Membership` table instead of a `role` column on `User`?**
   Because one person can work in several organizations with a different role in each, and users
   must live outside any tenant.

2. **How does the system stop an unbalanced journal entry?**
   A deferred constraint trigger in Postgres sums debits and credits at `COMMIT` and rolls back the
   whole transaction if they differ. Not a check in JavaScript — application code physically cannot
   write an unbalanced entry.

3. **Why is the balance check deferred rather than immediate?**
   Lines are inserted one at a time, so the entry is legitimately unbalanced mid-transaction. The
   check has to happen once, at the end.

4. **How do you correct a mistake in a posted entry?**
   You don't edit it — a trigger physically prevents that. You post a reversal or a credit note.
   The original stays visible forever, which is what makes the audit trail trustworthy.

5. **Why `Decimal(18,4)` instead of a normal number?**
   Floating point cannot represent decimal fractions exactly (`0.1 + 0.2 !== 0.3`), and a ledger has
   to balance to exactly `0.0000`. All arithmetic goes through `money.js`, and an ESLint rule blocks
   raw `+` / `parseFloat` / `Number()` inside `accounting/` and `reporting/`.

6. **What stops a retried payment request from charging twice?**
   An `Idempotency-Key` stored in Postgres under `UNIQUE(organizationId, key)`, written in the same
   transaction as the payment. The retry hits the constraint and gets the original response replayed.

7. **Why can't these tests run on SQLite?**
   SQLite has no deferred constraint triggers, no `NUMERIC`, no `SELECT … FOR UPDATE`. Every
   guarantee described above would simply not exist.

---

## 9. Files this touched

| File                                                            | What it is                                                              |
| --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [backend/prisma/schema.prisma](../backend/prisma/schema.prisma) | The 14 models                                                           |
| `backend/prisma/migrations/20260811144919_init/migration.sql`   | Generated tables + the three hand-written triggers at the bottom        |
| [backend/src/lib/money.js](../backend/src/lib/money.js)         | `dec / add / sub / mul / round2 / eq / isZero`                          |
| [backend/eslint.config.js](../backend/eslint.config.js)         | The rule banning raw money arithmetic in `accounting/` and `reporting/` |
| [docker-compose.yml](../docker-compose.yml)                     | Postgres 16 + Redis 7 with healthchecks                                 |

Plan sections to re-read: **§5** (database design, lines 303–532) and **§6** (the posting engine,
which consumes all of this on Day 3).

---

## 10. Every error we hit today, and why

None of these were exotic. Writing them down because each one taught something about the tools,
not just about accounting — and because the same mistakes are easy to repeat on Day 2 otherwise.

### 1. `Cannot find package '@prisma/client/runtime/library'`

**Symptom first, and it was misleading.** Running `npm test` reported:

```
FAIL src/lib/money.test.js
Error: No test suite found in file money.test.js
```

That message points at the _test file_, as if `describe`/`it` were missing. Running Vitest directly
(`npx vitest run src/lib/money.test.js`) surfaced the real error underneath: `money.js` itself
couldn't be imported, so the test file that imports it couldn't load either.

**Root cause:** `money.js` imported `Decimal` from `@prisma/client/runtime/library` — a subpath that
existed in older Prisma versions. This project has `@prisma/client@7.9.1` installed, and Prisma 7
restructured its package exports; that path no longer exists.

**How we found the fix, instead of guessing:** read the installed package's own `exports` map
(`cat node_modules/@prisma/client/package.json`) to see which subpaths Prisma 7 actually defines,
found `./runtime/client` listed, then confirmed `Decimal` is actually exported from it before
committing to the change:

```bash
node -e "import('@prisma/client/runtime/client').then(m => console.log(Object.keys(m).filter(k => /decimal/i.test(k))))"
# → [ 'Decimal' ]
```

**Fix:** one line in `money.js` — `runtime/library` → `runtime/client`.

**Lesson:** a failure message points at where the failure was _noticed_, not necessarily where it
_happened_. Run the failing thing directly, with maximum verbosity, before trusting the first error
you see.

### 2. `prisma.config.ts` generated as TypeScript

`npx prisma init` scaffolds `prisma.config.ts` by default in Prisma 7. This project is plain
JavaScript, no TypeScript, by deliberate choice (CLAUDE.md). Checked the generated file's actual
contents first — no type annotations, generics, or TS-only syntax, just `import`/`export`/a function
call — so the fix was a rename, `prisma.config.ts` → `prisma.config.js`, with zero code changes.

**Lesson:** don't assume a `.ts` extension means real TypeScript is required. Check what's actually
in the file before deciding it's a blocker.

### 3. `P1000: Authentication failed... 'ledgerline'` (first occurrence — stale volume)

After writing `docker-compose.yml` and updating `DATABASE_URL` to match, `npx prisma db pull` still
failed authentication.

**Root cause:** a Postgres data volume (`ledgerline_postgres_data`) already existed from an earlier
`docker compose up`, initialized with different (or default) credentials. Postgres only applies
`POSTGRES_USER`/`POSTGRES_PASSWORD` the **first time** it initializes an empty data directory — once
a volume has data, new environment variables in `docker-compose.yml` are silently ignored.

**Fix:**

```bash
docker compose down
docker volume rm ledgerline_postgres_data
docker compose up -d
```

Fresh volume, credentials applied correctly on the new init.

**Lesson:** Docker named volumes persist independently of `docker-compose.yml` edits. Changing
`environment:` values doesn't retroactively apply to a volume that already has data in it.

### 4. `P1000: Authentication failed... 'ledgerline'` (second occurrence — port conflict)

Same error, immediately after the volume was rewritten fresh. This one took more digging, because
Postgres _inside_ the container was provably fine — `docker exec ... psql "postgresql://ledgerline:ledgerline@localhost:5432/ledgerline"` succeeded from inside the container itself, over TCP, with the password. So the database wasn't the problem.

**Root cause:** a **native Postgres 16 Windows service** (`postgresql-x64-16`), installed separately
on the host, was already listening on port 5432. Docker's port mapping (`5432:5432`) never got a
chance — Windows routed the connection to the native service first, which had entirely different
credentials.

**How we found it**, not guessed it:

```powershell
Get-NetTCPConnection -LocalPort 5432 | Select OwningProcess
Get-Process -Id <pid>              # → "postgres"
Get-Service | Where-Object Name -like '*postgres*'   # → postgresql-x64-16, Running
```

**Fix:** stopped the native service (required an elevated/admin PowerShell — the sandboxed terminal
couldn't do it):

```powershell
Stop-Service postgresql-x64-16 -Force
Set-Service postgresql-x64-16 -StartupType Manual
```

**Lesson:** "connection refused/auth failed" on a port you _think_ you own doesn't prove your
service is broken — something else can already be squatting on that port. Check what's actually
listening before debugging the thing you expect to be listening.

### 5. `P4001: The introspected database was empty`

Looked alarming — "could not create any models" — but this one wasn't a bug at all. It's Prisma's
expected response from `db pull` when it connects successfully to a database that legitimately has
no tables yet (which was true at that point — no migration had been run). Once the auth problems
above were fixed, this was proof the connection worked, not a new problem.

**Lesson:** not every red error block is a failure to fix. Read what it actually says.

### 6. PowerShell mangled a multi-line `psql` command

Tried to pass SQL inline to `docker exec ... psql -c "..."` with escaped double quotes
(`\"Organization\"`) for Postgres identifiers. PowerShell's quoting rules don't match bash's, and the
backslashes were passed through literally instead of being interpreted, producing
`psql: warning: extra command-line argument` and a syntax error.

**Fix:** stopped fighting shell-escaping entirely — wrote the SQL to a `.sql` file with the `Write`
tool (real double quotes, no escaping needed) and piped it in:

```bash
docker exec -i ledgerline-postgres-1 psql -U ledgerline -d ledgerline < path/to/file.sql
```

**Lesson:** cross-shell quoting (bash tool vs. PowerShell vs. `psql`'s own parsing) is a common
source of noise errors unrelated to the actual task. For anything beyond a one-liner, a file beats
an inline escaped string.

### 7. Prisma schema validation errors (three separate rounds)

While building the schema incrementally, `npx prisma validate` caught three real mistakes, each the
same category of error — a relation declared on one side but not the other:

- `Membership.role` added without `Role.memberships` existing yet →
  `The relation field 'memberships' ... is missing an opposite relation field`
- `Organization` back-references (`accounts`, `taxCodes`, `journalEntries`, etc.) added before the
  models they pointed at (`Account`, `TaxCode`, `JournalEntry`) existed →
  `Type "JournalEntry" is neither a built-in type, nor refers to another model`
- `journalLines JournalLine[]` accidentally landed on the `TaxCode` model instead of `Account` —
  valid Prisma syntax, wrong model, caught by reading the file rather than by an error message.

**Fix, every time:** read the actual current state of `schema.prisma`, find exactly which side of
the relation was missing or misplaced, add only that piece.

**Lesson:** Prisma relations are declared on both models — adding one side and forgetting the other
is the single most common schema-editing mistake, and `npx prisma validate` catches every instance
of it immediately. Run it after every model addition, not just at the end.

### 8. `P1001: Can't reach database server` after a break

Came back to the project after a gap; `npx prisma migrate dev` failed with a connection error.

**Root cause:** Docker Desktop doesn't keep containers running across a restart of Docker Desktop
itself (or the host machine) unless configured to. `docker compose ps` showed nothing running.

**Fix:** `docker compose up -d` — data survived in the named volume, containers just needed
restarting.

**Lesson, now written into this doc's own command list (§7):** `docker compose up -d` is the first
command of every session, before any backend work, every time.

### 9. A migration got applied empty — the SQL was never added to the file

When closing the two schema gaps (§6), the instructed workflow was: generate an empty migration with
`--create-only`, paste the trigger/constraint SQL into it, _then_ run `prisma migrate dev` to apply
it. The apply step ran before the SQL was actually added to the file — so
`20260811152458_journal_line_constraints` was recorded in `_prisma_migrations` as applied, but its
`migration.sql` still read `-- This is an empty migration.`

**Why this couldn't just be "fixed" by editing that file:** Prisma tracks each migration's content
by checksum once it's been applied. Editing an already-applied migration's SQL creates drift between
what Prisma thinks ran and what's actually in the file — exactly the "never edit a migration that's
already been pushed" rule from CLAUDE.md's Git conventions, and it applies just as much to a local
solo migration as to a shared one.

**Fix:** left the empty migration exactly as it was (an accurate, if empty, record of what
happened), and created a **new** migration
(`20260811153532_journal_line_balance_and_sign_check`) with the real SQL, applied that instead.

**Lesson:** with `--create-only`, the SQL has to be in the file _before_ the follow-up
`prisma migrate dev` runs. If the gap between "generate" and "apply" isn't checked, it's easy to
apply an empty shell and only notice later, by querying the database directly to confirm what's
actually enforced rather than trusting that the intended edit happened.

---

## 11. Prisma schema syntax, explained

Section 3 covered _why_ each table exists. This section covers _how to read the syntax_ — every
symbol that appears in `schema.prisma`, explained once, plus what's worth noticing model by model.

### The legend — every symbol, explained once

```prisma
model User {
  id           String   @id @default(uuid())
  email        String   @unique
  passwordHash String
  createdAt    DateTime @default(now())

  memberships  Membership[]
}
```

Reading it piece by piece:

- **`model User { ... }`** — defines one database table. Prisma turns this into `CREATE TABLE
"User" (...)` when you migrate. The name is singular and capitalized by convention
  (`User`, not `users`).

- **`id           String`** — a field named `id`, of type `String`. Left side is the column name,
  right side is its type. Other types used in this schema: `Int`, `Boolean`, `DateTime`, `Decimal`,
  `Json`.

- **`@id`** — marks this field as the table's primary key. Every model needs exactly one.

- **`@default(uuid())`** — if no value is given on insert, generate a random UUID automatically.
  This project uses UUIDs everywhere instead of auto-incrementing numbers — plan §5 line 307: "
  sequential integers leak volume and invite IDOR probing" (i.e., guessing `id=1`, `id=2` to explore
  other tenants' data).

- **`@default(now())`** — same idea, but the default value is "the current timestamp." Used on every
  `createdAt`.

- **`@unique`** — no two rows in the table may share the same value in this column. Attached
  directly after a single field, like `email String @unique`.

- **`String?`** (the `?`) — this field is **optional**, can be `NULL` in the database. Without the
  `?`, Prisma requires a value on every insert (`NOT NULL` in SQL). Used for things like
  `JournalEntry.description` — not every entry needs a note — and `AuditLog.userId`, which must be
  allowed to stay populated even after the user it names is gone.

- **`Membership[]`** (the `[]`) — this is **not a real database column**. It declares "many
  `Membership` rows can point back at this one `User`" — the _reverse_ side of a relationship,
  purely for Prisma Client's convenience (`user.memberships` in JS code later). It generates no SQL
  at all; only the "forward" side (below) becomes a real foreign key column.

- **`@relation(fields: [...], references: [...], onDelete: ...)`** — this is the side that _does_
  become a real column and a real foreign key constraint. Example from `Membership`:

  ```prisma
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Restrict)
  ```

  Two lines working together: `organizationId String` is the actual foreign-key column stored in
  the table. `organization Organization @relation(...)` tells Prisma _which_ column
  (`organizationId`) points at _which_ other table's column (`Organization.id`) — and generates the
  friendly `membership.organization` accessor in code. `onDelete: Restrict` is CLAUDE.md's rule made
  concrete: attempting to delete an `Organization` while a `Membership` still references it is
  rejected by the database, not just discouraged in application code.

- **`@@unique([fieldA, fieldB])`** — the double-`@` means this applies to the _whole model_, not one
  field (a plain `@unique` only ever covers a single column). This declares a **composite**
  uniqueness rule: the _combination_ is unique, individual values can repeat. `@@unique([userId,
organizationId])` on `Membership` allows the same user in many orgs and the same org to have many
  users — just not the same pairing twice.

- **`@@index([fieldA, fieldB])`** — also whole-model, but doesn't restrict anything; it just tells
  Postgres to build a lookup structure over these columns for faster queries. Used on `AuditLog`
  (`organizationId, createdAt`) because the audit screen (Day 6) will always filter by organization
  and sort by time — a query pattern worth optimizing for from the start.

- **`enum AccountType { ASSET LIABILITY EQUITY REVENUE EXPENSE }`** — declares a fixed, named set of
  allowed string values, enforced by Postgres itself (a real SQL `ENUM` type). A field typed
  `AccountType` can only ever hold one of these five words — inserting `"CASH"` would be rejected at
  the database level, not just caught by application validation.

- **`Decimal @db.Decimal(18, 4)`** — `Decimal` is the Prisma-level type (maps to `Prisma.Decimal` in
  JS, the object `money.js` wraps). `@db.Decimal(18, 4)` is a **native type override** — it tells
  Postgres specifically to use `NUMERIC(18, 4)` (18 total digits, 4 after the decimal point) rather
  than some other precision. Without it, Prisma would still pick _some_ numeric type, but not
  necessarily this exact precision — CLAUDE.md requires this exact one everywhere money is stored.

- **`Json`** / **`Json?`** — stores arbitrary structured data (Postgres's native `JSONB` type).
  Used for `AuditLog.before`/`after` — snapshots of a record's state that don't fit a fixed set of
  columns, and don't need to be queried by individual field.

### Model by model — what's syntactically worth noticing

**`User`** — nothing unusual; the simplest model in the schema. No `organizationId` at all, which is
itself a syntax choice worth noticing (see §3, Group 1): the absence of a foreign key here is
deliberate.

**`Organization`** — six `[]` reverse-relation fields (`memberships`, `accounts`, `taxCodes`, etc.),
none of them real columns. Every other tenant-scoped table in the schema has one of these pointing
back at `Organization`, because everything in this app hangs off a tenant.

**`Membership`** — the first model with more than one `@relation` (three: `user`, `organization`,
`role`) and a composite `@@unique`. This is the shape every future join table follows: a foreign key
column _and_ a `@relation` line, per relationship, plus `@@unique` over the natural key combination.

**`Role` / `Permission` / `RolePermission`** — a classic **many-to-many via an explicit join model**.
Prisma can auto-generate a hidden join table for simple many-to-many relations, but this schema
spells `RolePermission` out explicitly instead, because it needs its own identity and could later
carry extra columns (e.g. `grantedBy`) — an implicit join table couldn't.

**`FiscalYear` / `AccountingPeriod`** — a **self-contained hierarchy**: one `FiscalYear` has many
`AccountingPeriod` rows (`periods AccountingPeriod[]`), each period's `@relation` points back up to
its parent year. Notice `AccountingPeriod` has no direct `organizationId` — it reaches its
organization indirectly, through `fiscalYear.organizationId`. That's a modeling choice (avoiding a
duplicate/possibly-inconsistent copy of the same fact), not an oversight.

**`AccountType` (enum) / `Account`** — the only `enum` in the schema so far. `type AccountType` on
`Account` is a plain field like any other, just constrained to those five values.

**`TaxCode`** — the only model using `@db.Decimal(5, 4)` instead of `(18, 4)` — a smaller range is
correct here because a tax _rate_ (`0.1300`) never needs 18 digits of headroom the way a money
_amount_ does.

**`JournalEntry` / `JournalLine`** — the pair with the most relations pointing _at_ other things
(`JournalEntry` → `Organization`, → `AccountingPeriod`; `JournalLine` → `JournalEntry`, →
`Account`), and the only two models using `Decimal(18, 4)` for real money columns. `JournalLine` has
no `[]` field of its own — nothing has a one-to-many relationship pointing _at_ a line; it's always
the "many" side, never the "one" side, of every relation it's in.

**`AuditLog`** — the one model where a relation field is deliberately **not** a `@relation` foreign
key: `userId String?` is a plain optional string, not linked to `User` at all. Syntactically that's
just "a field with no `@relation` line" — but the _absence_ is the deliberate part, explained in §3.

**`IdempotencyKey`** — syntactically unremarkable (same shape as `TaxCode`/`Account`), but its
`@@unique([organizationId, key])` is doing real work — it's not just a lookup optimization, it's the
actual mechanism that makes a retried request safe (§3, Group 6).

---

## 12. Every model, with its actual code

§11 explained the syntax in the abstract. This section is the reference version: the real code for
each of the 14 models, exactly as it appears in `schema.prisma`, each followed by what its specific
fields mean.

### `User`

```prisma
model User {
  id           String   @id @default(uuid())
  email        String   @unique
  passwordHash String
  createdAt    DateTime @default(now())

  memberships Membership[]
}
```

`id` — random UUID, primary key. `email` — must be unique across the _entire_ table (not per
organization — a person's email identifies them globally, since one human can belong to several
organizations). `passwordHash` — never the raw password; Day 2 will hash it with Argon2id before it
ever reaches this column. `createdAt` — stamped automatically on insert. `memberships` — the reverse
side of the relation declared over in `Membership`; lets code write `user.memberships` later, not a
real column.

### `Organization`

```prisma
model Organization {
  id        String   @id @default(uuid())
  name      String
  isActive  Boolean  @default(true)
  createdAt DateTime @default(now())

  memberships Membership[]
  accounts    Account[]
  taxCodes    TaxCode[]
  fiscalYears FiscalYear[]
  journalEntries JournalEntry[]
  auditLogs       AuditLog[]
  idempotencyKeys IdempotencyKey[]
}
```

`isActive` — the plan calls this `status: active | read_only` (§5 line 323); this project's Day 1
version simplifies it to a boolean, deferred to a richer enum later if needed (see §6's deferred-
columns table). The six `[]` fields below it are every table in the schema that hangs off a tenant —
none of them are real columns, they only exist so `organization.accounts`, `organization.journalEntries`,
etc. work in application code later.

### `Membership`

```prisma
model Membership {
  id             String   @id @default(uuid())
  userId         String
  organizationId String
  roleId         String
  isActive       Boolean  @default(true)
  createdAt      DateTime @default(now())

  user         User         @relation(fields: [userId], references: [id], onDelete: Restrict)
  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Restrict)
  role         Role         @relation(fields: [roleId], references: [id], onDelete: Restrict)

  @@unique([userId, organizationId])
}
```

Three real foreign-key columns (`userId`, `organizationId`, `roleId`), each paired with a
`@relation` line that names which table and column it points at. `@@unique([userId,
organizationId])` is the rule that makes this table meaningful: one row per user _per organization_
— a user can have many memberships (one per org they belong to), but never two roles in the _same_
org at once. `isActive` is what Day 2's tenant-resolution check reads — CLAUDE.md: "look up an
**active membership**," not just any membership row.

### `Role`, `Permission`, `RolePermission`

```prisma
model Role {
  id   String @id @default(uuid())
  name String @unique

  rolePermissions RolePermission[]
  memberships     Membership[]
}

model Permission {
  id   String @id @default(uuid())
  code String @unique

  rolePermissions RolePermission[]
}

model RolePermission {
  id           String @id @default(uuid())
  roleId       String
  permissionId String

  role       Role       @relation(fields: [roleId], references: [id], onDelete: Restrict)
  permission Permission @relation(fields: [permissionId], references: [id], onDelete: Restrict)

  @@unique([roleId, permissionId])
}
```

`Role.name` holds values like `"Owner"`, `"Accountant"`. `Permission.code` holds strings like
`"invoice.post"` — deliberately a free-form unique string, not an `enum`, because the permission set
is expected to grow over time (unlike `AccountType`, which is fixed forever). `RolePermission` is
the join table wiring the two together many-to-many: its own `id`, plus the two foreign keys, plus
`@@unique([roleId, permissionId])` so the same permission can't be granted to the same role twice.

### `FiscalYear`, `AccountingPeriod`

```prisma
model FiscalYear {
  id             String   @id @default(uuid())
  organizationId String
  label          String
  startDate      DateTime
  endDate        DateTime
  isClosed       Boolean  @default(false)

  organization Organization       @relation(fields: [organizationId], references: [id], onDelete: Restrict)
  periods      AccountingPeriod[]

  @@unique([organizationId, label])
}

model AccountingPeriod {
  id           String   @id @default(uuid())
  fiscalYearId String
  label        String
  startDate    DateTime
  endDate      DateTime
  isOpen       Boolean  @default(true)

  fiscalYear FiscalYear @relation(fields: [fiscalYearId], references: [id], onDelete: Restrict)
  journalEntries JournalEntry[]

  @@unique([fiscalYearId, label])
}
```

`FiscalYear.label` holds a string like `"2082/83"` — never converted to a Bikram Sambat date, exactly
per CLAUDE.md's scope cut. `startDate`/`endDate` are real AD dates, used for range checks.
`AccountingPeriod.isOpen` is what Trigger 3 reads at insert time; `FiscalYear.isClosed` is the
second check in that same trigger — a period can only accept postings if _both_ it and its parent
year are open. `@@unique([organizationId, label])` / `@@unique([fiscalYearId, label])` stop
duplicate year or period labels within their own scope.

### `AccountType` (enum) and `Account`

```prisma
enum AccountType {
  ASSET
  LIABILITY
  EQUITY
  REVENUE
  EXPENSE
}

model Account {
  id               String      @id @default(uuid())
  organizationId   String
  code             String
  name             String
  type             AccountType
  isControlAccount Boolean     @default(false)
  isBankAccount    Boolean     @default(false)
  isActive         Boolean     @default(true)
  createdAt        DateTime    @default(now())

  organization Organization  @relation(fields: [organizationId], references: [id], onDelete: Restrict)
  journalLines JournalLine[]

  @@unique([organizationId, code])
}
```

`code` is the short account number (`"1000"`, `"4100"`) shown in the Chart of Accounts;
`@@unique([organizationId, code])` allows two different organizations to both use code `"1000"`, just
not the same organization twice. `type` can only ever hold one of the five enum values above —
Postgres itself rejects anything else. `isControlAccount` and `isBankAccount` are the two flags that
later code checks before allowing an action (block manual entry; allow bank reconciliation).

### `TaxCode`

```prisma
model TaxCode {
  id             String  @id @default(uuid())
  organizationId String
  code           String
  name           String
  rate           Decimal @db.Decimal(5, 4)
  isActive       Boolean @default(true)

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Restrict)

  @@unique([organizationId, code])
}
```

`rate` is a `Decimal`, same reasoning as money — a tax rate must never drift due to floating point.
`@db.Decimal(5, 4)` means up to 5 total digits, 4 after the decimal point — enough for `1.0000`
(100%) down to `0.0001` (0.01%), which comfortably covers any real-world VAT/tax percentage.

### `JournalEntry`, `JournalLine` ★

```prisma
model JournalEntry {
  id             String   @id @default(uuid())
  organizationId String
  periodId       String
  entryNumber    String
  documentType   String
  entryDate      DateTime
  description    String?
  createdAt      DateTime @default(now())

  organization Organization     @relation(fields: [organizationId], references: [id], onDelete: Restrict)
  period       AccountingPeriod @relation(fields: [periodId], references: [id], onDelete: Restrict)
  lines        JournalLine[]

  @@unique([organizationId, entryNumber])
}

model JournalLine {
  id             String  @id @default(uuid())
  journalEntryId String
  accountId      String
  debit          Decimal @db.Decimal(18, 4)
  credit         Decimal @db.Decimal(18, 4)
  description    String?
  lineNumber     Int

  journalEntry JournalEntry @relation(fields: [journalEntryId], references: [id], onDelete: Restrict)
  account      Account      @relation(fields: [accountId], references: [id], onDelete: Restrict)
}
```

`entryNumber` is the human-facing document number (`"JE-0001"`); `@@unique([organizationId,
entryNumber])` guarantees no two entries in the same org ever share a number. `documentType` is a
plain string (`"invoice"`, `"manual"`, etc.) that Day 3's `POSTING_RULES` will dispatch on — left as
`String` rather than an `enum` because new document types (credit note, bank charge) get added
through the week. `description` is the only optional (`?`) field on the entry.

On `JournalLine`: `debit`/`credit` are the two `Decimal(18, 4)` columns that Trigger 1 sums to check
balance, and that Trigger sign-check (§6, §10) constrains to "one or the other, never both, never
neither." `lineNumber` orders the lines within one entry for display. Notice `JournalLine` has no
`[]` field pointing _at_ it from anywhere else — it's always the child, never the parent, of any
relationship in this schema.

### `AuditLog`

```prisma
model AuditLog {
  id             String   @id @default(uuid())
  organizationId String
  userId         String?
  action         String
  entityType     String
  entityId       String
  before         Json?
  after          Json?
  ipAddress      String?
  requestId      String?
  createdAt      DateTime @default(now())

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Restrict)

  @@index([organizationId, createdAt])
}
```

`userId String?` — deliberately a plain optional string, **not** a `@relation` to `User`. If it were
a real foreign key, deleting a user would either be blocked forever by their own audit history, or
require a cascade that destroys audit history — neither is acceptable. `entityType`/`entityId`
identify _what_ changed (e.g. `"Invoice"`, `"a1b2..."`) without a real foreign key either, since an
audit log has to be able to reference literally any table in the schema. `before`/`after` are
`Json?` snapshots for the Day 6 diff viewer. `@@index([organizationId, createdAt])` — not a
uniqueness rule, just a performance hint: the audit screen will always filter by org and sort by
time, so Postgres gets a ready-made lookup structure for exactly that pattern.

### `IdempotencyKey`

```prisma
model IdempotencyKey {
  id             String   @id @default(uuid())
  organizationId String
  key            String
  endpoint       String
  responseStatus Int
  responseBody   Json
  createdAt      DateTime @default(now())

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Restrict)

  @@unique([organizationId, key])
}
```

`key` is the client-generated UUID sent in the `Idempotency-Key` header. `responseStatus` /
`responseBody` store the _original_ response so a retry can be replayed verbatim instead of
re-executed. `@@unique([organizationId, key])` is the entire mechanism: a second insert with the
same key hits this constraint, the middleware catches the violation, and returns the stored response
instead of writing anything new.

---

## 13. Entity-relationship diagram

Every `@relation` from §12, drawn as one picture. Notation: `||` means "exactly one",
`o{` means "zero or many" — so `Organization ||--o{ Account` reads "one Organization has zero or
many Accounts."

```mermaid
erDiagram
    User ||--o{ Membership : "has"
    Organization ||--o{ Membership : "has"
    Role ||--o{ Membership : "assigned via"

    Role ||--o{ RolePermission : "has"
    Permission ||--o{ RolePermission : "has"

    Organization ||--o{ FiscalYear : "has"
    FiscalYear ||--o{ AccountingPeriod : "has"

    Organization ||--o{ Account : "has"
    Organization ||--o{ TaxCode : "has"

    Organization ||--o{ JournalEntry : "has"
    AccountingPeriod ||--o{ JournalEntry : "contains"
    JournalEntry ||--o{ JournalLine : "has"
    Account ||--o{ JournalLine : "posted to"

    Organization ||--o{ AuditLog : "has"
    Organization ||--o{ IdempotencyKey : "has"
```

Two things worth reading off this shape:

**`Organization` is the hub.** Seven arrows point out from it — every tenant-scoped table reaches
back to `Organization` directly or (for `AccountingPeriod`, `JournalLine`) indirectly through
another table. This is the multi-tenancy design made visible: there is no table in this schema that
floats free of an organization except `User`, `Role`, and `Permission`.

**The ledger is the deepest chain.** `Organization → AccountingPeriod → JournalEntry → JournalLine`
is four levels deep, with `JournalLine` also reaching sideways to `Account`. Every other table in
the schema is at most two hops from `Organization`. That extra depth is the ledger's job: a line
has to know its entry, its entry has to know its period (for the lock check), and its period has to
know its fiscal year (for the same check) — the chain triggers 1 and 3 walk at commit/insert time.

`User`, `Role`, and `Permission` are the only three tables **not** anchored to `Organization` —
visible here as the only entities with no incoming arrow from it. That matches §3's explanation:
users and roles are shared concepts, not tenant-owned data.

---

## 14. Prisma from zero

Everything above assumes you already know roughly what Prisma is. This section doesn't — start
here if any of the previous sections used a term you had to guess at.

### What problem does Prisma solve?

Without it, talking to a database from Node.js code looks like this:

```js
const result = await client.query(
  'SELECT id, email FROM "User" WHERE id = $1',
  [userId]
);
const user = result.rows[0]; // a plain object, no guarantee it has the fields you expect
```

You write SQL as strings, and JavaScript has no idea what shape the result will be until it runs.
Typo a column name and you find out at runtime, maybe in production.

Prisma is an **ORM** — Object-Relational Mapper. You describe your tables once, in
`schema.prisma`, and Prisma generates:

1. The actual SQL that creates those tables (**migrations**).
2. A JavaScript library (**Prisma Client**) with a method for every table, so instead of writing SQL
   strings you write:
   ```js
   const user = await prisma.user.findUnique({ where: { id: userId } });
   ```
   `user` now has real, predictable fields (`id`, `email`, `createdAt`, ...) because Prisma generated
   this function *from the same schema* that created the table. The two can't drift apart silently.

That's the whole pitch: **one source of truth** (`schema.prisma`) drives both the database structure
and the code that talks to it.

### The three pieces, and how they relate

```
schema.prisma  --(prisma migrate dev)-->  real tables in Postgres
schema.prisma  --(prisma generate)     -->  Prisma Client (JS code you import)
```

- **`schema.prisma`** — a text file you hand-write. Not SQL, not JavaScript — Prisma's own schema
  language. This is the one thing you edit directly.
- **Migrations** — SQL files Prisma generates *from* your schema changes, stored in
  `prisma/migrations/<timestamp>_<name>/migration.sql`. Each one is a permanent, ordered record of
  "what changed and when." Prisma tracks which migrations have run against your database in a
  special table it creates for itself, `_prisma_migrations`.
- **Prisma Client** — generated JavaScript code (this project outputs it to
  `backend/src/generated/prisma/`, per the `generator client { output = ... }` block at the top of
  `schema.prisma`). You never hand-write this folder; every time the schema changes, you regenerate
  it. It's what your actual application code imports and calls.

Nothing in this project's code has used Prisma Client yet — Day 1 only built the schema and the
migrations. The first real usage arrives on Day 2, when auth/tenancy code starts reading and writing
users and memberships.

### The two commands you'll run constantly, and what each one actually does

**`npx prisma migrate dev`** — the one you use while actively developing:
1. Compares your current `schema.prisma` against what's already been applied to the database.
2. If they differ, generates a new migration SQL file for the difference.
3. Runs that SQL against your database.
4. Regenerates Prisma Client so your code sees the new shape immediately.

One command, four things. This is why every schema change we made today ended with running it.

**`npx prisma generate`** — does *only* step 4 above (regenerate the client). Useful if you've pulled
someone else's migration and just need the client rebuilt, without changing the database yourself.

Two more you've already used today, worth naming explicitly:

- **`npx prisma validate`** — checks `schema.prisma` for syntax errors *without* touching the
  database at all. Fast, safe, no side effects — run it after every edit, before migrating.
- **`npx prisma migrate dev --create-only`** — does steps 1–2 above (write the migration file) but
  skips 3 and 4 (doesn't run it, doesn't regenerate). This is the trick that let us hand-add the
  trigger SQL — Prisma's schema language has no way to express a trigger, so we generate the
  surrounding table SQL, then manually write the trigger into the same file, *then* apply it.

### What a migration file actually is

Open any file under `prisma/migrations/*/migration.sql` — it's plain SQL, nothing Prisma-specific
about the syntax itself:

```sql
-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    ...
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);
```

Prisma's real trick isn't generating this SQL — it's **tracking which ones have already run**, so
that `migrate dev` on a teammate's machine (or a fresh `docker compose up` database) applies only
the migrations that database is missing, in the correct order, and refuses to let you edit one that
already ran without you explicitly acknowledging it. That's the exact mechanism behind §10's error
9 above: editing an applied migration's file doesn't silently "just work," because Prisma checksums
each file the moment it applies it.

### Reading `schema.prisma`'s two top blocks

Every `schema.prisma` file starts with two blocks that aren't models — worth knowing what they do,
since they're easy to skim past:

```prisma
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "postgresql"
}
```

- **`generator client { ... }`** — configures *what to generate* and *where*. `provider =
  "prisma-client"` says "generate the JS client library." `output` says which folder to put it in.
  (Older Prisma versions defaulted to generating inside `node_modules/@prisma/client` instead of a
  visible project folder — this project's version generates to a real folder you can see,
  `src/generated/prisma/`, which is why `money.js` imports `Decimal` from
  `@prisma/client/runtime/client` rather than that generated folder — the low-level pieces like
  `Decimal` still ship from the `@prisma/client` package itself, only the generated *models* land in
  your custom output path.)
- **`datasource db { ... }`** — which database engine, and where to find the connection string.
  `provider = "postgresql"` tells Prisma which SQL dialect to generate. The actual connection string
  isn't in this file at all — it's read from `DATABASE_URL` via `prisma.config.js` (see §10, error 2,
  for why that config file is `.js` and not the default `.ts`).

### What Prisma Client actually looks like, once you use it

None of this project's code calls Prisma Client yet, but here's a preview of Day 2, so the shape
isn't a surprise. Every model in `schema.prisma` becomes a lowercase property with a matching set of
methods:

```js
import { PrismaClient } from '../generated/prisma/client.js';
const prisma = new PrismaClient();

// Create
const user = await prisma.user.create({
  data: { email: 'a@b.com', passwordHash: '...' },
});

// Read one
const found = await prisma.user.findUnique({ where: { id: user.id } });

// Read many, with a filter, and pull in a relation
const orgs = await prisma.organization.findMany({
  where: { isActive: true },
  include: { memberships: true }, // follows the @relation, fetches related rows too
});

// Update
await prisma.account.update({
  where: { id: accountId },
  data: { isActive: false },
});
```

`model User { ... }` in the schema → `prisma.user` in code (model name, first letter lowercased).
Every field you defined becomes a property on the returned object, with the type you declared —
that's the "one source of truth" payoff from the top of this section made concrete.

One thing to know now, because it will matter immediately once real code starts using this: Prisma
Client happily lets you write `await prisma.journalLine.update(...)` even though the immutability
trigger (§4, Trigger 2) will reject it at the database level. Prisma doesn't know about
hand-written triggers — it only knows what's expressible in `schema.prisma`. The trigger is a second,
independent layer of defense that catches what application code (yours, or a bug in it) might
otherwise get wrong. That's the whole thesis from §1 again, now visible at the boundary between
Prisma and raw Postgres.

### Where Prisma's schema language reaches its limit

Everything in `schema.prisma` — models, fields, relations, `enum`, `@@unique`, `@@index` — compiles
down to ordinary `CREATE TABLE` / `CREATE INDEX` SQL. Prisma's schema language has **no syntax at
all** for:

- Triggers (`CREATE TRIGGER`, `CREATE CONSTRAINT TRIGGER`)
- Arbitrary `CHECK` constraints spanning custom logic (Prisma 5+ supports simple single-column
  `@db` type constraints, but not the multi-column boolean logic `jl_sign_check` needed)
- Stored functions/procedures (`CREATE FUNCTION ... LANGUAGE plpgsql`)

This isn't a bug or a missing feature to wait for — it's a deliberate boundary. Prisma's schema
language covers the common 90% (tables, columns, relations, indexes) declaratively; anything beyond
that, you drop into real SQL inside a migration file, same as §4 did for all three triggers. Knowing
where that boundary sits is what made `--create-only` the right tool today rather than something to
work around.

### Quick glossary

| Term | Meaning |
|---|---|
| **ORM** | Object-Relational Mapper — code that turns table rows into objects and back, so you write `prisma.user.create(...)` instead of `INSERT INTO ...` |
| **Schema** | `schema.prisma` — the one file you hand-edit; describes every table |
| **Migration** | A generated, timestamped SQL file recording one schema change; permanent, never edited after it's applied |
| **Migrate** | The act of running a migration's SQL against a real database |
| **Generate** | Rebuilding Prisma Client (the JS library) from the current schema |
| **Introspect** (`db pull`) | The reverse direction — point Prisma at an existing database and have it *write* `schema.prisma` for you. Not used in this project; we always go schema → database, never database → schema |
| **Seed** | A script (`prisma/seed.js` or similar) that inserts starter data — not built yet, it's a remaining Day 1 task |
| **Client** | The generated JS code your application actually imports and calls |
