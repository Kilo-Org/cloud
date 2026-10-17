import { describe, it, expect } from 'vitest';
import { RigOverrideConfigSchema } from './types';

describe('RigOverrideConfigSchema agent limits', () => {
  it('accepts max_concurrent_polecats at both bounds', () => {
    expect(RigOverrideConfigSchema.parse({ max_concurrent_polecats: 1 })).toEqual({
      max_concurrent_polecats: 1,
    });
    expect(RigOverrideConfigSchema.parse({ max_concurrent_polecats: 50 })).toEqual({
      max_concurrent_polecats: 50,
    });
  });

  it('accepts max_dispatch_attempts at both bounds', () => {
    expect(RigOverrideConfigSchema.parse({ max_dispatch_attempts: 1 })).toEqual({
      max_dispatch_attempts: 1,
    });
    expect(RigOverrideConfigSchema.parse({ max_dispatch_attempts: 20 })).toEqual({
      max_dispatch_attempts: 20,
    });
  });

  it('rejects max_concurrent_polecats above the ceiling', () => {
    expect(() => RigOverrideConfigSchema.parse({ max_concurrent_polecats: 51 })).toThrow();
    expect(() => RigOverrideConfigSchema.parse({ max_concurrent_polecats: 100000 })).toThrow();
  });

  it('rejects max_dispatch_attempts above the ceiling', () => {
    expect(() => RigOverrideConfigSchema.parse({ max_dispatch_attempts: 21 })).toThrow();
    expect(() => RigOverrideConfigSchema.parse({ max_dispatch_attempts: 100000 })).toThrow();
  });

  it('rejects zero and negative values', () => {
    expect(() => RigOverrideConfigSchema.parse({ max_concurrent_polecats: 0 })).toThrow();
    expect(() => RigOverrideConfigSchema.parse({ max_concurrent_polecats: -3 })).toThrow();
    expect(() => RigOverrideConfigSchema.parse({ max_dispatch_attempts: 0 })).toThrow();
    expect(() => RigOverrideConfigSchema.parse({ max_dispatch_attempts: -1 })).toThrow();
  });

  it('rejects non-integer values', () => {
    expect(() => RigOverrideConfigSchema.parse({ max_concurrent_polecats: 2.5 })).toThrow();
    expect(() => RigOverrideConfigSchema.parse({ max_dispatch_attempts: 1.5 })).toThrow();
  });

  it('leaves other fields unrestricted by the limit bounds', () => {
    const parsed = RigOverrideConfigSchema.parse({
      default_model: 'openai/gpt-4o',
      max_concurrent_polecats: 10,
      max_dispatch_attempts: 5,
    });
    expect(parsed.default_model).toBe('openai/gpt-4o');
  });
});
