import { describe, expect, it } from 'vitest';
import { diffAuditValues, formatAuditValue } from './audit-diff.js';

describe('diffAuditValues', () => {
  it('reports added, removed, and changed fields in stable key order', () => {
    expect(diffAuditValues(
      { amount: '1130.00', obsolete: true, status: 'DRAFT' },
      { amount: '1130.00', requestId: 'req-1', status: 'POSTED' },
    )).toEqual([
      { field: 'obsolete', kind: 'removed', before: true, after: undefined },
      { field: 'requestId', kind: 'added', before: undefined, after: 'req-1' },
      { field: 'status', kind: 'changed', before: 'DRAFT', after: 'POSTED' },
    ]);
  });

  it('treats missing objects as empty and compares nested values by content', () => {
    expect(diffAuditValues(null, { allocation: { amount: '100000.00' } })).toEqual([
      { field: 'allocation', kind: 'added', before: undefined, after: { amount: '100000.00' } },
    ]);
    expect(diffAuditValues({ nested: { a: 1 } }, { nested: { a: 1 } })).toEqual([]);
  });
});

describe('formatAuditValue', () => {
  it('keeps missing, null, text, and object values readable', () => {
    expect(formatAuditValue(undefined)).toBe('Not set');
    expect(formatAuditValue(null)).toBe('null');
    expect(formatAuditValue('POSTED')).toBe('POSTED');
    expect(formatAuditValue({ amount: '1130.00' })).toBe('{\n  "amount": "1130.00"\n}');
  });
});
