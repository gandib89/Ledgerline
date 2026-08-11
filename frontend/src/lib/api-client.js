const API_BASE_URL = import.meta.env.VITE_API_URL ?? '/api/v1';
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

let accessToken = null;
let activeOrganizationId = null;
let refreshPromise = null;

export class ApiError extends Error {
  constructor({ code = 'request_failed', message = 'Request failed', requestId = null, status = 500 }) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.requestId = requestId;
    this.status = status;
  }
}

export function setAccessToken(token) {
  accessToken = token || null;
}

export function setActiveOrganization(id) {
  activeOrganizationId = id || null;
}

export function getActiveOrganization() {
  return activeOrganizationId;
}

export function resetApiClient() {
  accessToken = null;
  activeOrganizationId = null;
  refreshPromise = null;
}

function apiUrl(path) {
  return `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

async function readPayload(response) {
  if (response.status === 204) return null;
  const contentType = response.headers.get('Content-Type') ?? '';
  if (!contentType.includes('application/json')) return null;
  return response.json();
}

function toApiError(payload, status) {
  return new ApiError({
    code: payload?.error?.code,
    message: payload?.error?.message,
    requestId: payload?.error?.requestId,
    status,
  });
}

async function refreshAccessToken() {
  if (!refreshPromise) {
    refreshPromise = fetch(apiUrl('/auth/refresh'), {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
      .then(async (response) => {
        const payload = await readPayload(response);
        if (!response.ok) throw toApiError(payload, response.status);
        const token = payload?.data?.accessToken ?? payload?.accessToken;
        if (!token) {
          throw new ApiError({ code: 'invalid_refresh_response', message: 'Unable to restore session' });
        }
        setAccessToken(token);
        return token;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }

  return refreshPromise;
}

export async function apiRequest(
  path,
  { method = 'GET', body, headers: providedHeaders = {}, retryAuth = true } = {},
) {
  const normalizedMethod = method.toUpperCase();
  const isMutation = MUTATION_METHODS.has(normalizedMethod);
  const idempotencyKey =
    providedHeaders['Idempotency-Key'] ??
    providedHeaders['idempotency-key'] ??
    (isMutation ? globalThis.crypto.randomUUID() : null);

  async function execute(canRetry) {
    const headers = new Headers(providedHeaders);
    headers.set('Accept', 'application/json');
    if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
    if (activeOrganizationId) headers.set('X-Organization-Id', activeOrganizationId);
    if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey);

    let requestBody = body;
    if (body !== undefined && !(body instanceof FormData)) {
      headers.set('Content-Type', 'application/json');
      requestBody = JSON.stringify(body);
    }

    const response = await fetch(apiUrl(path), {
      method: normalizedMethod,
      credentials: 'include',
      headers,
      body: requestBody,
    });
    const payload = await readPayload(response);

    if (response.status === 401 && canRetry && accessToken && path !== '/auth/refresh') {
      await refreshAccessToken();
      return execute(false);
    }
    if (!response.ok) throw toApiError(payload, response.status);

    return payload?.data ?? payload;
  }

  return execute(retryAuth);
}
