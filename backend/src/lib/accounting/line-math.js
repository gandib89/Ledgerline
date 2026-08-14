import { add, sub, mul, round2, dec } from '../money.js';

// Pure: no I/O, no clock, no randomness. Round at each named boundary
// (discount, tax, line total), then sum the rounded values — never sum
// unrounded values and round at the end (§6 worked example 2).
export function computeLine({ quantity, unitPrice, discountPct = 0, taxRate = 0 }) {
  const gross = mul(quantity, unitPrice);

  const discountAmount = round2(gross.times(discountPct).dividedBy(100));
  const taxableAmount = round2(sub(gross, discountAmount));
  const taxAmount = round2(mul(taxableAmount, taxRate));
  const lineTotal = round2(add(taxableAmount, taxAmount));

  return { discountAmount, taxableAmount, taxAmount, lineTotal };
}

// Document totals are the sum of already-rounded line values, so grandTotal
// always equals Σ debit on the journal entry, exactly (§6, test INV-11).
export function sumLines(lines) {
  return lines.reduce(
    (totals, line) => ({
      subtotal: add(totals.subtotal, add(line.taxableAmount, line.discountAmount)),
      discountAmount: add(totals.discountAmount, line.discountAmount),
      taxableAmount: add(totals.taxableAmount, line.taxableAmount),
      taxAmount: add(totals.taxAmount, line.taxAmount),
      grandTotal: add(totals.grandTotal, line.lineTotal),
    }),
    { subtotal: dec(0), discountAmount: dec(0), taxableAmount: dec(0), taxAmount: dec(0), grandTotal: dec(0) }
  );
}
