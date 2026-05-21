import { describe, it, expect } from 'vitest';
import { capabilitySchema } from '../src/schemas';

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
