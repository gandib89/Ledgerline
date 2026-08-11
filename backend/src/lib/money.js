import { Decimal } from '@prisma/client/runtime/library';

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