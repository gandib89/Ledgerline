import app from './app.js';
import { env } from './env.js';
import { ensureReferenceData } from './lib/auth/reference-data.js';

// `migrate deploy` doesn't run the seed, so make sure roles and permissions
// exist before anyone can log in or be given access.
await ensureReferenceData();

app.listen(env.PORT, () => {
  console.log(`Server running on port ${env.PORT}`);
});
