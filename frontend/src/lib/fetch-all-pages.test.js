import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { server } from '../mocks/server.js';
import { fetchAllPages } from './fetch-all-pages.js';
import { resetApiClient } from './api-client.js';

beforeEach(() => resetApiClient());

describe('fetchAllPages', () => {
  it('keeps the existing query string, concatenates pages and stops at the first short page', async () => {
    const requested = [];
    server.use(http.get('/api/v1/things', ({ request }) => {
      const url = new URL(request.url);
      const page = Number(url.searchParams.get('page'));
      requested.push(`${url.searchParams.get('type')}:${page}`);
      return HttpResponse.json(Array.from({ length: page < 3 ? 20 : 7 }, (_, i) => ({ id: `${page}-${i}` })));
    }));

    const rows = await fetchAllPages('/things?type=a');

    expect(rows).toHaveLength(47);
    expect(requested).toEqual(['a:1', 'a:2', 'a:3']);
  });

  it('makes a single request when the first page is short or empty', async () => {
    let calls = 0;
    server.use(http.get('/api/v1/things', () => { calls += 1; return HttpResponse.json([]); }));
    expect(await fetchAllPages('/things')).toEqual([]);
    expect(calls).toBe(1);
  });
});
