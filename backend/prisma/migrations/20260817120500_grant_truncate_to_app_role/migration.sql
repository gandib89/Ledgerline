-- TRUNCATE is a separate Postgres privilege from DELETE. The test suite's
-- resetDb() helpers TRUNCATE between tests through the app's own connection
-- (src/db/client.js, now ledgerline_app) — a real 24/7 production deployment
-- would carve test-only truncation out to a separate role, but this
-- project's test and runtime connections are the same one on purpose (see
-- README).
GRANT TRUNCATE ON ALL TABLES IN SCHEMA public TO ledgerline_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT TRUNCATE ON TABLES TO ledgerline_app;
