import { describe, expect, it } from 'vitest';
import { createAppQueryClient } from './query-client.js';

describe('createAppQueryClient', () => {
  it('uses restrained retry and focus behavior for financial screens', () => {
    const client = createAppQueryClient();
    const queries = client.getDefaultOptions().queries;

    expect(queries.retry).toBe(1);
    expect(queries.refetchOnWindowFocus).toBe(false);
  });
});
