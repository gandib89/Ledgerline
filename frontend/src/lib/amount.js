const DECIMAL_RE = /^-?\d+(?:\.\d{1,2})?$/;

export function toCents(value) {
  if (typeof value !== 'string' || !DECIMAL_RE.test(value)) {
    throw new TypeError('Amount must be a decimal string with at most two decimal places');
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return negative ? -cents : cents;
}

export function fromCents(value) {
  const negative = value < 0n;
  const unsigned = negative ? -value : value;
  return `${negative ? '-' : ''}${unsigned / 100n}.${(unsigned % 100n).toString().padStart(2, '0')}`;
}

export function sumAmounts(values) {
  return fromCents(values.reduce((total, value) => total + toCents(value), 0n));
}

export function remainingAmount(total, allocations) {
  return fromCents(toCents(total) - toCents(sumAmounts(allocations)));
}

export function isAllocationValid(total, allocations) {
  try {
    const totalCents = toCents(total);
    const amounts = allocations.map(toCents);
    return totalCents > 0n
      && amounts.every((amount) => amount >= 0n)
      && amounts.reduce((sum, amount) => sum + amount, 0n) <= totalCents;
  } catch {
    return false;
  }
}
