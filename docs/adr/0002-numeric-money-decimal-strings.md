# Money is NUMERIC(18,4) in Postgres, Decimal in code, and a decimal string in JSON

Every monetary column is `NUMERIC(18,4)` (Prisma `Decimal @db.Decimal(18, 4)`), all arithmetic goes through `Prisma.Decimal` via the helpers in `lib/money.js` (`dec`, `add`, `sub`, `mul`, `round2`), and amounts cross the API as decimal strings, never JSON numbers. The frontend formats them and never does arithmetic on them. We rejected floats because binary floating point cannot represent most decimal amounts exactly, and the drift compounds silently until a reconciliation fails months later. We rejected integer minor units (paisa) because tax and line math need more precision than two decimals before the final rounding, and a single storage scale of 4 with an explicit rounding step (`round2`, half-up) keeps one rounding boundary instead of one per calculation. Strings in JSON avoid JS `number`'s 15-significant-digit limit.

## Consequences

- An ESLint `no-restricted-syntax` rule is meant to ban raw `+`, `parseFloat` and `Number()` in money code, pointing developers to the `lib/money.js` helpers. Its `files` scope must cover the folders where money code actually lives.
- Only monetary amounts are `(18,4)`. Other Decimal columns use different sizes on purpose: tax rate `(5,4)`, quantity `(18,6)`, discount percentage `(5,2)`, and match confidence `(4,3)`.
- New money code (bills, supplier payments, AP aging) must use the same helpers and serialize amounts as decimal strings.
