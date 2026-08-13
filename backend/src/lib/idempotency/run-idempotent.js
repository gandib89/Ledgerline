import { createHash } from 'node:crypto';
import { prisma } from '../../db/client.js';

function hashBody(body) {
  return createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex');
}

export async function runIdempotent({ key, endpoint, requestBody }, performWrite) {
  const requestHash = hashBody(requestBody);

  return prisma.$transaction(async (tx) => {
    let created;
    try {
      created = await tx.idempotencyKey.create({
        data: { key, endpoint, requestHash, responseStatus: null, responseBody: null },
      });
    } catch (err) {
      if (err.code !== 'P2002') throw err;

      const existing = await tx.idempotencyKey.findFirst({ where: { key } });

      if (!existing || existing.requestHash !== requestHash) {
        const conflictErr = new Error('Idempotency key already used with a different request body');
        conflictErr.status = 422;
        conflictErr.code = 'idempotency_key_reuse';
        throw conflictErr;
      }

      if (existing.responseStatus == null) {
        const conflictErr = new Error('Request with this idempotency key is still in progress');
        conflictErr.status = 409;
        conflictErr.code = 'idempotency_in_progress';
        throw conflictErr;
      }

      return { replayed: true, status: existing.responseStatus, body: existing.responseBody };
    }

    const { status, body } = await performWrite(tx);

    await tx.idempotencyKey.update({
      where: { id: created.id },
      data: { responseStatus: status, responseBody: body },
    });

    return { replayed: false, status, body };
  });
}
