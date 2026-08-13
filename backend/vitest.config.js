import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Every suite TRUNCATEs the same real Postgres database, so files must not
    // run concurrently — parallel runs would wipe each other's fixtures.
    fileParallelism: false,
    // Argon2id is deliberately slow (19MB, 2 passes); auth suites need headroom.
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
