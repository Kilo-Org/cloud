import { describe, it, expect } from 'vitest';
import { capabilitySchema, capabilityListSchema } from '../src/schemas';

describe('capabilitySchema', () => {
  it('accepts "attachments"', () => {
    expect(capabilitySchema.safeParse('attachments').success).toBe(true);
  });
  it('rejects unknown capability strings', () => {
    expect(capabilitySchema.safeParse('foo').success).toBe(false);
  });
  it('rejects non-string input', () => {
    expect(capabilitySchema.safeParse(42).success).toBe(false);
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

  it('returns single known capability', () => {
    const result = capabilityListSchema.safeParse(['attachments']);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(['attachments']);
    }
  });

  it('returns empty array for empty input', () => {
    const result = capabilityListSchema.safeParse([]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual([]);
    }
  });
});
