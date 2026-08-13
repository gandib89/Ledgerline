import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import authRouter from './routes/auth.js';
import orgsRouter from './routes/orgs.js';
import mastersRouter from './routes/masters.js';
import { auditLog } from './middleware/audit-log.js';

// The app is built here but never listens — index.js starts the server, tests
// hand this straight to supertest. Keeps tests off a real port.
const app = express();
// req -> incoming request from frontend
// res -> outgoing response from backend
app.use((req, res, next) => {
  req.id = randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
// so when a request comes a random uuid req.id is given to that request
// and when a response is given xrequestid id given to that response
});
app.use(auditLog);
app.use(helmet());
app.use(cors());
app.use(express.json());

app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.use('/api/v1/auth', authRouter);
app.use('/api/v1/orgs', orgsRouter);
app.use('/api/v1', mastersRouter);

// Express identifies error handlers by arity — the 4th param must exist even
// though it is unused here.
app.use((err, req, res, _next) => {
  console.error(`[${req.id}]`, err);

  // Zod throws on any bad request body/query. That is a client error (400),
  // not a server fault — without this it would surface as a 500.
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: 'validation_error',
        message: 'Request validation failed',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        requestId: req.id,
      },
    });
  }

  res.status(err.status || 500).json({
  error: {
      code: err.code || 'INTERNAL_ERROR',
      message: err.message || 'Something went wrong',
      // || just means "use this, but if it's empty, use that instead."
      requestId: req.id,
    },
  });
});

export default app;
