import { describe, expect, it } from '@jest/globals';
import {
  AgentCreateInputSchema,
  AgentDefaultsUpdateInputSchema,
  AgentIdSchema,
  AgentUpdateInputSchema,
} from './agent-schemas';

describe('AgentIdSchema', () => {
  it('accepts and trims a normal id', () => {
    expect(AgentIdSchema.parse('  work  ')).toBe('work');
  });

  it('rejects empty', () => {
    expect(AgentIdSchema.safeParse('   ').success).toBe(false);
  });

  it('rejects ids longer than 64 chars', () => {
    expect(AgentIdSchema.safeParse('a'.repeat(65)).success).toBe(false);
  });
});

describe('AgentCreateInputSchema', () => {
  it('accepts a minimal valid create body', () => {
    const result = AgentCreateInputSchema.safeParse({
      name: 'Work',
      workspace: '/home/agents/work',
    });
    expect(result.success).toBe(true);
  });

  it('accepts optional model, agentDir, and bindings', () => {
    const result = AgentCreateInputSchema.safeParse({
      name: 'Work',
      workspace: '/home/agents/work',
      agentDir: '/state/work',
      model: 'anthropic/claude-opus-4-8',
      bindings: ['slack:acme', 'telegram'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-absolute workspace', () => {
    expect(
      AgentCreateInputSchema.safeParse({ name: 'Work', workspace: 'relative/path' }).success
    ).toBe(false);
  });

  it('rejects a dash-prefixed name (would be parsed as a CLI flag)', () => {
    expect(
      AgentCreateInputSchema.safeParse({ name: '--rm', workspace: '/home/agents/work' }).success
    ).toBe(false);
  });

  it('rejects a dash-prefixed binding value', () => {
    expect(
      AgentCreateInputSchema.safeParse({
        name: 'Work',
        workspace: '/home/agents/work',
        bindings: ['-x'],
      }).success
    ).toBe(false);
  });

  it('rejects unknown keys (strict)', () => {
    expect(
      AgentCreateInputSchema.safeParse({
        name: 'Work',
        workspace: '/home/agents/work',
        persona: 'sneaky',
      }).success
    ).toBe(false);
  });
});

describe('AgentUpdateInputSchema', () => {
  it('accepts a set-only patch', () => {
    expect(AgentUpdateInputSchema.safeParse({ set: { thinkingDefault: 'high' } }).success).toBe(
      true
    );
  });

  it('accepts an unset-only patch', () => {
    expect(AgentUpdateInputSchema.safeParse({ unset: ['model'] }).success).toBe(true);
  });

  it('defaults set/unset and rejects a no-op patch', () => {
    // Neither set nor unset → the refine rejects it.
    expect(AgentUpdateInputSchema.safeParse({}).success).toBe(false);
    expect(AgentUpdateInputSchema.safeParse({ set: {}, unset: [] }).success).toBe(false);
  });

  it('rejects an invalid thinkingDefault enum value', () => {
    expect(AgentUpdateInputSchema.safeParse({ set: { thinkingDefault: 'turbo' } }).success).toBe(
      false
    );
  });

  it('rejects a model with neither primary nor fallbacks', () => {
    expect(AgentUpdateInputSchema.safeParse({ set: { model: {} } }).success).toBe(false);
  });

  it('accepts a model with fallbacks only', () => {
    expect(
      AgentUpdateInputSchema.safeParse({ set: { model: { fallbacks: ['a/b'] } } }).success
    ).toBe(true);
  });

  it('rejects a model with an empty fallbacks array', () => {
    expect(AgentUpdateInputSchema.safeParse({ set: { model: { fallbacks: [] } } }).success).toBe(
      false
    );
  });

  it('rejects an unknown set field (strict)', () => {
    expect(AgentUpdateInputSchema.safeParse({ set: { nope: true } }).success).toBe(false);
  });
});

describe('AgentDefaultsUpdateInputSchema', () => {
  it('accepts model + thinking/verbose', () => {
    expect(
      AgentDefaultsUpdateInputSchema.safeParse({
        set: { thinkingDefault: 'low', verboseDefault: 'on' },
      }).success
    ).toBe(true);
  });

  it('rejects reasoningDefault (not editable at the defaults level)', () => {
    expect(
      AgentDefaultsUpdateInputSchema.safeParse({ set: { reasoningDefault: 'on' } }).success
    ).toBe(false);
  });

  it('rejects fastModeDefault at the defaults level', () => {
    expect(
      AgentDefaultsUpdateInputSchema.safeParse({ set: { fastModeDefault: true } }).success
    ).toBe(false);
  });

  it('rejects a no-op patch', () => {
    expect(AgentDefaultsUpdateInputSchema.safeParse({}).success).toBe(false);
  });
});
