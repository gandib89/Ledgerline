import { delay, http, HttpResponse } from 'msw';

export const demoUser = {
  id: 'user-1',
  name: 'Aarav Shrestha',
  email: 'demo@ledgerline.app',
};

export const demoOrganizations = [
  { id: 'org-annapurna', name: 'Annapurna Digital', role: 'Owner', fiscalYear: 'FY 2082/83' },
  { id: 'org-sherpa', name: 'Sherpa Ventures', role: 'Accountant', fiscalYear: 'FY 2082/83' },
];

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
    if (body.email !== 'demo@ledgerline.app' || body.password !== 'ledger123') {
      return fail('invalid_credentials', 'Email or password is incorrect', 401);
    }
    return ok({ user: demoUser, accessToken: 'mock-access-token' });
  }),

  http.post('/api/v1/auth/register', async ({ request }) => {
    const body = await request.json();
    await delay(120);
    return ok(
      {
        user: { ...demoUser, name: body.name, email: body.email },
        accessToken: 'mock-access-token',
      },
      { status: 201 },
    );
  }),

  http.post('/api/v1/auth/refresh', () =>
    ok({ user: demoUser, accessToken: 'mock-refreshed-access-token' }),
  ),

  http.post('/api/v1/auth/logout', () => new HttpResponse(null, { status: 204 })),

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
