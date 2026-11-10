import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { prisma } from '../db/client.js';
import { makeUserWithOrg, resetDb, seedRoles } from '../test/helpers.js';

let owner;

// 25 suppliers, 10 both, 20 customers: more than one page (20) of each filter.
const MIX = [
  ...Array.from({ length: 25 }, (_, i) => ['supplier', `S-${String(i + 1).padStart(3, '0')}`]),
  ...Array.from({ length: 10 }, (_, i) => ['both', `B-${String(i + 1).padStart(3, '0')}`]),
  ...Array.from({ length: 20 }, (_, i) => ['customer', `C-${String(i + 1).padStart(3, '0')}`]),
];

beforeAll(async () => {
  await resetDb();
  await seedRoles();
  owner = await makeUserWithOrg(app, 'owner@test.com', 'Parties Trading');
  for (const [type, code] of MIX) {
    await request(app).post('/api/v1/parties').set(owner.headers).send({ type, code, name: `Party ${code}` }).expect(201);
  }
});

afterAll(() => prisma.$disconnect());

const list = (query) => request(app).get('/api/v1/parties').query(query).set(owner.headers);

describe('GET /parties type filter', () => {
  it('type=supplier returns only supplier and both parties, paginated over those alone', async () => {
    const page1 = await list({ type: 'supplier', page: 1 });
    const page2 = await list({ type: 'supplier', page: 2 });
    const page3 = await list({ type: 'supplier', page: 3 });

    expect(page1.status).toBe(200);
    // Ordered by code: 10 B-xxx then 25 S-xxx = 35 rows, 20 + 15.
    expect(page1.body).toHaveLength(20);
    expect(page2.body).toHaveLength(15);
    expect(page3.body).toHaveLength(0);
    const all = [...page1.body, ...page2.body];
    expect(all.every((p) => p.type === 'supplier' || p.type === 'both')).toBe(true);
    expect(all.filter((p) => p.type === 'both')).toHaveLength(10);
  });

  it('type=customer returns only customer and both parties', async () => {
    const res = await list({ type: 'customer' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(20);
    // B-001..B-010 sort first, then C-001..C-010 fill the page.
    expect(res.body.every((p) => p.type === 'customer' || p.type === 'both')).toBe(true);
    const page2 = await list({ type: 'customer', page: 2 });
    expect(page2.body).toHaveLength(10);
  });

  it('accepts the uppercase enum spelling and rejects unknown types', async () => {
    expect((await list({ type: 'SUPPLIER' })).body).toHaveLength(20);
    expect((await list({ type: 'both' })).status).toBe(400);
  });

  it('without type still returns every party', async () => {
    const res = await list({ page: 3 });
    expect(res.body).toHaveLength(15); // 55 parties: 20 + 20 + 15
  });
});

describe('party PAN/VAT number', () => {
  it('is created, returned and editable', async () => {
    const created = await request(app).post('/api/v1/parties').set(owner.headers)
      .send({ type: 'supplier', code: 'PAN-1', name: 'Pan Supplier', panVatNo: '123456789' });
    expect(created.status).toBe(201);
    expect(created.body.panVatNo).toBe('123456789');

    const patched = await request(app).patch(`/api/v1/parties/${created.body.id}`).set(owner.headers)
      .send({ panVatNo: null });
    expect(patched.body.panVatNo).toBeNull();
  });
});
