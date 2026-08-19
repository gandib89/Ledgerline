export const AUDIT_PAGE_SIZE = 25;

export async function listAuditEntries(db, organizationId, filters = {}) {
  const page = filters.page ?? 1;
  const where = { organizationId };
  if (filters.entityType) where.entityType = filters.entityType;
  if (filters.entityId) where.entityId = filters.entityId;
  if (filters.actorId) where.userId = filters.actorId;

  const entries = await db.auditLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * AUDIT_PAGE_SIZE,
    take: AUDIT_PAGE_SIZE,
  });

  const actorIds = [...new Set(entries.map(({ userId }) => userId).filter(Boolean))];
  const actors = actorIds.length
    ? await db.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, email: true } })
    : [];
  const actorById = new Map(actors.map((actor) => [actor.id, actor]));

  return entries.map((entry) => ({
    id: entry.id,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    before: entry.before,
    after: entry.after,
    actorId: entry.userId,
    actor: entry.userId ? actorById.get(entry.userId) ?? { id: entry.userId, email: null } : null,
    ipAddress: entry.ipAddress,
    requestId: entry.requestId,
    createdAt: entry.createdAt.toISOString(),
  }));
}
