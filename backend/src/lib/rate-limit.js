import { createClient } from 'redis';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { env } from '../env.js';

const redisClient = createClient({ url: env.REDIS_URL });
redisClient.on('error', (err) => console.error('[redis]', err.message));
await redisClient.connect();

function store(prefix) {
  return new RedisStore({
    sendCommand: (...args) => redisClient.sendCommand(args),
    prefix,
  });
}

// Skipped under test: the functional suite fires hundreds of requests from
// one IP inside one Redis-backed window, which would trip these limits and
// fail unrelated tests. The mechanism itself is covered independently in
// rate-limit.test.js, against a throwaway limiter instance.
const shared = { standardHeaders: true, legacyHeaders: false, skip: () => env.NODE_ENV === 'test' };

// §9 checklist figures: global 300/min/IP, auth 5/15min, CSV import
// 10/hour/org, reports 60/min/org. Shared Redis store so limits hold across
// however many API instances end up behind the load balancer.
export const globalLimiter = rateLimit({
  ...shared,
  windowMs: 60 * 1000,
  limit: 300,
  store: store('rl:global:'),
});

export const authLimiter = rateLimit({
  ...shared,
  windowMs: 15 * 60 * 1000,
  limit: 5,
  store: store('rl:auth:'),
  // IP + email: an attacker cycling emails from one IP still hits the IP
  // component, and one cycling IPs against a single victim still hits the
  // email component.
  keyGenerator: (req) => `${ipKeyGenerator(req.ip)}:${req.body?.email || ''}`,
});

export const csvImportLimiter = rateLimit({
  ...shared,
  windowMs: 60 * 60 * 1000,
  limit: 10,
  store: store('rl:csv:'),
  keyGenerator: (req) => req.organizationId,
});

export const reportLimiter = rateLimit({
  ...shared,
  windowMs: 60 * 1000,
  limit: 60,
  store: store('rl:report:'),
  keyGenerator: (req) => req.organizationId,
});
