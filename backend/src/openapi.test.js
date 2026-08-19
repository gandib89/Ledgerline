import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from './app.js';
import { openApiDocument } from './openapi.js';

describe('OpenAPI / Swagger UI', () => {
  it('generates a document with every mounted resource group', () => {
    expect(openApiDocument.openapi).toBe('3.0.0');
    const paths = Object.keys(openApiDocument.paths);
    expect(paths).toContain('/api/v1/invoices');
    expect(paths).toContain('/api/v1/reports/balance-sheet');
    expect(openApiDocument.paths['/api/v1/invoices/{id}/post'].post.security).toEqual([{ bearerAuth: [] }]);
  });

  it('serves the Swagger UI page at /api/v1/docs', async () => {
    const res = await request(app).get('/api/v1/docs/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('swagger-ui');
  });
});
