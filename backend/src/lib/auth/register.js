import { prisma } from '../../db/client.js';
import { hashPassword } from './password.js';
import { issueRefreshToken } from './refresh-tokens.js';
import { signAccessToken } from './tokens.js';

export async function registerUser(email, password) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    const err = new Error('Email already registered');
    err.status = 400;
    err.code = 'email_taken';
    throw err;
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({ data: { email, passwordHash } });

  const accessToken = signAccessToken(user.id);
  const { raw: refreshToken } = await issueRefreshToken(user.id);

  return { user, accessToken, refreshToken };
}
