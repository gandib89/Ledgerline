import { prisma } from '../../db/client.js';

// organizationId is normally injected by the tenant extension from request
// context. Routes that run before tenancy exists (org creation) must pass it
// explicitly, since the column is NOT NULL.
export async function writeAuditLog({ organizationId, userId, action, entityType, entityId, before, after, ipAddress, requestId }) {
  await prisma.auditLog.create({
    data: { organizationId, userId, action, entityType, entityId, before, after, ipAddress, requestId },
  });
}
