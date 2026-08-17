import 'dotenv/config';
import { z } from 'zod';

// Parsed once at import time. A missing/invalid var throws here — at boot,
// before app.listen — instead of surfacing later as an undefined-secret bug
// on the first request that needs it (e.g. JWT_SECRET undefined at sign time).
const schema = z.object({
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Comma-separated list of allowed browser origins, e.g. "http://localhost:5173,https://app.example.com"
  CORS_ORIGINS: z.string().default(''),
  REDIS_URL: z.string().default('redis://localhost:6379'),
});

export const env = schema.parse(process.env);
