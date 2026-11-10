import { z } from 'zod';
import { emptyInvoiceLine, invoiceLineInputs, invoiceLineSchema, invoiceValidationErrors } from './invoice-form.js';

// Bill lines share the invoice line math and shape; only the account message
// differs (Bills use expense/asset accounts, not revenue).
const billLineSchema = invoiceLineSchema.extend({ accountId: z.string().uuid('Account is required') });

export const billLinesSchema = z.array(billLineSchema).min(1, 'Add at least one bill line');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const optionalDate = z.union([z.string().regex(ISO_DATE), z.literal('')]).optional();

export const billFormSchema = z.object({
  partyId: z.string().uuid('Supplier is required'),
  referenceNo: z.string().trim().min(1, 'Supplier reference is required'),
  docDate: z.string().regex(ISO_DATE, 'Bill date is required'),
  postingDate: optionalDate,
  dueDate: optionalDate,
  notes: z.string().optional(),
  version: z.number().int().min(0).optional(),
  lines: billLinesSchema,
}).superRefine((form, context) => {
  if (form.postingDate && form.postingDate < form.docDate) {
    context.addIssue({ code: 'custom', path: ['postingDate'], message: 'Posting date cannot be before bill date' });
  }
  if (form.dueDate && form.dueDate < form.docDate) {
    context.addIssue({ code: 'custom', path: ['dueDate'], message: 'Due date cannot be before bill date' });
  }
});

export { emptyInvoiceLine as emptyBillLine, invoiceLineInputs as billLineInputs, invoiceValidationErrors as billValidationErrors };

export function billInput(form) {
  return {
    partyId: form.partyId,
    referenceNo: form.referenceNo.trim(),
    docDate: form.docDate,
    ...(form.postingDate ? { postingDate: form.postingDate } : {}),
    ...(form.dueDate ? { dueDate: form.dueDate } : {}),
    ...(form.notes?.trim() ? { notes: form.notes.trim() } : {}),
    ...(form.version === undefined ? {} : { version: form.version }),
    lines: invoiceLineInputs(form.lines),
  };
}
