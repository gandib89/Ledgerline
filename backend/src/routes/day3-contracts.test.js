import { describe, expect, it } from 'vitest';
import {
  buildInvoiceDateFilter,
  serializeOrganizationMembership,
  serializeTaxCode,
} from './day3-contracts.js';

describe('Day 3 browser contracts', () => {
  it('keeps the tax rate exact and exposes only selector fields', () => {
    const taxCode = serializeTaxCode({
      id: 'tax-1',
      code: 'VAT13',
      name: 'VAT 13%',
      rate: { toFixed: (places) => (places === 4 ? '0.1300' : 'wrong') },
      type: 'VAT',
      isActive: true,
      organizationId: 'private-org-id',
      outputAccountId: 'private-account-id',
    });

    expect(taxCode).toEqual({
      id: 'tax-1',
      code: 'VAT13',
      name: 'VAT 13%',
      rate: '0.1300',
      type: 'VAT',
      isActive: true,
    });
  });

  it('exposes the current membership role and sorted permission codes', () => {
    const membership = serializeOrganizationMembership({
      organization: {
        id: 'org-1',
        name: 'Annapurna Trading',
        isActive: true,
        createdAt: new Date('2026-08-14T00:00:00.000Z'),
      },
      role: {
        id: 'role-1',
        name: 'Owner',
        rolePermissions: [
          { permission: { code: 'report.view' } },
          { permission: { code: 'invoice.post' } },
        ],
      },
    });

    expect(membership).toEqual({
      id: 'org-1',
      name: 'Annapurna Trading',
      isActive: true,
      createdAt: new Date('2026-08-14T00:00:00.000Z'),
      role: { id: 'role-1', name: 'Owner' },
      permissions: ['invoice.post', 'report.view'],
    });
  });

  it('builds inclusive invoice date boundaries without adding absent bounds', () => {
    expect(buildInvoiceDateFilter({ from: '2025-07-20', to: '2025-07-25' })).toEqual({
      docDate: {
        gte: new Date('2025-07-20T00:00:00.000Z'),
        lte: new Date('2025-07-25T00:00:00.000Z'),
      },
    });
    expect(buildInvoiceDateFilter({})).toEqual({});
  });
});
