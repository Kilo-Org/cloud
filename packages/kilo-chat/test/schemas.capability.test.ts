import { describe, it, expect } from 'vitest';
import { capabilitySchema, capabilityListSchema } from '../src/schemas';

describe('capabilitySchema', () => {
  it('accepts "attachments"', () => {
    expect(capabilitySchema.safeParse('attachments').success).toBe(true);
  });
  it('rejects unknown capability strings', () => {
    expect(capabilitySchema.safeParse('foo').success).toBe(false);
  });
});

describe('capabilityListSchema', () => {
  it('retains only known capabilities and drops unknowns', () => {
    const result = capabilityListSchema.safeParse(['attachments', 'foo', 'bar']);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(['attachments']);
    }
  });

  it('returns empty array when all capabilities are unknown', () => {
    const result = capabilityListSchema.safeParse(['foo', 'bar']);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual([]);
    }
  });
});
