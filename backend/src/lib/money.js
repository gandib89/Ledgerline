import { Decimal } from '@prisma/client/runtime/client';

// Convert any raw value into Prisma's Decimal type for precise money calculations.
// in raw js 0.1 + 0.2 =0.30000000000000004;bad for handling money
// prisma fixes this new Decimal("0.1").plus("0.2")=0.3
// and instead of writing new decimal(100.444)
//                        new decimal(invoices)
// we can just use dec(invoices)
// dec is just a wrapper
export function dec(value) {
  return new Decimal(value);
}
export function add(a, b) {
  return dec(a).plus(dec(b));
}

export function sub(a, b) {
  return dec(a).minus(dec(b));
}

export function mul(a, b) {
  return dec(a).times(dec(b));
}

export function round2(a) {
  return dec(a).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}
//round2("10.123") = 10.12

export function eq(a, b) {
  return dec(a).equals(dec(b));
}
// "Are these two money values equal?"
// dont do a===b as this is in decimal 
// do eq(10,10)

export function isZero(a) {
  return dec(a).isZero();
}
export function assertDecimal(value, name = 'value') {
  if (!(value instanceof Decimal)) {
    throw new TypeError(`${name} must be a Decimal — use dec() to convert. Got: ${typeof value}`);
  }
  return value;
}