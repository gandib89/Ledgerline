import { describe, expect, it, vi } from 'vitest';
import { listAuditEntries } from './audit-query.js';

describe('listAuditEntries', () => {
  it('keeps the tenant filter, applies optional filters, and serializes actors newest first', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: 'audit-1', organizationId: 'org-1', userId: 'user-1',
        action: 'invoice.posted', entityType: 'invoice', entityId: 'invoice-1',
        before: { status: 'DRAFT' }, after: { status: 'POSTED' },
        ipAddress: '127.0.0.1', requestId: 'request-1',
        createdAt: new Date('2026-02-18T04:15:00.000Z'),
      },
    ]);
    const userFindMany = vi.fn().mockResolvedValue([
      { id: 'user-1', email: 'sunita@ledgerline.test' },
    ]);
    const db = { auditLog: { findMany }, user: { findMany: userFindMany } };

    const result = await listAuditEntries(db, 'org-1', {
      entityType: 'invoice', entityId: 'invoice-1', actorId: 'user-1', page: 2,
    });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-1', entityType: 'invoice', entityId: 'invoice-1', userId: 'user-1',
      },
      orderBy: { createdAt: 'desc' },
      skip: 25,
      take: 25,
    });
    expect(result).toEqual([{
      id: 'audit-1', action: 'invoice.posted', entityType: 'invoice', entityId: 'invoice-1',
      before: { status: 'DRAFT' }, after: { status: 'POSTED' },
      actorId: 'user-1', actor: { id: 'user-1', email: 'sunita@ledgerline.test' },
      ipAddress: '127.0.0.1', requestId: 'request-1',
      createdAt: '2026-02-18T04:15:00.000Z',
    }]);
  });

  it('uses first-page defaults and does not query users when every entry is system-authored', async () => {
    const findMany = vi.fn().mockResolvedValue([{
      id: 'audit-system', organizationId: 'org-1', userId: null, action: 'seed.completed',
      entityType: 'organization', entityId: 'org-1', before: null, after: null,
      ipAddress: null, requestId: null, createdAt: new Date('2026-02-18T04:00:00.000Z'),
    }]);
    const userFindMany = vi.fn();

    const result = await listAuditEntries(
      { auditLog: { findMany }, user: { findMany: userFindMany } },
      'org-1',
      {},
    );

    expect(findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1' }, orderBy: { createdAt: 'desc' }, skip: 0, take: 25,
    });
    expect(userFindMany).not.toHaveBeenCalled();
    expect(result[0].actor).toBeNull();
  });
});
