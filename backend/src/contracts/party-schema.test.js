import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createPartySchemas } from '../../../shared/party-schema.js';

const { createPartySchema, updatePartySchema } = createPartySchemas(z);

describe('shared party schemas', () => {
  it('accepts the customer fields used by the create drawer', () => {
    expect(createPartySchema.parse({
      type: 'customer',
      code: 'C-001',
      name: 'Himalayan Stores',
      email: 'accounts@himalayan.test',
      phone: '9800000000',
      creditDays: 30,
    })).toMatchObject({ code: 'C-001', creditDays: 30 });
  });

  it('rejects an update with no changed fields', () => {
    expect(updatePartySchema.safeParse({}).success).toBe(false);
  });

  it('allows optional contact fields to be cleared during an update', () => {
    expect(updatePartySchema.parse({ email: null, phone: null })).toEqual({
      email: null,
      phone: null,
    });
  });
});
