import { describe, expect, it } from 'vitest';
import {
  BuiltinAgentSettingsInputSchema,
  BuiltinAgentSettingsSchema,
  normalizeBuiltinAgentSettings,
} from './builtin-agents';

describe('builtin agent settings', () => {
  it('accepts model and visibility overrides', () => {
    const settings = BuiltinAgentSettingsInputSchema.parse({
      explore: { model: 'kilo/anthropic/claude-haiku-4.5' },
      compaction: { model: 'kilo/anthropic/claude-haiku-4.5', variant: 'low' },
      plan: { disable: true },
    });
    expect(settings).toEqual({
      explore: { model: 'kilo/anthropic/claude-haiku-4.5' },
      compaction: { model: 'kilo/anthropic/claude-haiku-4.5', variant: 'low' },
      plan: { disable: true },
    });
  });

  it('rejects unknown agents and disabled required agents', () => {
    expect(BuiltinAgentSettingsSchema.safeParse({ unknown: { model: 'kilo/test' } }).success).toBe(
      false
    );
    expect(BuiltinAgentSettingsInputSchema.safeParse({ code: { disable: true } }).success).toBe(
      false
    );
    expect(BuiltinAgentSettingsInputSchema.safeParse({ explore: { disable: true } }).success).toBe(
      false
    );
  });

  it('rejects a variant without a model', () => {
    expect(
      BuiltinAgentSettingsInputSchema.safeParse({ compaction: { variant: 'low' } }).success
    ).toBe(false);
  });

  it('drops empty and disallowed rows instead of persisting them', () => {
    const parsed = BuiltinAgentSettingsSchema.parse({ plan: {}, code: { disable: true } });
    expect(normalizeBuiltinAgentSettings(parsed)).toEqual({});
  });
});
