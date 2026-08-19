# Ledgerline

[![CI](https://github.com/gandib89/Ledgerline/actions/workflows/ci.yml/badge.svg)](https://github.com/gandib89/Ledgerline/actions/workflows/ci.yml)

## Tenant isolation: app-layer only, and why

Every tenant-scoped query is isolated by a Prisma client extension
([`tenant-extension.js`](backend/src/db/tenant-extension.js)) that reads the
active organization from request context (set by `resolveTenant` middleware)
and injects it into the query's `where`/`data` automatically. This is the
*only* isolation layer currently enforced — every route, service function,
and test in this codebase goes through it, and it's what ISO-1..5 and the
INV-2/INV-4 property tests exercise.

**Postgres Row-Level Security was attempted as a second, database-level
layer** (defense against a raw-SQL mistake or a bug in a future service that
bypasses the extension entirely) and deliberately rolled back. What's still
in the repo from that attempt: a migration
([`20260817120000_enable_row_level_security`](backend/prisma/migrations/20260817120000_enable_row_level_security/migration.sql))
that creates a least-privileged `ledgerline_app` Postgres role and enables
RLS policies (`organizationId = current_setting('app.current_org_id')`) on
every tenant-scoped table, plus a follow-up
([`20260817120500_grant_truncate_to_app_role`](backend/prisma/migrations/20260817120500_grant_truncate_to_app_role/migration.sql))
granting it `TRUNCATE`. Both are real, tested SQL and harmless to leave
applied — the app still connects as the table owner (`DATABASE_URL`), which
bypasses RLS by default, so the policies exist but are currently inert.

**Why it didn't make it into the app layer.** RLS needs
`app.current_org_id` set via `SET LOCAL`/`set_config(..., true)` on the
exact Postgres connection a query runs on — safe only inside a transaction,
since a plain session-level `SET` would leak across requests on a pooled
connection. That means every standalone read (the majority of the API — any
plain `GET`) needed to open its own short transaction, and the ~10 places
that already open a transaction for a write needed that transaction's
connection reliably reachable from deep inside nested service calls
(`tx.model.op()` calls several functions removed from where the transaction
was opened).

The blocker: request context (`AsyncLocalStorage`), which this project
already relies on for the app-layer extension and which works reliably for
a plain top-level call, does **not** survive into the `$allOperations` hook
Prisma invokes for calls made via an interactive transaction's `tx` object —
confirmed empirically, not by inference. A context flag set immediately
before dispatching a nested `tx.model.op()` call was invisible inside the
hook that same call triggered, regardless of whether it was set via
`AsyncLocalStorage.run()` or `.enterWith()`. Working around that (marking
the `args` object itself, and proxy-wrapping `tx` so every nested call
picked up the marker transparently) fixed the *recursive-transaction*
failure mode it caused, but a second, not-fully-diagnosed failure surfaced
under the full suite — `resolveTenant` firing twice for a single request in
some flows — that a proper fix needs more time than was prudent to keep
spending on a stretch goal blind.

**The tradeoff, stated plainly:** app-layer-only isolation means a
raw SQL query or a future bug that skips the extension has no second gate.
Real RLS closes that gap but costs a transaction (instead of an autocommit
query) on every standalone read, and — in this ORM's interactive-transaction
implementation specifically — needs a synchronous, non-ALS signal threaded
through nested calls rather than the request-context pattern the rest of
this codebase uses. That's a bigger, riskier change than "add a migration,"
which is why the plan treats it as conditional rather than required.