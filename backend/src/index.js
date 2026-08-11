import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { randomUUID } from 'node:crypto';

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
app.use(helmet());
app.use(cors());
app.use(express.json());

app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.use((err, req, res, next) => {
  console.error(`[${req.id}]`, err);
  res.status(err.status || 500).json({ 
  error: {
      code: err.code || 'INTERNAL_ERROR',
      message: err.message || 'Something went wrong',
      // || just means "use this, but if it's empty, use that instead."
      requestId: req.id,
    },
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});