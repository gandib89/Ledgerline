import { verifyAccessToken } from '../lib/auth/tokens.js';

export function authenticate(req, res, next) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    const err = new Error('Missing access token');
    err.status = 401;
    err.code = 'unauthenticated';
    return next(err);
  }

  try {
    req.userId = verifyAccessToken(token).sub;
    next();
  } catch {
    const err = new Error('Invalid or expired access token');
    err.status = 401;
    err.code = 'unauthenticated';
    next(err);
  }
}