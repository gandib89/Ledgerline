import { describe, expect, it } from 'vitest';
import { DEMO_SCENARIO, validateDemoScenario } from './demo-data.js';

describe('Day 6 exact demo scenario', () => {
  it('matches the Section 14 opening balance, invoices, rent, and receipts', () => {
    expect(DEMO_SCENARIO.opening).toEqual({
      date: '2025-07-17', reference: 'DEMO-OPENING-2082', amount: '500000.00',
      bankAccountCode: '1020', capitalAccountCode: '3100', narration: 'Demo opening balance',
    });
    expect(DEMO_SCENARIO.invoices.map(({ date, customerCode, reference, revenueAccountCode, quantity, unitPrice, taxableAmount, vatAmount, total }) => ({
      date, customerCode, reference, revenueAccountCode, quantity, unitPrice, taxableAmount, vatAmount, total,
    }))).toEqual([
      { date: '2026-01-12', customerCode: 'CUS-001', reference: 'DEMO-INV-HIMALAYAN', revenueAccountCode: '4100', quantity: '15', unitPrice: '8000.00', taxableAmount: '120000.00', vatAmount: '15600.00', total: '135600.00' },
      { date: '2026-01-25', customerCode: 'CUS-002', reference: 'DEMO-INV-EVEREST', revenueAccountCode: '4200', quantity: '1', unitPrice: '45000.00', taxableAmount: '45000.00', vatAmount: '5850.00', total: '50850.00' },
      { date: '2026-02-18', customerCode: 'CUS-003', reference: 'DEMO-INV-SAGARMATHA', revenueAccountCode: '4100', quantity: '1', unitPrice: '30000.00', taxableAmount: '30000.00', vatAmount: '3900.00', total: '33900.00' },
    ]);
    expect(DEMO_SCENARIO.rent).toMatchObject({ date: '2026-01-20', amount: '25000.00', expenseAccountCode: '5300', bankAccountCode: '1020' });
    expect(DEMO_SCENARIO.receipts).toEqual([
      { date: '2026-02-05', customerCode: 'CUS-001', invoiceReference: 'DEMO-INV-HIMALAYAN', reference: 'NEFT8834512', amount: '100000.00' },
      { date: '2026-02-08', customerCode: 'CUS-002', invoiceReference: 'DEMO-INV-EVEREST', reference: 'IPS2210094', amount: '50850.00' },
    ]);
  });

  it('contains the exact four-line Nabil statement and expected closing totals', () => {
    expect(DEMO_SCENARIO.statement).toMatchObject({
      fileName: 'nabil-current-jan-feb-2026.csv', openingBalance: '500000.00', closingBalance: '624720.00',
      serviceCharge: '1130.00', bankName: 'Nabil Bank', accountNoMasked: '****9231',
    });
    expect(DEMO_SCENARIO.statement.csv).toBe([
      'Date,Description,Reference,Debit,Credit,Balance',
      '2026-01-20,RENT PAYMENT ANNAPURNA COMPLEX PVT LTD,CHQ 004821,25000.00,,475000.00',
      '2026-02-05,NEFT/HIMALAYAN TREK SUPPLIES/INV-2082-0001,NEFT8834512,,100000.00,575000.00',
      '2026-02-08,IPS/EVEREST CAFE PVT LTD,IPS2210094,,50850.00,625850.00',
      '2026-02-25,MONTHLY SERVICE CHARGE,,1130.00,,624720.00',
    ].join('\n'));
    expect(DEMO_SCENARIO.expected).toEqual({
      receivables: '69500.00', overdue: '35600.00', cash: '624720.00', revenue: '195000.00',
      expenses: '26130.00', netProfit: '168870.00', reconciliationDifference: '0.00',
    });
    expect(validateDemoScenario(DEMO_SCENARIO)).toBe(true);
  });
});
