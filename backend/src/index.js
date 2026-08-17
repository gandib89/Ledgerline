import app from './app.js';
import { env } from './env.js';

app.listen(env.PORT, () => {
  console.log(`Server running on port ${env.PORT}`);
});