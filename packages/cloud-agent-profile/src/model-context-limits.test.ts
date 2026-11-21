import { describe, expect, it } from 'vitest';
import {
  MAX_MODEL_CONTEXT_LIMITS,
  MAX_MODEL_CONTEXT_TOKENS,
  MIN_MODEL_CONTEXT_TOKENS,
  ModelContextLimitsSchema,
  hasModelContextLimits,
  normalizeModelContextLimits,
} from './model-context-limits';

describe('model context limits', () => {
  it('accepts per-model token caps', () => {
    expect(
      ModelContextLimitsSchema.parse({
        'openai/gpt-6.1-sol': 300_000,
        'anthropic/claude-sonnet-4.5': 200_000,
      })
    ).toEqual({ 'openai/gpt-6.1-sol': 300_000, 'anthropic/claude-sonnet-4.5': 200_000 });
  });

  it('rejects caps outside the token bounds and non-integer caps', () => {
    expect(
      ModelContextLimitsSchema.safeParse({ 'openai/gpt-6.1-sol': MIN_MODEL_CONTEXT_TOKENS - 1 })
        .success
    ).toBe(false);
    expect(
      ModelContextLimitsSchema.safeParse({ 'openai/gpt-6.1-sol': MAX_MODEL_CONTEXT_TOKENS + 1 })
        .success
    ).toBe(false);
    expect(ModelContextLimitsSchema.safeParse({ 'openai/gpt-6.1-sol': 300_000.5 }).success).toBe(
      false
    );
    expect(ModelContextLimitsSchema.safeParse({ '': 300_000 }).success).toBe(false);
  });

  it('rejects more models than the limit allows', () => {
    const limits = Object.fromEntries(
      Array.from({ length: MAX_MODEL_CONTEXT_LIMITS + 1 }, (_, index) => [
        `model-${index}`,
        300_000,
      ])
    );
    expect(ModelContextLimitsSchema.safeParse(limits).success).toBe(false);
  });

  it('normalizes away the provider prefix and empty keys', () => {
    const parsed = ModelContextLimitsSchema.parse({
      'kilo/openai/gpt-6.1-sol': 300_000,
      ' openai/gpt-6-sol ': 250_000,
    });
    expect(normalizeModelContextLimits(parsed)).toEqual({
      'openai/gpt-6.1-sol': 300_000,
      'openai/gpt-6-sol': 250_000,
    });
  });

  it('reports whether any limit is configured', () => {
    expect(hasModelContextLimits(undefined)).toBe(false);
    expect(hasModelContextLimits({})).toBe(false);
    expect(hasModelContextLimits({ 'openai/gpt-6.1-sol': 300_000 })).toBe(true);
  });
});
