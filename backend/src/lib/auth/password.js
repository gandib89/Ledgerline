import { hash, verify } from '@node-rs/argon2';

const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export function hashPassword(plain) {
  return hash(plain, OPTIONS);
}

export function verifyPassword(plain, hashed) {
  return verify(hashed, plain);
}
