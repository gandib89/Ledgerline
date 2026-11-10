-- Accounts Payable permissions (spec #2). Roles/permissions are global
-- reference data that only prisma/seed.js fills, and `migrate deploy` doesn't
-- run the seed, so already-deployed databases get the AP grants here.
-- Idempotent: safe to re-run. Roles are looked up by name; a role that doesn't
-- exist gets nothing (this does not create roles on a never-seeded database).
-- Keep in sync with ROLE_PERMISSIONS in prisma/seed.js.

INSERT INTO "Permission" ("id", "code")
SELECT gen_random_uuid()::text, p.code
FROM (VALUES ('bill.create'), ('bill.post'), ('supplier_payment.create')) AS p(code)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "RolePermission" ("id", "roleId", "permissionId")
SELECT gen_random_uuid()::text, r."id", p."id"
FROM (VALUES
  ('Owner', 'bill.create'),
  ('Owner', 'bill.post'),
  ('Owner', 'supplier_payment.create'),
  ('Accountant', 'bill.create'),
  ('Accountant', 'bill.post'),
  ('Accountant', 'supplier_payment.create'),
  ('Clerk', 'bill.create')
) AS g(role_name, code)
JOIN "Role" r ON r."name" = g.role_name
JOIN "Permission" p ON p."code" = g.code
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
