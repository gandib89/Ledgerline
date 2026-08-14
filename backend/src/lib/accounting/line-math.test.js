import { describe, it, expect } from 'vitest';
import { computeLine, sumLines } from './line-math.js';

describe('computeLine', () => {
  it('rounds at each boundary — the §6 worked example 2 rounding case', () => {
    // qty 3 @ 1250.50, 5% discount, 13% VAT.
    // gross 3751.50 -> discount 187.575 rounds to 187.58 (not 187.57).
    const line = computeLine({ quantity: 3, unitPrice: '1250.50', discountPct: 5, taxRate: '0.13' });

    expect(line.discountAmount.toString()).toBe('187.58');
    expect(line.taxableAmount.toString()).toBe('3563.92');
    expect(line.taxAmount.toString()).toBe('463.31');
    expect(line.lineTotal.toString()).toBe('4027.23');
  });

  it('handles zero discount and zero tax', () => {
    const line = computeLine({ quantity: 15, unitPrice: '8000.00', discountPct: 0, taxRate: 0 });

    expect(line.discountAmount.toFixed(2)).toBe('0.00');
    expect(line.taxableAmount.toFixed(2)).toBe('120000.00');
    expect(line.taxAmount.toFixed(2)).toBe('0.00');
    expect(line.lineTotal.toFixed(2)).toBe('120000.00');
  });

  it('matches the §6 worked example 1 invoice line', () => {
    const line = computeLine({ quantity: 15, unitPrice: '8000.00', discountPct: 0, taxRate: '0.13' });

    expect(line.taxableAmount.toFixed(2)).toBe('120000.00');
    expect(line.taxAmount.toFixed(2)).toBe('15600.00');
    expect(line.lineTotal.toFixed(2)).toBe('135600.00');
  });
});

describe('sumLines', () => {
  it('sums already-rounded lines without re-rounding drift (INV-11)', () => {
    const lines = [
      computeLine({ quantity: 15, unitPrice: '8000.00', discountPct: 0, taxRate: '0.13' }),
      computeLine({ quantity: 1, unitPrice: '45000.00', discountPct: 0, taxRate: '0.13' }),
    ];
    const totals = sumLines(lines);

    // grandTotal must equal the sum of each already-rounded lineTotal —
    // this is the invariant that keeps the printed invoice and the ledger
    // in agreement to the paisa.
    expect(totals.grandTotal.toFixed(2)).toBe('186450.00');
    expect(totals.taxAmount.toFixed(2)).toBe('21450.00');
    expect(totals.taxableAmount.toFixed(2)).toBe('165000.00');
  });

  it('returns zero totals for no lines', () => {
    const totals = sumLines([]);
    expect(totals.grandTotal.toFixed(2)).toBe('0.00');
  });
});
