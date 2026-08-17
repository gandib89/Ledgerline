import { describe, expect, it } from 'vitest';
import { fromCents, isAllocationValid, remainingAmount, sumAmounts, toCents } from './amount.js';

describe('decimal-safe amount helpers', () => {
  it('converts decimal strings without floating point arithmetic', () => {
    expect(toCents('113000.25')).toBe(11300025n);
    expect(toCents('-1.5')).toBe(-150n);
    expect(fromCents(-150n)).toBe('-1.50');
  });

  it('adds allocations and returns the unallocated remainder', () => {
    expect(sumAmounts(['35.25', '10.00'])).toBe('45.25');
    expect(remainingAmount('100.00', ['35.25', '10.00'])).toBe('54.75');
  });

  it('rejects malformed, negative, and over-total allocations', () => {
    expect(isAllocationValid('100.00', ['80.00', '20.00'])).toBe(true);
    expect(isAllocationValid('100.00', ['80.00', '20.01'])).toBe(false);
    expect(isAllocationValid('100.00', ['-1.00'])).toBe(false);
    expect(() => toCents('1,000.00')).toThrow('Amount must be a decimal string');
  });
});
