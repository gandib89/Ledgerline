import { prisma } from '../../db/client.js';

// Roles, permissions and their grants are global reference data (not tenant
// data). `prisma migrate deploy` doesn't run the seed, so the server calls
// ensureReferenceData() at boot; the seed and the test helpers call it too.
// This matrix (plan §5) is the single source of truth for who gets what.
const ALL_PERMISSIONS = [
  'invoice.create',
  'invoice.post',
  'payment.create',
  'journal.post',
  'bank.reconcile',
  'report.view',
  'audit.view',
  'org.manage',
  'bill.create',
  'bill.post',
  'supplier_payment.create',
];

export const ROLE_PERMISSIONS = {
  Owner: ALL_PERMISSIONS, // everything
  Accountant: ALL_PERMISSIONS.filter((code) => code !== 'org.manage'),
  Clerk: ['invoice.create', 'payment.create', 'report.view', 'bill.create'],
  Viewer: ['report.view'],
};

// Create-only: missing roles, permissions and grants are added; existing rows
// (and any extra grants an operator made) are left alone. skipDuplicates is
// INSERT ... ON CONFLICT DO NOTHING, so concurrent instances booting together
// cannot collide.
export async function ensureReferenceData(db = prisma) {
  const roleNames = Object.keys(ROLE_PERMISSIONS);
  const codes = [...new Set(Object.values(ROLE_PERMISSIONS).flat())];

  await db.role.createMany({ data: roleNames.map((name) => ({ name })), skipDuplicates: true });
  await db.permission.createMany({ data: codes.map((code) => ({ code })), skipDuplicates: true });

  const [roles, permissions] = await Promise.all([
    db.role.findMany({ where: { name: { in: roleNames } } }),
    db.permission.findMany({ where: { code: { in: codes } } }),
  ]);
  const roleId = new Map(roles.map((r) => [r.name, r.id]));
  const permissionId = new Map(permissions.map((p) => [p.code, p.id]));

  await db.rolePermission.createMany({
    data: Object.entries(ROLE_PERMISSIONS).flatMap(([name, grants]) =>
      grants.map((code) => ({ roleId: roleId.get(name), permissionId: permissionId.get(code) }))),
    skipDuplicates: true,
  });
}
