import { z } from 'zod';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const requiredUuid = (message) => z.string().uuid(message);

const invoiceLineSchema = z.object({
  clientId: z.string(),
  accountId: requiredUuid('Revenue account is required'),
  description: z.string().trim().min(1, 'Description is required'),
  quantity: z.coerce.number().positive('Quantity must be greater than zero'),
  unitPrice: z.coerce.number().min(0, 'Unit price cannot be negative'),
  discountPct: z.coerce.number().min(0, 'Discount cannot be negative').max(100, 'Discount cannot exceed 100%'),
  taxCodeId: z.union([z.string().uuid(), z.literal('')]).optional(),
});

export const invoiceLinesSchema = z.array(invoiceLineSchema).min(1, 'Add at least one invoice line');

export const invoiceFormSchema = z.object({
  partyId: requiredUuid('Customer is required'),
  docDate: z.string().regex(ISO_DATE, 'Document date is required'),
  dueDate: z.union([z.string().regex(ISO_DATE), z.literal('')]).optional(),
  referenceNo: z.string().optional(),
  notes: z.string().optional(),
  version: z.number().int().min(0).optional(),
  lines: invoiceLinesSchema,
}).superRefine((form, context) => {
  if (form.dueDate && form.dueDate < form.docDate) {
    context.addIssue({
      code: 'custom',
      path: ['dueDate'],
      message: 'Due date cannot be before document date',
    });
  }
});

export function emptyInvoiceLine() {
  return {
    clientId: globalThis.crypto.randomUUID(),
    accountId: '',
    description: '',
    quantity: '1',
    unitPrice: '0',
    discountPct: '0',
    taxCodeId: '',
  };
}

export function invoiceInput(form) {
  return {
    partyId: form.partyId,
    docDate: form.docDate,
    ...(form.dueDate ? { dueDate: form.dueDate } : {}),
    ...(form.referenceNo?.trim() ? { referenceNo: form.referenceNo.trim() } : {}),
    ...(form.notes?.trim() ? { notes: form.notes.trim() } : {}),
    ...(form.version === undefined ? {} : { version: form.version }),
    lines: invoiceLineInputs(form.lines),
  };
}

export function invoiceLineInputs(lines) {
  return lines.map((line) => ({
      accountId: line.accountId,
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      discountPct: line.discountPct,
      ...(line.taxCodeId ? { taxCodeId: line.taxCodeId } : {}),
    }));
}

export function invoiceValidationErrors(result) {
  if (result.success) return {};
  return Object.fromEntries(result.error.issues.map((issue) => [issue.path.join('.'), issue.message]));
}
