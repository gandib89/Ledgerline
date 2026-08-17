import { describe, it, expect, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { rateLimit } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { env } from '../env.js';

// rate-limit.js skips enforcement under NODE_ENV=test (see comment there) so
// the app's own limiters never fire during the functional suite. This test
// builds a throwaway limiter — same store/library wiring, no skip — against
// a unique key prefix, to prove the mechanism itself works.
const redisClient = createClient({ url: env.REDIS_URL });
await redisClient.connect();
afterAll(() => redisClient.quit());

const prefix = `rl:test:${randomUUID()}:`;
const app = express();
app.use(rateLimit({
  windowMs: 60_000,
  limit: 2,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({ sendCommand: (...args) => redisClient.sendCommand(args), prefix }),
}));
app.get('/ping', (req, res) => res.json({ ok: true }));

describe('rate limiting mechanism', () => {
  it('allows requests under the limit and blocks the one that exceeds it', async () => {
    const first = await request(app).get('/ping');
    const second = await request(app).get('/ping');
    const third = await request(app).get('/ping');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
    expect(third.headers['ratelimit-limit']).toBe('2');
  });
});
