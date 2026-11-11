import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../db/client.js';
import { resetDb } from '../../test/helpers.js';
import { ensureReferenceData } from './reference-data.js';

afterAll(() => prisma.$disconnect());

// Written out literally, not imported, so the test can disagree with the code.
const OWNER = [
  'audit.view', 'bank.reconcile', 'bill.create', 'bill.post', 'invoice.create', 'invoice.post',
  'journal.post', 'org.manage', 'payment.create', 'report.view', 'supplier_payment.create',
];
const ACCOUNTANT = OWNER.filter((code) => code !== 'org.manage');
const EXPECTED = {
  Owner: OWNER,
  Accountant: ACCOUNTANT,
  Clerk: ['bill.create', 'invoice.create', 'payment.create', 'report.view'],
  Viewer: ['report.view'],
};

async function grants() {
  const rows = await prisma.rolePermission.findMany({
    select: { role: { select: { name: true } }, permission: { select: { code: true } } },
  });
  const byRole = {};
  for (const { role, permission } of rows) (byRole[role.name] ??= []).push(permission.code);
  for (const codes of Object.values(byRole)) codes.sort();
  return byRole;
}

describe('ensureReferenceData', () => {
  beforeEach(resetDb);

  it('fills an empty database (migrate deploy only) with every role, permission and grant, and a second run changes nothing', async () => {
    expect(await prisma.role.count()).toBe(0);
    expect(await prisma.permission.count()).toBe(0);

    await ensureReferenceData();
    const ids = (await prisma.role.findMany({ orderBy: { name: 'asc' } })).map((r) => r.id);
    expect(await grants()).toEqual(EXPECTED);
    expect(await prisma.role.count()).toBe(4);
    expect(await prisma.permission.count()).toBe(11);

    await ensureReferenceData();
    expect(await grants()).toEqual(EXPECTED);
    expect(await prisma.role.count()).toBe(4);
    expect(await prisma.permission.count()).toBe(11);
    expect(await prisma.rolePermission.count()).toBe(Object.values(EXPECTED).flat().length);
    expect((await prisma.role.findMany({ orderBy: { name: 'asc' } })).map((r) => r.id)).toEqual(ids);
  });

  it('tops up a partly populated database without touching existing rows', async () => {
    const owner = await prisma.role.create({ data: { name: 'Owner' } });
    const invoiceCreate = await prisma.permission.create({ data: { code: 'invoice.create' } });
    await prisma.rolePermission.create({ data: { roleId: owner.id, permissionId: invoiceCreate.id } });

    await ensureReferenceData();

    expect(await grants()).toEqual(EXPECTED);
    expect((await prisma.role.findUniqueOrThrow({ where: { name: 'Owner' } })).id).toBe(owner.id);
    expect((await prisma.permission.findUniqueOrThrow({ where: { code: 'invoice.create' } })).id).toBe(invoiceCreate.id);
  });
});
