const DECIMAL_PATTERN = /^-?\d+(\.\d{1,4})?$/;

export function isDecimalString(value) {
  return typeof value === 'string' && DECIMAL_PATTERN.test(value);
}

export function formatMoney(value, { currency = 'NPR' } = {}) {
  if (!isDecimalString(value)) {
    throw new TypeError('Money value must be a decimal string');
  }

  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.');
  const paddedFraction = fraction.padEnd(3, '0');
  let cents = BigInt(whole) * 100n + BigInt(paddedFraction.slice(0, 2));

  if (paddedFraction[2] >= '5') {
    cents += 1n;
  }

  const integerPart = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const decimalPart = (cents % 100n).toString().padStart(2, '0');
  const amount = `${integerPart}.${decimalPart}`;

  return `${currency}\u00a0${negative && cents !== 0n ? `(${amount})` : amount}`;
}
