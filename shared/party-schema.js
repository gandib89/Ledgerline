export const PARTY_TYPES = ['customer', 'supplier', 'both'];

export function createPartySchemas(z) {
  const fields = {
    type: z.enum(PARTY_TYPES),
    code: z.string().trim().min(1, 'Code is required'),
    name: z.string().trim().min(1, 'Name is required'),
    email: z.string().trim().email('Enter a valid email').optional(),
    phone: z.string().trim().optional(),
    creditDays: z.number().int().min(0, 'Credit days must be 0 or more').optional(),
  };

  const createPartySchema = z.object(fields).strict();
  const updatePartySchema = z.object({
    type: fields.type.optional(),
    code: fields.code.optional(),
    name: fields.name.optional(),
    email: fields.email.nullable(),
    phone: fields.phone.nullable(),
    creditDays: fields.creditDays,
    isActive: z.boolean().optional(),
  }).strict().refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field is required',
  });

  return { createPartySchema, updatePartySchema };
}
