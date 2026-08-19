-- Row-Level Security: a second, database-level isolation layer behind the
-- existing Prisma extension (src/db/tenant-extension.js). That extension is
-- app-code — a raw SQL slip or a bug in a future service bypasses it
-- entirely. RLS makes cross-tenant access impossible even then, because
-- Postgres itself refuses the row, regardless of which query produced it.
--
-- Table owners bypass RLS by default (even with RLS enabled), so the app
-- must run as a role that is NOT the owner. `ledgerline` (the migration/seed
-- role) stays the owner and keeps bypassing RLS — it never has a tenant
-- context to filter by. The app's runtime connection (APP_DATABASE_URL)
-- uses this new least-privilege role instead.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'ledgerline_app') THEN
    CREATE ROLE ledgerline_app WITH LOGIN PASSWORD 'ledgerline_app';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE ledgerline TO ledgerline_app;
GRANT USAGE ON SCHEMA public TO ledgerline_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ledgerline_app;
-- Future migrations add tables without a follow-up grant.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ledgerline_app;

-- One policy shape, every tenant-scoped table: the row is visible/writable
-- only when its organizationId matches the session's app.current_org_id.
-- `current_setting(..., true)` (missing_ok) returns NULL instead of raising
-- when unset, so an un-scoped connection sees zero rows rather than erroring
-- — fails closed, not open.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'Membership', 'FiscalYear', 'Account', 'TaxCode', 'Party',
    'JournalEntry', 'JournalLine', 'AuditLog', 'IdempotencyKey',
    'DocumentSeries', 'EntrySeries', 'Document', 'PaymentAllocation',
    'BankAccount', 'BankStatement', 'BankStatementLine', 'Reconciliation'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("organizationId" = current_setting(''app.current_org_id'', true)) WITH CHECK ("organizationId" = current_setting(''app.current_org_id'', true))',
      t
    );
  END LOOP;
END
$$;
