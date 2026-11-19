import { describe, expect, it } from 'vitest';
import {
  MAX_MODEL_CONTEXT_LIMITS,
  MAX_MODEL_CONTEXT_LIMIT_MODEL_LENGTH,
  MAX_MODEL_CONTEXT_TOKENS,
  MIN_MODEL_CONTEXT_TOKENS,
  ModelContextLimitsSchema,
} from '@kilocode/cloud-agent-profile';
import { RuntimeModelContextLimitsSchema, RuntimeProfileLimits } from './runtime-profile.js';

describe('model context limit parity', () => {
  it('keeps the runtime bounds in sync with the profile settings bounds', () => {
    expect(RuntimeProfileLimits.MAX_MODEL_CONTEXT_LIMITS).toBe(MAX_MODEL_CONTEXT_LIMITS);
    expect(RuntimeProfileLimits.MAX_MODEL_CONTEXT_LIMIT_MODEL_LENGTH).toBe(
      MAX_MODEL_CONTEXT_LIMIT_MODEL_LENGTH
    );
    expect(RuntimeProfileLimits.MIN_MODEL_CONTEXT_TOKENS).toBe(MIN_MODEL_CONTEXT_TOKENS);
    expect(RuntimeProfileLimits.MAX_MODEL_CONTEXT_TOKENS).toBe(MAX_MODEL_CONTEXT_TOKENS);
  });

  it('accepts and rejects the same payloads on both sides', () => {
    const cases: unknown[] = [
      { 'openai/gpt-6.1-sol': 300_000 },
      {},
      { 'openai/gpt-6.1-sol': MIN_MODEL_CONTEXT_TOKENS - 1 },
      { 'openai/gpt-6.1-sol': MAX_MODEL_CONTEXT_TOKENS + 1 },
      { 'openai/gpt-6.1-sol': 300_000.5 },
      Object.fromEntries(
        Array.from({ length: MAX_MODEL_CONTEXT_LIMITS + 1 }, (_, index) => [
          `model-${index}`,
          300_000,
        ])
      ),
    ];
    for (const payload of cases) {
      expect(RuntimeModelContextLimitsSchema.safeParse(payload).success).toBe(
        ModelContextLimitsSchema.safeParse(payload).success
      );
    }
  });
});
