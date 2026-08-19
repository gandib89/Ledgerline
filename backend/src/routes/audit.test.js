import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { prisma } from '../db/client.js';
import { makeUserWithOrg, resetDb, seedRoles } from '../test/helpers.js';

let owner;

beforeAll(async () => {
  await resetDb();
  await seedRoles();
  owner = await makeUserWithOrg(app, 'audit-owner@test.com', 'Audit Test Org');
  const other = await makeUserWithOrg(app, 'other-audit-owner@test.com', 'Other Audit Org');

  await prisma.auditLog.createMany({ data: [
    {
      organizationId: owner.orgId, userId: owner.userId, action: 'invoice.created',
      entityType: 'day6-test', entityId: 'invoice-old', after: { status: 'DRAFT' },
      ipAddress: '127.0.0.1', requestId: 'request-old', createdAt: new Date('2026-02-17T06:00:00.000Z'),
    },
    {
      organizationId: owner.orgId, userId: owner.userId, action: 'invoice.posted',
      entityType: 'day6-test', entityId: 'invoice-new', before: { status: 'DRAFT' }, after: { status: 'POSTED' },
      ipAddress: '127.0.0.2', requestId: 'request-new', createdAt: new Date('2026-02-18T06:00:00.000Z'),
    },
    {
      organizationId: other.orgId, userId: other.userId, action: 'invoice.posted',
      entityType: 'day6-test', entityId: 'cross-tenant', after: { status: 'POSTED' },
      requestId: 'must-not-leak', createdAt: new Date('2026-02-19T06:00:00.000Z'),
    },
  ] });
});

afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

describe('GET /api/v1/audit-log', () => {
  it('returns only this tenant newest first with actor and trace metadata', async () => {
    const response = await request(app)
      .get('/api/v1/audit-log?entityType=day6-test')
      .set(owner.headers);

    expect(response.status).toBe(200);
    expect(response.body.map(({ entityId }) => entityId)).toEqual(['invoice-new', 'invoice-old']);
    expect(response.body[0]).toMatchObject({
      actorId: owner.userId,
      actor: { id: owner.userId, email: 'audit-owner@test.com' },
      ipAddress: '127.0.0.2',
      requestId: 'request-new',
    });
    expect(response.body.some(({ requestId }) => requestId === 'must-not-leak')).toBe(false);
  });

  it('rejects malformed actor and page filters', async () => {
    const response = await request(app)
      .get('/api/v1/audit-log?actorId=not-a-uuid&page=0')
      .set(owner.headers);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation_error');
  });
});
