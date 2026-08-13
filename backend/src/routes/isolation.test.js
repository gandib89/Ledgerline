import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { prisma } from '../db/client.js';
import { resetDb, seedRoles, makeUserWithOrg } from '../test/helpers.js';

let alice, bob;

beforeAll(async () => {
  await resetDb();
  await seedRoles();

  alice = await makeUserWithOrg(app, 'alice@test.com', 'Alice Trading');
  bob = await makeUserWithOrg(app, 'bob@test.com', 'Bob Ventures');

  await request(app).post('/api/v1/parties').set(alice.headers)
    .send({ type: 'customer', code: 'A-001', name: 'Alice Customer' });
  await request(app).post('/api/v1/accounts').set(alice.headers)
    .send({ code: '4100', name: 'Alice Revenue', type: 'REVENUE' });

  await request(app).post('/api/v1/parties').set(bob.headers)
    .send({ type: 'customer', code: 'B-001', name: 'Bob Customer' });
  await request(app).post('/api/v1/accounts').set(bob.headers)
    .send({ code: '4100', name: 'Bob Revenue', type: 'REVENUE' });
});

afterAll(() => prisma.$disconnect());

describe('tenant isolation', () => {
  // ISO-1 — the core promise. If this fails, the product is unshippable.
  it('ISO-1: a list endpoint returns only the active org\'s rows', async () => {
    const aliceParties = await request(app).get('/api/v1/parties').set(alice.headers);
    const bobParties = await request(app).get('/api/v1/parties').set(bob.headers);

    expect(aliceParties.body.map((p) => p.code)).toEqual(['A-001']);
    expect(bobParties.body.map((p) => p.code)).toEqual(['B-001']);

    const aliceAccounts = await request(app).get('/api/v1/accounts').set(alice.headers);
    expect(aliceAccounts.body.map((a) => a.name)).toEqual(['Alice Revenue']);
  });

  // ISO-2 — the header is a *claim*, checked against membership. Trusting it
  // alone would make cross-tenant access a one-header attack.
  it('ISO-2: presenting another org\'s id in the header is forbidden', async () => {
    const res = await request(app)
      .get('/api/v1/parties')
      .set({ Authorization: bob.headers.Authorization, 'X-Organization-Id': alice.orgId });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
  });

  // ISO-3 — writes must land in the caller's org, never the claimed one.
  it('ISO-3: a create lands in the caller\'s org even if the body says otherwise', async () => {
    await request(app).post('/api/v1/parties').set(bob.headers)
      .send({ type: 'customer', code: 'B-002', name: 'Injected' });

    const stored = await prisma.party.findFirst({ where: { code: 'B-002' } });
    expect(stored.organizationId).toBe(bob.orgId);

    const aliceSees = await request(app).get('/api/v1/parties').set(alice.headers);
    expect(aliceSees.body.map((p) => p.code)).not.toContain('B-002');
  });

  // ISO-4 — no token and no org header are distinct failures, and neither may
  // fall through to data.
  it('ISO-4: unauthenticated and org-less requests are rejected before any data is read', async () => {
    const noToken = await request(app)
      .get('/api/v1/parties')
      .set({ 'X-Organization-Id': alice.orgId });
    expect(noToken.status).toBe(401);
    expect(noToken.body.error.code).toBe('unauthenticated');

    const noOrgHeader = await request(app).get('/api/v1/parties').set(alice.authOnly);
    expect(noOrgHeader.status).toBe(400);
    expect(noOrgHeader.body.error.code).toBe('org_header_invalid');

    const garbageToken = await request(app)
      .get('/api/v1/parties')
      .set({ Authorization: 'Bearer not-a-real-jwt', 'X-Organization-Id': alice.orgId });
    expect(garbageToken.status).toBe(401);
  });

  it('/orgs lists only the organizations the caller belongs to', async () => {
    const res = await request(app).get('/api/v1/orgs').set(alice.authOnly);
    expect(res.body.map((o) => o.name)).toEqual(['Alice Trading']);
  });
});
