import { prisma } from '../src/db/client.js';
import { hashPassword } from '../src/lib/auth/password.js';
import { ensureReferenceData, ROLE_PERMISSIONS } from '../src/lib/auth/reference-data.js';
import { provisionStarterKit, STARTER_ACCOUNT_COUNT } from '../src/lib/orgs/starter-kit.js';
import { seedDemoScenario } from './demo-data.js';

// plan §14 — one narrator org plus a second org that exists purely so tenant
// isolation is demonstrable rather than merely claimed.
const DEMO_PASSWORD = 'Demo@2026';

const ORGS = [
  {
    name: 'Annapurna Trading Pvt. Ltd.',
    members: [
      ['sunita@annapurnatrading.com.np', 'Owner'],
      ['rajan@annapurnatrading.com.np', 'Accountant'],
      ['bimala@annapurnatrading.com.np', 'Clerk'],
    ],
    parties: [
      ['CUS-001', 'Himalayan Trek Supplies Pvt. Ltd.', 30],
      ['CUS-002', 'Everest Cafe Pvt. Ltd.', 15],
      ['CUS-003', 'Sagarmatha Hardware Suppliers', 30],
    ],
  },
  {
    name: 'Sherpa Ventures Pvt. Ltd.',
    members: [
      // Sunita belongs to both orgs, so the demo can show the org switcher
      // flipping the whole dataset for one logged-in user.
      ['sunita@annapurnatrading.com.np', 'Owner'],
      ['auditor@external.com.np', 'Viewer'],
    ],
    parties: [
      ['CUS-101', 'Khumbu Expeditions Pvt. Ltd.', 30],
      ['CUS-102', 'Lukla Guesthouse', 15],
    ],
  },
];

async function seedRolesAndPermissions() {
  await ensureReferenceData(prisma);
  const roles = Object.fromEntries((await prisma.role.findMany()).map((role) => [role.name, role]));
  console.log(`Seeded ${Object.keys(ROLE_PERMISSIONS).length} roles`);
  return roles;
}

async function seedUser(email, passwordHash) {
  return prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, passwordHash },
  });
}

async function seedOrganization(name) {
  const existing = await prisma.organization.findFirst({ where: { name } });
  if (existing) return existing;
  return prisma.organization.create({ data: { name } });
}

async function seedMembership(userId, organizationId, roleId) {
  await prisma.membership.upsert({
    where: { userId_organizationId: { userId, organizationId } },
    update: {},
    create: { userId, organizationId, roleId },
  });
}

async function seedParties(organizationId, parties) {
  for (const [code, name, creditDays] of parties) {
    await prisma.party.upsert({
      where: { organizationId_code: { organizationId, code } },
      update: {},
      create: { organizationId, code, name, creditDays, type: 'CUSTOMER' },
    });
  }
}

async function main() {
  const roles = await seedRolesAndPermissions();

  // One hash reused for every demo user — Argon2id is deliberately slow, and
  // this is throwaway demo data, not a credential store.
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  for (const { name, members, parties } of ORGS) {
    const org = await seedOrganization(name);

    for (const [email, roleName] of members) {
      const user = await seedUser(email, passwordHash);
      await seedMembership(user.id, org.id, roles[roleName].id);
    }

    await provisionStarterKit(prisma, org.id);
    await seedParties(org.id, parties);

    if (name === 'Annapurna Trading Pvt. Ltd.') {
      const actor = await prisma.user.findUniqueOrThrow({ where: { email: 'sunita@annapurnatrading.com.np' } });
      const membership = await prisma.membership.findUniqueOrThrow({
        where: { userId_organizationId: { userId: actor.id, organizationId: org.id } },
      });
      await seedDemoScenario(prisma, { organizationId: org.id, userId: actor.id, roleId: membership.roleId });
      console.log('Seeded exact Section 14 invoices, receipts, statement, audit trail, and zero-difference reconciliation');
    }

    console.log(`Seeded ${name}: ${members.length} members, ${STARTER_ACCOUNT_COUNT} accounts, ${parties.length} customers`);
  }

  console.log(`Seed complete. Demo users share the password: ${DEMO_PASSWORD}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
