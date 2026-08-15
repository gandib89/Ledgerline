import { computeLine } from './line-math.js';
import { notFound, businessRule } from './errors.js';
import { dec } from '../money.js';

// Shared by invoices and credit notes — both are a list of user-supplied
// lines (account, quantity, rate, discount, tax code) that need the exact
// same tax/rounding computation and the exact same 404-not-403 existence
// check (§6 validation layers: a valid UUID from another org must fail as
// not-found, not forbidden — revealing existence is itself a leak).

// DocumentLine has no discountAmount column — only discountPct is stored per
// line (§5); discountAmount only exists as a computed value for sumLines'
// document-level aggregation. Strip it before writing a line row.
export function toDocumentLineData({ discountAmount: _discountAmount, ...line }) {
  return line;
}

// Totals are never accepted from the client — only quantity/rate/discount/tax
// code come in; taxableAmount, taxAmount, lineTotal are recomputed here from
// scratch every time (§6 validation layers).
export async function resolveLines(tx, organizationId, lineInputs) {
  if (!lineInputs || lineInputs.length === 0) {
    // Kept as 'empty_invoice' verbatim from the pre-extraction code (moved
    // here unchanged from invoice-service.js) — credit notes reuse this same
    // check and get the same code; the Zod .min(1) at the route boundary
    // means this rarely fires for either caller anyway.
    throw businessRule('empty_invoice', 'A document needs at least one line');
  }

  const accountIds = [...new Set(lineInputs.map((l) => l.accountId))];
  const taxCodeIds = [...new Set(lineInputs.filter((l) => l.taxCodeId).map((l) => l.taxCodeId))];

  const [accounts, taxCodes] = await Promise.all([
    tx.account.findMany({ where: { organizationId, id: { in: accountIds } } }),
    taxCodeIds.length ? tx.taxCode.findMany({ where: { organizationId, id: { in: taxCodeIds } } }) : [],
  ]);
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const taxCodeById = new Map(taxCodes.map((t) => [t.id, t]));

  for (const line of lineInputs) {
    if (!accountById.has(line.accountId)) throw notFound(`Account ${line.accountId} not found`);
    if (line.taxCodeId && !taxCodeById.has(line.taxCodeId)) throw notFound(`Tax code ${line.taxCodeId} not found`);
  }

  return lineInputs.map((input, i) => {
    const taxCode = input.taxCodeId ? taxCodeById.get(input.taxCodeId) : null;
    const computed = computeLine({
      quantity: input.quantity,
      unitPrice: input.unitPrice,
      discountPct: input.discountPct ?? 0,
      taxRate: taxCode?.rate ?? 0,
    });

    return {
      lineNo: i + 1,
      description: input.description,
      accountId: input.accountId,
      quantity: dec(input.quantity),
      unitPrice: dec(input.unitPrice),
      discountPct: dec(input.discountPct ?? 0),
      taxCodeId: input.taxCodeId ?? null,
      ...computed,
    };
  });
}
