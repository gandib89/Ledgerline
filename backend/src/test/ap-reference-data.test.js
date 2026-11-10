import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../app.js';
import { prisma } from '../db/client.js';
import { provisionStarterKit } from '../lib/orgs/starter-kit.js';
import { makeUserWithOrg, resetDb, seedRoles } from './helpers.js';

const migrationSql = (name) =>
  readFileSync(new URL(`../../prisma/migrations/${name}/migration.sql`, import.meta.url), 'utf8');

afterAll(() => prisma.$disconnect());

// The matrix a deployed database holds before AP: written out literally, not
// imported, so it can't drift along with the current seed matrix.
const PRE_AP = {
  Owner: ['invoice.create', 'invoice.post', 'payment.create', 'journal.post', 'bank.reconcile', 'report.view', 'audit.view', 'org.manage'],
  Accountant: ['invoice.create', 'invoice.post', 'payment.create', 'journal.post', 'bank.reconcile', 'report.view', 'audit.view'],
  Clerk: ['invoice.create', 'payment.create', 'report.view'],
  Viewer: ['report.view'],
};

async function seedPreApMatrix() {
  for (const [name, codes] of Object.entries(PRE_AP)) {
    const role = await prisma.role.create({ data: { name } });
    for (const code of codes) {
      const permission = await prisma.permission.upsert({ where: { code }, update: {}, create: { code } });
      await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    }
  }
}

async function grants() {
  const rows = await prisma.rolePermission.findMany({
    select: { role: { select: { name: true } }, permission: { select: { code: true } } },
  });
  const byRole = {};
  for (const { role, permission } of rows) (byRole[role.name] ??= []).push(permission.code);
  for (const codes of Object.values(byRole)) codes.sort();
  return byRole;
}

describe('AP permission data migration', () => {
  const sql = () => migrationSql('20260901000000_ap_permissions');

  beforeEach(async () => {
    await resetDb();
    await seedPreApMatrix();
  });

  it('grants the AP permissions to existing roles, and a second run changes nothing', async () => {
    await prisma.$executeRawUnsafe(sql());

    const ap = ['bill.create', 'bill.post', 'supplier_payment.create'];
    const expected = {
      Owner: [...PRE_AP.Owner, ...ap].sort(),
      Accountant: [...PRE_AP.Accountant, ...ap].sort(),
      Clerk: [...PRE_AP.Clerk, 'bill.create'].sort(),
      Viewer: [...PRE_AP.Viewer],
    };
    const afterFirst = await grants();
    expect(afterFirst).toEqual(expected);

    await prisma.$executeRawUnsafe(sql());

    expect(await grants()).toEqual(expected);
    expect(await prisma.permission.count()).toBe(11);
  });
});

const vat13Accounts = async (organizationId) => {
  const tc = await prisma.taxCode.findFirstOrThrow({
    where: { organizationId, code: 'VAT13' },
    include: { outputAccount: true, inputAccount: true },
  });
  return { output: tc.outputAccount?.code, input: tc.inputAccount?.code };
};

describe('VAT13 input account', () => {
  beforeEach(resetDb);

  it('a newly provisioned organization has output 2200 and input 2210', async () => {
    await seedRoles();
    const owner = await makeUserWithOrg(app, 'ap-owner@test.com', 'AP Starter Org');
    const res = await request(app).post(`/api/v1/orgs/${owner.orgId}/starter-kit`).set(owner.headers);
    expect(res.status).toBeLessThan(300);

    expect(await vat13Accounts(owner.orgId)).toEqual({ output: '2200', input: '2210' });
  });
});

describe('VAT13 input account backfill migration', () => {
  const sql = () => migrationSql('20260901000100_ap_vat13_input_account');

  async function preApOrg(name) {
    const org = await prisma.organization.create({ data: { name } });
    await provisionStarterKit(prisma, org.id);
    // What a pre-AP deployment holds: output account only.
    await prisma.taxCode.updateMany({ where: { organizationId: org.id, code: 'VAT13' }, data: { inputAccountId: null } });
    return org;
  }

  beforeEach(resetDb);

  it("sets every existing organization's VAT13 input account to its own 2210, idempotently", async () => {
    const a = await preApOrg('Backfill A');
    const b = await preApOrg('Backfill B');
    // An org that never got the starter kit's 2210 must not make the migration fail.
    const bare = await prisma.organization.create({ data: { name: 'Bare' } });
    await prisma.taxCode.create({ data: { organizationId: bare.id, code: 'VAT13', name: 'VAT 13%', rate: '0.1300' } });
    expect(await vat13Accounts(a.id)).toEqual({ output: '2200', input: undefined });

    await prisma.$executeRawUnsafe(sql());
    await prisma.$executeRawUnsafe(sql());

    expect(await vat13Accounts(a.id)).toEqual({ output: '2200', input: '2210' });
    expect(await vat13Accounts(b.id)).toEqual({ output: '2200', input: '2210' });
    // Each org points at its own 2210, not another tenant's.
    const own = await prisma.account.findFirstOrThrow({ where: { organizationId: b.id, code: '2210' } });
    const tc = await prisma.taxCode.findFirstOrThrow({ where: { organizationId: b.id, code: 'VAT13' } });
    expect(tc.inputAccountId).toBe(own.id);
    expect(await vat13Accounts(bare.id)).toEqual({ output: undefined, input: undefined });
  });
});
