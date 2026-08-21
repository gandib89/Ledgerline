import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { prisma } from '../db/client.js';
import { resetDb, seedRoles, makeUserWithOrg } from '../test/helpers.js';

let roles, owner;
const members = {};

async function addMember(email, roleName) {
  await request(app)
    .post('/api/v1/auth/register')
    .send({ email, password: 'password123' });

  await request(app)
    .post(`/api/v1/orgs/${owner.orgId}/members`)
    .set(owner.headers)
    .send({ email, roleId: roles[roleName].id });

  const login = await request(app)
    .post('/api/v1/auth/login')
    .send({ email, password: 'password123' });

  members[roleName] = {
    Authorization: `Bearer ${login.body.accessToken}`,
    'X-Organization-Id': owner.orgId,
  };
}

beforeAll(async () => {
  await resetDb();
  roles = await seedRoles();

  owner = await makeUserWithOrg(app, 'owner@test.com', 'Perm Test Org');
  await addMember('accountant@test.com', 'Accountant');
  await addMember('clerk@test.com', 'Clerk');
  await addMember('viewer@test.com', 'Viewer');
});

afterAll(() => prisma.$disconnect());

describe('permissions', () => {
  it('lists assignable roles for Owners and rejects Viewers', async () => {
    const allowed = await request(app).get('/api/v1/roles').set(owner.headers);

    expect(allowed.status).toBe(200);
    expect(allowed.body).toEqual([
      expect.objectContaining({ id: roles.Accountant.id, name: 'Accountant' }),
      expect.objectContaining({ id: roles.Clerk.id, name: 'Clerk' }),
      expect.objectContaining({ id: roles.Owner.id, name: 'Owner' }),
      expect.objectContaining({ id: roles.Viewer.id, name: 'Viewer' }),
    ]);

    const denied = await request(app).get('/api/v1/roles').set(members.Viewer);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('forbidden');
  });

  it('returns the current role and permission codes with each organization', async () => {
    const res = await request(app).get('/api/v1/orgs').set(owner.authOnly);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({
        id: owner.orgId,
        role: expect.objectContaining({ name: 'Owner' }),
        permissions: expect.arrayContaining(['invoice.create', 'invoice.post', 'report.view']),
      }),
    ]);
  });

  // PERM-1 — the org creator must be able to administer it, or the org is
  // orphaned the moment it is created.
  it('PERM-1: the org creator is an Owner with org.manage', async () => {
    const res = await request(app)
      .get(`/api/v1/orgs/${owner.orgId}/members`)
      .set(owner.headers);

    expect(res.status).toBe(200);
    expect(res.body.find((m) => m.user.email === 'owner@test.com').role.name).toBe('Owner');
  });

  // PERM-2 — every role can read; that is what makes the write checks meaningful.
  it('PERM-2: every role can read (report.view)', async () => {
    for (const roleName of ['Accountant', 'Clerk', 'Viewer']) {
      const res = await request(app).get('/api/v1/accounts').set(members[roleName]);
      expect(res.status, `${roleName} should read accounts`).toBe(200);
    }
  });

  // PERM-3 — the demo's RBAC moment.
  it('PERM-3: a Viewer cannot create master data', async () => {
    const res = await request(app)
      .post('/api/v1/accounts')
      .set(members.Viewer)
      .send({ code: '9999', name: 'Sneaky', type: 'EXPENSE' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
  });

  // PERM-4 — administration is narrower than participation.
  it('PERM-4: non-Owners cannot administer membership', async () => {
    for (const roleName of ['Accountant', 'Clerk', 'Viewer']) {
      const list = await request(app)
        .get(`/api/v1/orgs/${owner.orgId}/members`)
        .set(members[roleName]);
      expect(list.status, `${roleName} should not list members`).toBe(403);

      const add = await request(app)
        .post(`/api/v1/orgs/${owner.orgId}/members`)
        .set(members[roleName])
        .send({ email: 'viewer@test.com', roleId: roles.Owner.id });
      expect(add.status, `${roleName} should not add members`).toBe(403);
    }
  });

  // PERM-5 — the reason permissions are not baked into the JWT. A revoked role
  // must bite immediately, not whenever the 15-minute access token expires.
  it('PERM-5: revoking a role takes effect on the very next request, same token', async () => {
    const before = await request(app)
      .post('/api/v1/parties')
      .set(members.Accountant)
      .send({ type: 'customer', code: 'X-1', name: 'Before Revoke' });
    expect(before.status).toBe(403); // Accountant has no org.manage

    // Promote to Owner, reusing the *same* access token issued minutes ago.
    const user = await prisma.user.findUnique({ where: { email: 'accountant@test.com' } });
    await prisma.membership.updateMany({
      where: { userId: user.id, organizationId: owner.orgId },
      data: { roleId: roles.Owner.id },
    });

    const after = await request(app)
      .post('/api/v1/parties')
      .set(members.Accountant)
      .send({ type: 'customer', code: 'X-2', name: 'After Promote' });
    expect(after.status).toBe(201);
  });

  it('PERM-6: a Viewer cannot update master data', async () => {
    const created = await request(app)
      .post('/api/v1/parties')
      .set(owner.headers)
      .send({ type: 'customer', code: 'LOCKED-1', name: 'Owner Customer' });

    const res = await request(app)
      .patch(`/api/v1/parties/${created.body.id}`)
      .set(members.Viewer)
      .send({ name: 'Viewer overwrite' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
  });
});
