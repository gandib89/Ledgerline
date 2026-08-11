import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  apiRequest,
  resetApiClient,
  setAccessToken,
  setActiveOrganization,
} from './api-client.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('apiRequest', () => {
  beforeEach(() => {
    resetApiClient();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('adds auth, organization, and idempotency headers to a mutation', async () => {
    fetch.mockResolvedValue(jsonResponse({ data: { id: 'inv-1' } }, 201));
    setAccessToken('access-1');
    setActiveOrganization('org-1');

    await apiRequest('/invoices', { method: 'POST', body: { partyId: 'party-1' } });

    const [url, init] = fetch.mock.calls[0];
    const headers = new Headers(init.headers);
    expect(url).toBe('/api/v1/invoices');
    expect(headers.get('Authorization')).toBe('Bearer access-1');
    expect(headers.get('X-Organization-Id')).toBe('org-1');
    expect(headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(init.body).toBe(JSON.stringify({ partyId: 'party-1' }));
  });

  it('turns the server error envelope into ApiError', async () => {
    fetch.mockResolvedValue(
      jsonResponse(
        { error: { code: 'invalid_credentials', message: 'Email or password is incorrect', requestId: 'req-7' } },
        401,
      ),
    );

    const error = await apiRequest('/auth/login', { method: 'POST', body: {} }).catch(
      (caught) => caught,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toEqual(
      expect.objectContaining({
        name: 'ApiError',
        code: 'invalid_credentials',
        message: 'Email or password is incorrect',
        requestId: 'req-7',
        status: 401,
      }),
    );
  });

  it('deduplicates refresh and retries concurrent unauthorized requests once', async () => {
    let refreshCalls = 0;
    fetch.mockImplementation(async (url, init = {}) => {
      const headers = new Headers(init.headers);
      if (url === '/api/v1/auth/refresh') {
        refreshCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 0));
        return jsonResponse({ data: { accessToken: 'access-2' } });
      }
      if (headers.get('Authorization') === 'Bearer access-2') {
        return jsonResponse({ data: { ok: true } });
      }
      return jsonResponse({ error: { code: 'token_expired', message: 'Expired' } }, 401);
    });
    setAccessToken('access-1');

    const [first, second] = await Promise.all([apiRequest('/orgs'), apiRequest('/dashboard/summary')]);

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    expect(refreshCalls).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(5);
  });
});
