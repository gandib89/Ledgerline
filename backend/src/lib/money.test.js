import { describe, it, expect } from 'vitest';
import { add, round2, eq, isZero } from './money.js';
import { assertDecimal } from './money.js';
import { dec } from './money.js';

describe('money', () => {
  it('adds without floating point error', () => {
    expect(add('0.1', '0.2').toString()).toBe('0.3');
  });

  it('rounds half-up', () => {
    expect(round2('2.005').toString()).toBe('2.01');
  });

  it('compares by value, not identity', () => {
    expect(eq('10.00', '10')).toBe(true);
  });

  it('detects zero', () => {
    expect(isZero('0.0000')).toBe(true);
  });

  it('assertDecimal rejects non-Decimal values', () => {
    expect(() => assertDecimal(5)).toThrow(TypeError);
    expect(() => assertDecimal(dec('5'))).not.toThrow();
  });
});