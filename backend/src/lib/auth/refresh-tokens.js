import { prisma } from '../../db/client.js';
import { randomUUID } from 'node:crypto';
import { generateRefreshToken, hashRefreshToken } from './tokens.js';

export async function issueRefreshToken(userId, familyId = randomUUID()) {
  const { raw, tokenHash, expiresAt } = generateRefreshToken();
  await prisma.refreshToken.create({
    data: { userId, familyId, tokenHash, expiresAt },
  });
  return { raw, familyId };
}

export async function rotateRefreshToken(rawToken) {
  const tokenHash = hashRefreshToken(rawToken);
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });

  if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
    return { error: 'invalid' };
  }

  if (stored.usedAt) {
    await prisma.refreshToken.updateMany({
      where: { familyId: stored.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { error: 'reused' };
  }

  await prisma.refreshToken.update({
    where: { id: stored.id },
    data: { usedAt: new Date() },
  });

  const { raw, familyId } = await issueRefreshToken(stored.userId, stored.familyId);
  return { raw, familyId, userId: stored.userId };
}

export async function revokeFamily(rawToken) {
  const tokenHash = hashRefreshToken(rawToken);
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });
  if (!stored) return;
  await prisma.refreshToken.updateMany({
    where: { familyId: stored.familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
