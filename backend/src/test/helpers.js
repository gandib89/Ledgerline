import request from 'supertest';
import { prisma } from '../db/client.js';
import { ensureReferenceData } from '../lib/auth/reference-data.js';

// TRUNCATE, not DELETE: the immutability trigger blocks row-level DELETE on
// JournalEntry/JournalLine, but TRUNCATE doesn't fire row-level triggers.
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

/** Roles and permissions are global reference data, not tenant data. */
export async function seedRoles() {
  await ensureReferenceData();
  return Object.fromEntries((await prisma.role.findMany()).map((role) => [role.name, role]));
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
