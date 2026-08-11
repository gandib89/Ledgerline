import { describe, expect, it } from 'vitest';
import { formatMoney, isDecimalString } from './money.js';

describe('money formatting', () => {
  it('formats NPR from a decimal string', () => {
    expect(formatMoney('123456.5')).toBe('NPR\u00a0123,456.50');
  });

  it('rounds the display half-up without floating point arithmetic', () => {
    expect(formatMoney('3563.925')).toBe('NPR\u00a03,563.93');
  });

  it('uses accounting parentheses for negative values', () => {
    expect(formatMoney('-1130')).toBe('NPR\u00a0(1,130.00)');
  });

  it('rejects numbers and malformed decimal strings', () => {
    expect(isDecimalString('100.2500')).toBe(true);
    expect(isDecimalString('1,000.00')).toBe(false);
    expect(() => formatMoney(50)).toThrow('Money value must be a decimal string');
  });
});
