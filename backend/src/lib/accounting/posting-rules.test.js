import { describe, it, expect } from 'vitest';
import { POSTING_RULES } from './posting-rules.js';
import { computeLine } from './line-math.js';
import { add, sub } from '../money.js';

const AR = 'acct-1100-ar';
const SALES_GOODS = 'acct-4100-sales-goods';
const SALES_SERVICES = 'acct-4200-sales-services';
const VAT_PAYABLE = 'acct-2200-vat-payable';
const PARTY = 'party-himalayan-trek';

function sumSide(lines, side) {
  return lines.reduce((total, l) => add(total, l[side]), 0);
}

describe('POSTING_RULES.invoice', () => {
  it('matches the §6 worked example 1 — single line invoice', () => {
    const computed = computeLine({ quantity: 15, unitPrice: '8000.00', discountPct: 0, taxRate: '0.13' });

    const lines = POSTING_RULES.invoice({
      partyId: PARTY,
      arAccountId: AR,
      grandTotal: computed.lineTotal,
      lines: [
        {
          accountId: SALES_GOODS,
          taxableAmount: computed.taxableAmount,
          taxAmount: computed.taxAmount,
          taxAccountId: VAT_PAYABLE,
          description: 'Trekking backpacks',
        },
      ],
    });

    expect(lines).toHaveLength(3);

    const ar = lines.find((l) => l.accountId === AR);
    expect(ar.debit.toFixed(2)).toBe('135600.00');
    expect(ar.credit.toFixed(2)).toBe('0.00');
    expect(ar.partyId).toBe(PARTY);

    const sales = lines.find((l) => l.accountId === SALES_GOODS);
    expect(sales.credit.toFixed(2)).toBe('120000.00');
    expect(sales.partyId).toBeNull();

    const vat = lines.find((l) => l.accountId === VAT_PAYABLE);
    expect(vat.credit.toFixed(2)).toBe('15600.00');
  });

  it('keeps each document line on its own revenue account', () => {
    const goods = computeLine({ quantity: 15, unitPrice: '8000.00', discountPct: 0, taxRate: '0.13' });
    const services = computeLine({ quantity: 1, unitPrice: '45000.00', discountPct: 0, taxRate: '0.13' });
    const grandTotal = add(goods.lineTotal, services.lineTotal);

    const lines = POSTING_RULES.invoice({
      partyId: PARTY,
      arAccountId: AR,
      grandTotal,
      lines: [
        { accountId: SALES_GOODS, taxableAmount: goods.taxableAmount, taxAmount: goods.taxAmount, taxAccountId: VAT_PAYABLE, description: 'Backpacks' },
        { accountId: SALES_SERVICES, taxableAmount: services.taxableAmount, taxAmount: services.taxAmount, taxAccountId: VAT_PAYABLE, description: 'Repair' },
      ],
    });

    // Two revenue lines stay separate (different accounts)...
    expect(lines.filter((l) => l.accountId === SALES_GOODS)).toHaveLength(1);
    expect(lines.filter((l) => l.accountId === SALES_SERVICES)).toHaveLength(1);

    // ...but VAT — same output account on both lines — is merged into one.
    const vatLines = lines.filter((l) => l.accountId === VAT_PAYABLE);
    expect(vatLines).toHaveLength(1);
    expect(vatLines[0].credit.toFixed(2)).toBe(add(goods.taxAmount, services.taxAmount).toFixed(2));

    expect(sumSide(lines, 'debit').toFixed(2)).toBe(sumSide(lines, 'credit').toFixed(2));
  });

  it('omits the VAT line entirely for a zero-tax (exempt) line', () => {
    const exempt = computeLine({ quantity: 1, unitPrice: '1000.00', discountPct: 0, taxRate: 0 });

    const lines = POSTING_RULES.invoice({
      partyId: PARTY,
      arAccountId: AR,
      grandTotal: exempt.lineTotal,
      lines: [
        { accountId: SALES_GOODS, taxableAmount: exempt.taxableAmount, taxAmount: exempt.taxAmount, taxAccountId: VAT_PAYABLE, description: 'Exempt item' },
      ],
    });

    expect(lines).toHaveLength(2); // AR + revenue, no zero-value VAT line
    expect(lines.some((l) => l.accountId === VAT_PAYABLE)).toBe(false);
  });

  it('always balances and assigns sequential line numbers', () => {
    const l1 = computeLine({ quantity: 3, unitPrice: '1250.50', discountPct: 5, taxRate: '0.13' });
    const l2 = computeLine({ quantity: 2, unitPrice: '999.99', discountPct: 2, taxRate: '0.13' });

    const lines = POSTING_RULES.invoice({
      partyId: PARTY,
      arAccountId: AR,
      grandTotal: add(l1.lineTotal, l2.lineTotal),
      lines: [
        { accountId: SALES_GOODS, taxableAmount: l1.taxableAmount, taxAmount: l1.taxAmount, taxAccountId: VAT_PAYABLE, description: 'A' },
        { accountId: SALES_SERVICES, taxableAmount: l2.taxableAmount, taxAmount: l2.taxAmount, taxAccountId: VAT_PAYABLE, description: 'B' },
      ],
    });

    expect(sub(sumSide(lines, 'debit'), sumSide(lines, 'credit')).isZero()).toBe(true);
    expect(lines.map((l) => l.lineNumber)).toEqual([1, 2, 3, 4]); // AR + 2 revenue lines + 1 merged VAT line

    for (const l of lines) {
      const debitSet = !l.debit.isZero();
      const creditSet = !l.credit.isZero();
      expect(debitSet !== creditSet).toBe(true); // never both, never neither
    }
  });
});

describe('POSTING_RULES.manual', () => {
  it('passes user-supplied lines through unchanged, numbered in order', () => {
    const lines = POSTING_RULES.manual({
      lines: [
        { accountId: 'acct-a', debit: '500.00', credit: 0, description: 'Correct expense' },
        { accountId: 'acct-b', debit: 0, credit: '500.00', description: 'Wrong expense reversed' },
      ],
    });

    expect(lines).toHaveLength(2);
    expect(lines[0].lineNumber).toBe(1);
    expect(lines[1].lineNumber).toBe(2);
    expect(lines[0].debit.toFixed(2)).toBe('500.00');
    expect(lines[1].credit.toFixed(2)).toBe('500.00');
  });
});
