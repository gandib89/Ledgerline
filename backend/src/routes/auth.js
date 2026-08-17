import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { registerUser } from '../lib/auth/register.js';
import { loginUser } from '../lib/auth/login.js';
import { rotateRefreshToken, revokeFamily } from '../lib/auth/refresh-tokens.js';
import { signAccessToken } from '../lib/auth/tokens.js';
import { env } from '../env.js';
import { authLimiter } from '../lib/rate-limit.js';

const router = Router();

function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return undefined;
  const match = header.split('; ').find((entry) => entry.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : undefined;
}

const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'strict',
  path: '/api/v1/auth',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
}).strict();

router.post('/register', authLimiter, async (req, res, next) => {
  try {
    const { email, password } = registerSchema.parse(req.body);
    const { user, accessToken, refreshToken } = await registerUser(email, password);

    res.cookie('refreshToken', refreshToken, REFRESH_COOKIE_OPTIONS);
    res.status(201).json({ user: { id: user.id, email: user.email }, accessToken });
  } catch (err) {
    next(err);
  }
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
}).strict();

router.post('/login', authLimiter, async (req, res, next) => {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const { user, accessToken, refreshToken } = await loginUser(email, password);

    res.cookie('refreshToken', refreshToken, REFRESH_COOKIE_OPTIONS);
    res.status(200).json({ user: { id: user.id, email: user.email }, accessToken });
  } catch (err) {
    next(err);
  }
});

router.post('/refresh', async (req, res, next) => {
  try {
    const rawToken = getCookie(req, 'refreshToken');
    if (!rawToken) {
      const err = new Error('Refresh token missing');
      err.status = 401;
      err.code = 'refresh_invalid';
      throw err;
    }

    const result = await rotateRefreshToken(rawToken);
    if (result.error) {
      res.clearCookie('refreshToken', { path: '/api/v1/auth' });
      const err = new Error('Refresh token invalid, reused, or expired');
      err.status = 401;
      err.code = 'refresh_invalid';
      throw err;
    }

    // The client keeps its access token in memory only, so after a page reload
    // it needs the user back too — otherwise it holds a valid session it cannot
    // render. One round trip instead of a second /auth/me call.
    const user = await prisma.user.findUnique({ where: { id: result.userId } });

    res.cookie('refreshToken', result.raw, REFRESH_COOKIE_OPTIONS);
    res.json({
      user: { id: user.id, email: user.email },
      accessToken: signAccessToken(result.userId),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    const rawToken = getCookie(req, 'refreshToken');
    if (rawToken) {
      await revokeFamily(rawToken);
    }
    res.clearCookie('refreshToken', { path: '/api/v1/auth' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
