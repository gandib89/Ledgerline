import { describe, expect, it } from 'vitest';
import { invoiceFormSchema, invoiceInput } from './invoice-form.js';

const validForm = {
  partyId: '11111111-1111-4111-8111-111111111111',
  docDate: '2025-07-20',
  dueDate: '2025-08-19',
  referenceNo: 'PO-44',
  notes: 'Deliver to warehouse',
  version: 3,
  subtotal: '100000.00',
  grandTotal: '113000.00',
  lines: [{
    clientId: 'line-1',
    accountId: '22222222-2222-4222-8222-222222222222',
    description: 'Trekking backpacks',
    quantity: '10',
    unitPrice: '10000',
    discountPct: '0',
    taxCodeId: '33333333-3333-4333-8333-333333333333',
  }],
};

describe('invoice form', () => {
  it('accepts a complete invoice and rejects a due date before the document date', () => {
    expect(invoiceFormSchema.safeParse(validForm).success).toBe(true);

    const invalid = invoiceFormSchema.safeParse({ ...validForm, dueDate: '2025-07-19' });
    expect(invalid.success).toBe(false);
    expect(invalid.error.issues[0]).toMatchObject({ path: ['dueDate'], message: 'Due date cannot be before document date' });
  });

  it('returns clear line-level errors for required accounting inputs', () => {
    const invalid = invoiceFormSchema.safeParse({
      ...validForm,
      partyId: '',
      lines: [{ ...validForm.lines[0], description: '', accountId: '', quantity: '0' }],
    });

    expect(invalid.success).toBe(false);
    expect(invalid.error.issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
      'Customer is required',
      'Description is required',
      'Revenue account is required',
      'Quantity must be greater than zero',
    ]));
  });

  it('builds a backend payload without client totals or local line identifiers', () => {
    const payload = invoiceInput(invoiceFormSchema.parse(validForm));

    expect(payload).toEqual({
      partyId: validForm.partyId,
      docDate: '2025-07-20',
      dueDate: '2025-08-19',
      referenceNo: 'PO-44',
      notes: 'Deliver to warehouse',
      version: 3,
      lines: [{
        accountId: validForm.lines[0].accountId,
        description: 'Trekking backpacks',
        quantity: 10,
        unitPrice: 10000,
        discountPct: 0,
        taxCodeId: validForm.lines[0].taxCodeId,
      }],
    });
    expect(payload).not.toHaveProperty('subtotal');
    expect(payload).not.toHaveProperty('grandTotal');
  });
});
