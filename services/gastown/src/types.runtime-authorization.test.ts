import { describe, expect, it } from 'vitest';
import { TownConfigUpdateSchema } from './types';

describe('TownConfigUpdateSchema', () => {
  it.each(['owner_user_id', 'owner_type', 'owner_id', 'organization_id', 'created_by_user_id'])(
    'rejects public mutation of %s',
    field => {
      expect(TownConfigUpdateSchema.safeParse({ [field]: 'attacker' }).success).toBe(false);
    }
  );

  it('accepts ordinary public configuration', () => {
    expect(TownConfigUpdateSchema.safeParse({ default_model: 'openai/gpt-5' }).success).toBe(true);
  });
});
