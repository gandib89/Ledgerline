import { prisma } from '../src/db/client.js';
import { hashPassword } from '../src/lib/auth/password.js';

const ROLES = ['Owner', 'Accountant', 'Clerk', 'Viewer'];

const PERMISSIONS = [
  'invoice.create',
  'invoice.post',
  'payment.create',
  'journal.post',
  'bank.reconcile',
  'report.view',
  'audit.view',
  'org.manage',
];

// plan §5's default matrix — who gets which permission
const ROLE_PERMISSIONS = {
  Owner: PERMISSIONS, // everything
  Accountant: [
    'invoice.create',
    'invoice.post',
    'payment.create',
    'journal.post',
    'bank.reconcile',
    'report.view',
    'audit.view',
  ],
  Clerk: ['invoice.create', 'payment.create', 'report.view'],
  Viewer: ['report.view'],
};

// plan §5's 27-account seed set (asset/liability/equity/income/expense)
const ACCOUNTS = [
  ['1010', 'Cash in Hand', 'ASSET'],
  ['1020', 'Bank — Nabil Bank Current', 'ASSET', { isBankAccount: true }],
  ['1030', 'Bank — NIC Asia Savings', 'ASSET', { isBankAccount: true }],
  ['1100', 'Accounts Receivable', 'ASSET', { isControlAccount: true }],
  ['1200', 'Prepaid Expenses', 'ASSET'],
  ['1300', 'Fixed Assets — Equipment', 'ASSET'],
  ['1310', 'Accum. Depreciation — Equip.', 'ASSET'],
  ['2100', 'Accounts Payable', 'LIABILITY', { isControlAccount: true }],
  ['2200', 'VAT Payable (Output)', 'LIABILITY', { isControlAccount: true }],
  ['2210', 'VAT Receivable (Input)', 'ASSET', { isControlAccount: true }],
  ['2300', 'TDS Payable', 'LIABILITY'],
  ['2400', 'Accrued Expenses', 'LIABILITY'],
  ['3100', "Owner's Capital", 'EQUITY'],
  ['3200', 'Retained Earnings', 'EQUITY'],
  ['3900', 'Current Year Earnings', 'EQUITY'],
  ['4100', 'Sales Revenue — Goods', 'REVENUE'],
  ['4200', 'Sales Revenue — Services', 'REVENUE'],
  ['4300', 'Discount Given', 'REVENUE'],
  ['4900', 'Other Income', 'REVENUE'],
  ['5100', 'Cost of Sales', 'EXPENSE'],
  ['5200', 'Salaries & Wages', 'EXPENSE'],
  ['5300', 'Rent Expense', 'EXPENSE'],
  ['5400', 'Utilities', 'EXPENSE'],
  ['5500', 'Bank Charges', 'EXPENSE'],
  ['5600', 'Professional Fees', 'EXPENSE'],
  ['5700', 'Depreciation Expense', 'EXPENSE'],
  ['5900', 'Other Expenses', 'EXPENSE'],
];

const PERIOD_LABELS = [
  'Shrawan', 'Bhadra', 'Ashwin', 'Kartik', 'Mangsir', 'Poush',
  'Magh', 'Falgun', 'Chaitra', 'Baisakh', 'Jestha', 'Ashadh',
];

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
  const roles = {};
  for (const name of ROLES) {
    roles[name] = await prisma.role.upsert({
      where: { name },
      update: {},
      create: { name },
    });
  }

  const permissions = {};
  for (const code of PERMISSIONS) {
    permissions[code] = await prisma.permission.upsert({
      where: { code },
      update: {},
      create: { code },
    });
  }

  for (const [roleName, codes] of Object.entries(ROLE_PERMISSIONS)) {
    for (const code of codes) {
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: { roleId: roles[roleName].id, permissionId: permissions[code].id },
        },
        update: {},
        create: { roleId: roles[roleName].id, permissionId: permissions[code].id },
      });
    }
  }

  console.log(`Seeded ${ROLES.length} roles, ${PERMISSIONS.length} permissions`);
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

async function seedFiscalYearAndPeriods(organizationId) {
  const fiscalYear = await prisma.fiscalYear.upsert({
    where: { organizationId_label: { organizationId, label: '2082/83' } },
    update: {},
    create: {
      organizationId,
      label: '2082/83',
      startDate: new Date('2025-07-17'),
      endDate: new Date('2026-07-16'),
    },
  });

  const cursor = new Date(fiscalYear.startDate);
  for (const label of PERIOD_LABELS) {
    const start = new Date(cursor);
    const end = new Date(cursor);
    end.setMonth(end.getMonth() + 1);
    end.setDate(end.getDate() - 1);

    await prisma.accountingPeriod.upsert({
      where: { fiscalYearId_label: { fiscalYearId: fiscalYear.id, label } },
      update: {},
      create: {
        fiscalYearId: fiscalYear.id,
        label,
        startDate: start,
        endDate: end,
        isOpen: true,
      },
    });

    cursor.setMonth(cursor.getMonth() + 1);
  }
}

async function seedAccounts(organizationId) {
  for (const [code, name, type, flags = {}] of ACCOUNTS) {
    await prisma.account.upsert({
      where: { organizationId_code: { organizationId, code } },
      update: {},
      create: { organizationId, code, name, type, ...flags },
    });
  }
}

async function seedTaxCodes(organizationId) {
  const outputAccount = await prisma.account.findUniqueOrThrow({
    where: { organizationId_code: { organizationId, code: '2200' } },
  });

  await prisma.taxCode.upsert({
    where: { organizationId_code: { organizationId, code: 'VAT13' } },
    update: {
      name: 'VAT 13%',
      rate: '0.1300',
      type: 'VAT',
      outputAccountId: outputAccount.id,
      isActive: true,
    },
    create: {
      organizationId,
      code: 'VAT13',
      name: 'VAT 13%',
      rate: '0.1300',
      type: 'VAT',
      outputAccountId: outputAccount.id,
    },
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

    await seedFiscalYearAndPeriods(org.id);
    await seedAccounts(org.id);
    await seedTaxCodes(org.id);
    await seedParties(org.id, parties);

    console.log(`Seeded ${name}: ${members.length} members, ${ACCOUNTS.length} accounts, ${parties.length} customers`);
  }

  console.log(`Seed complete. Demo users share the password: ${DEMO_PASSWORD}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
