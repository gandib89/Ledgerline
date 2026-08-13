import { prisma } from '../../db/client.js';
import { hashPassword, verifyPassword } from './password.js';
import { issueRefreshToken } from './refresh-tokens.js';
import { signAccessToken } from './tokens.js';

let dummyHashPromise;
function getDummyHash() {
  if (!dummyHashPromise) dummyHashPromise = hashPassword('not-a-real-password-000');
  return dummyHashPromise;
}

export async function loginUser(email, password) {
  const user = await prisma.user.findUnique({ where: { email } });
  const hashToCheck = user ? user.passwordHash : await getDummyHash();
  const valid = await verifyPassword(password, hashToCheck);

  if (!user || !valid) {
    const err = new Error('Invalid email or password');
    err.status = 401;
    err.code = 'invalid_credentials';
    throw err;
  }

  const accessToken = signAccessToken(user.id);
  const { raw: refreshToken } = await issueRefreshToken(user.id);

  return { user, accessToken, refreshToken };
}
