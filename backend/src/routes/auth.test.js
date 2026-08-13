import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { prisma } from '../db/client.js';
import { resetDb, seedRoles } from '../test/helpers.js';

beforeAll(async () => {
  await resetDb();
  await seedRoles();
});

afterAll(() => prisma.$disconnect());

// Supertest's cookie jar is per-agent; these tests drive the raw header instead
// so a single test can hold two *different* generations of the same cookie.
function cookieFrom(res) {
  return res.headers['set-cookie'][0].split(';')[0];
}

describe('auth flow', () => {
  it('registers a user, returns an access token and a hardened refresh cookie', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'flow@test.com', password: 'password123' });

    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('flow@test.com');
    expect(res.body.accessToken).toBeTruthy();
    // The password hash must never cross the wire, in any form.
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');

    const cookie = res.headers['set-cookie'][0];
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/api/v1/auth');
  });

  it('rejects a duplicate email', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'flow@test.com', password: 'password123' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('email_taken');
  });

  it('stores the password hashed, never in plaintext', async () => {
    const user = await prisma.user.findUnique({ where: { email: 'flow@test.com' } });
    expect(user.passwordHash).not.toContain('password123');
    expect(user.passwordHash.startsWith('$argon2id$')).toBe(true);
  });

  it('logs in with correct credentials', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'flow@test.com', password: 'password123' });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
  });

  // If these two diverged, the API would become an oracle for which emails are
  // registered — the reason both paths share one message.
  it('gives an identical error for a wrong password and an unknown email', async () => {
    const wrongPassword = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'flow@test.com', password: 'wrong-password' });

    const unknownEmail = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@test.com', password: 'wrong-password' });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body.error.code).toBe(unknownEmail.body.error.code);
    expect(wrongPassword.body.error.message).toBe(unknownEmail.body.error.message);
  });

  it('rejects an unknown key in the body (.strict blocks mass assignment)', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'extra@test.com', password: 'password123', isAdmin: true });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });
});

describe('refresh token rotation', () => {
  it('rotates: the refresh call issues a brand new token', async () => {
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'flow@test.com', password: 'password123' });
    const first = cookieFrom(login);

    const refreshed = await request(app).post('/api/v1/auth/refresh').set('Cookie', first);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.accessToken).toBeTruthy();
    expect(cookieFrom(refreshed)).not.toBe(first);
    // The client holds its access token in memory, so a reload needs the user
    // back from this call too — otherwise it has a session it cannot render.
    expect(refreshed.body.user.email).toBe('flow@test.com');
  });

  it('detects reuse and revokes the whole family', async () => {
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'flow@test.com', password: 'password123' });
    const tokenA = cookieFrom(login);

    const rotated = await request(app).post('/api/v1/auth/refresh').set('Cookie', tokenA);
    const tokenB = cookieFrom(rotated);

    // Replaying A — already consumed — is the stolen-token signal.
    const replay = await request(app).post('/api/v1/auth/refresh').set('Cookie', tokenA);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('refresh_invalid');

    // B was never used, but it shares A's family, so it dies with it. This is
    // the assertion that separates real reuse detection from just marking A used.
    const sibling = await request(app).post('/api/v1/auth/refresh').set('Cookie', tokenB);
    expect(sibling.status).toBe(401);
  });

  it('rejects a refresh with no cookie', async () => {
    const res = await request(app).post('/api/v1/auth/refresh');
    expect(res.status).toBe(401);
  });

  it('logout revokes the family server-side', async () => {
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'flow@test.com', password: 'password123' });
    const cookie = cookieFrom(login);

    const loggedOut = await request(app).post('/api/v1/auth/logout').set('Cookie', cookie);
    expect(loggedOut.status).toBe(204);

    // A client-only logout is not a logout — the token must be dead server-side.
    const afterLogout = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie);
    expect(afterLogout.status).toBe(401);
  });
});