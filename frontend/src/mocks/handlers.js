import { delay, http, HttpResponse } from 'msw';

export const demoUser = {
  id: 'user-1',
  email: 'sunita@annapurnatrading.com.np',
};

export const demoOrganizations = [
  { id: 'org-annapurna', name: 'Annapurna Trading Pvt. Ltd.' },
  { id: 'org-sherpa', name: 'Sherpa Ventures Pvt. Ltd.' },
];

// Stands in for the httpOnly refresh cookie the mock layer cannot observe.
export const mockSession = { active: false };

const ok = (data, init) => HttpResponse.json({ data }, init);
const fail = (code, message, status = 400) =>
  HttpResponse.json(
    { error: { code, message, requestId: `mock-${code}` } },
    { status },
  );

export const handlers = [
  http.post('/api/v1/auth/login', async ({ request }) => {
    const body = await request.json();
    await delay(120);
    if (body.email !== 'sunita@annapurnatrading.com.np' || body.password !== 'Demo@2026') {
      return fail('invalid_credentials', 'Email or password is incorrect', 401);
    }
    mockSession.active = true;
    return ok({ user: demoUser, accessToken: 'mock-access-token' });
  }),

  http.post('/api/v1/auth/register', async ({ request }) => {
    const body = await request.json();
    await delay(120);
    mockSession.active = true;
    return ok(
      { user: { ...demoUser, email: body.email }, accessToken: 'mock-access-token' },
      { status: 201 },
    );
  }),

  // The real refresh cookie is httpOnly and MSW cannot see it, so session state
  // is modelled here. Without this the mock would refresh successfully with no
  // prior login — the app boots by trying /auth/refresh, and every test would
  // start authenticated.
  http.post('/api/v1/auth/refresh', () => {
    if (!mockSession.active) {
      return fail('refresh_invalid', 'Refresh token invalid, reused, or expired', 401);
    }
    return ok({ user: demoUser, accessToken: 'mock-refreshed-access-token' });
  }),

  http.post('/api/v1/auth/logout', () => {
    mockSession.active = false;
    return new HttpResponse(null, { status: 204 });
  }),

  http.get('/api/v1/orgs', () => ok(demoOrganizations)),

  http.get('/api/v1/dashboard/summary', ({ request }) => {
    const orgId = request.headers.get('X-Organization-Id') ?? demoOrganizations[0].id;
    const sherpa = orgId === 'org-sherpa';
    return ok({
      totalReceivables: sherpa ? '128400.00' : '69500.00',
      overdue: sherpa ? '24200.00' : '17520.00',
      revenue: sherpa ? '248000.00' : '195000.00',
      cashAtBank: sherpa ? '812340.00' : '624720.00',
      periodLabel: 'FY 2082/83 · Current period',
    });
  }),
];
