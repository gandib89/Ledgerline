import request from 'supertest';
import { prisma } from '../db/client.js';

// TRUNCATE, not DELETE: the immutability trigger blocks row-level DELETE on
// JournalEntry/JournalLine, but TRUNCATE doesn't fire row-level triggers.
export async function resetDb() {
  await prisma.$executeRawUnsafe(`
    TRUNCATE
      "JournalLine", "JournalEntry", "Account", "TaxCode", "Party",
      "AccountingPeriod", "FiscalYear", "Membership", "RolePermission",
      "Role", "Permission", "Organization", "RefreshToken", "User",
      "AuditLog", "IdempotencyKey"
    CASCADE
  `);
}

const ROLE_PERMISSIONS = {
  Owner: [
    'invoice.create', 'invoice.post', 'payment.create', 'journal.post',
    'bank.reconcile', 'report.view', 'audit.view', 'org.manage',
  ],
  Accountant: [
    'invoice.create', 'invoice.post', 'payment.create', 'journal.post',
    'bank.reconcile', 'report.view', 'audit.view',
  ],
  Clerk: ['invoice.create', 'payment.create', 'report.view'],
  Viewer: ['report.view'],
};

/** Roles and permissions are global reference data, not tenant data. */
export async function seedRoles() {
  const roles = {};
  for (const [name, codes] of Object.entries(ROLE_PERMISSIONS)) {
    const role = await prisma.role.create({ data: { name } });
    roles[name] = role;
    for (const code of codes) {
      const permission = await prisma.permission.upsert({
        where: { code },
        update: {},
        create: { code },
      });
      await prisma.rolePermission.create({
        data: { roleId: role.id, permissionId: permission.id },
      });
    }
  }
  return roles;
}

/**
 * Register a user and give them an organization they own.
 * Returns the headers needed to act inside that org.
 */
export async function makeUserWithOrg(app, email, orgName) {
  const registered = await request(app)
    .post('/api/v1/auth/register')
    .send({ email, password: 'password123' });

  const accessToken = registered.body.accessToken;

  const org = await request(app)
    .post('/api/v1/orgs')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ name: orgName });

  return {
    userId: registered.body.user.id,
    accessToken,
    orgId: org.body.id,
    authOnly: { Authorization: `Bearer ${accessToken}` },
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'X-Organization-Id': org.body.id,
    },
  };
}
