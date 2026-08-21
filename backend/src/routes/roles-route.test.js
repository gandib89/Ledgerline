import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const findMany = vi.fn();

vi.mock('../db/client.js', () => ({
  prisma: { role: { findMany } },
}));

vi.mock('../middleware/authenticate.js', () => ({
  authenticate: (_req, _res, next) => next(),
}));

vi.mock('../middleware/resolve-tenant.js', () => ({
  resolveTenant: (_req, _res, next) => next(),
}));

vi.mock('../middleware/authorize.js', () => ({
  authorize: () => (_req, _res, next) => next(),
}));

const { default: mastersRouter } = await import('./masters.js');

function testApp() {
  const app = express();
  app.use(express.json());
  app.use(mastersRouter);
  return app;
}

describe('GET /roles', () => {
  beforeEach(() => findMany.mockReset());

  it('returns assignable roles in name order', async () => {
    findMany.mockResolvedValue([
      { id: 'role-accountant', name: 'Accountant' },
      { id: 'role-owner', name: 'Owner' },
    ]);

    const response = await request(testApp()).get('/roles');

    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      { id: 'role-accountant', name: 'Accountant' },
      { id: 'role-owner', name: 'Owner' },
    ]);
    expect(findMany).toHaveBeenCalledWith({
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
  });
});
