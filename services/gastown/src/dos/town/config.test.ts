import { describe, it, expect } from 'vitest';
import { TownConfigSchema } from '../../types';
import { resolveModel } from './config';

const HARDCODED_FALLBACK = 'anthropic/claude-sonnet-4.6';
const DUMMY_RIG = 'rig-test';

/** Parse a minimal TownConfig through the Zod schema (applies defaults). */
function makeTownConfig(
  overrides: { default_model?: string; role_models?: Record<string, string> } = {}
) {
  return TownConfigSchema.parse(overrides);
}

describe('resolveModel', () => {
  it('returns hardcoded fallback when no default_model and no role_models', () => {
    const config = makeTownConfig();
    expect(resolveModel(config, DUMMY_RIG, 'polecat')).toBe(HARDCODED_FALLBACK);
    expect(resolveModel(config, DUMMY_RIG, 'mayor')).toBe(HARDCODED_FALLBACK);
    expect(resolveModel(config, DUMMY_RIG, 'refinery')).toBe(HARDCODED_FALLBACK);
  });

  it('returns default_model when set and no role_models', () => {
    const config = makeTownConfig({ default_model: 'openai/gpt-4o' });
    expect(resolveModel(config, DUMMY_RIG, 'polecat')).toBe('openai/gpt-4o');
    expect(resolveModel(config, DUMMY_RIG, 'mayor')).toBe('openai/gpt-4o');
    expect(resolveModel(config, DUMMY_RIG, 'refinery')).toBe('openai/gpt-4o');
  });

  it('returns mayor-specific model when role_models.mayor is set', () => {
    const config = makeTownConfig({
      default_model: 'openai/gpt-4o',
      role_models: { mayor: 'anthropic/claude-opus-4' },
    });
    expect(resolveModel(config, DUMMY_RIG, 'mayor')).toBe('anthropic/claude-opus-4');
  });

  it('falls back to default_model for roles not overridden in role_models', () => {
    const config = makeTownConfig({
      default_model: 'openai/gpt-4o',
      role_models: { mayor: 'anthropic/claude-opus-4' },
    });
    expect(resolveModel(config, DUMMY_RIG, 'polecat')).toBe('openai/gpt-4o');
    expect(resolveModel(config, DUMMY_RIG, 'refinery')).toBe('openai/gpt-4o');
  });

  it('returns polecat model when set, falls back for other roles', () => {
    const config = makeTownConfig({
      role_models: { polecat: 'google/gemini-2.5-pro' },
    });
    expect(resolveModel(config, DUMMY_RIG, 'polecat')).toBe('google/gemini-2.5-pro');
    // No default_model → hardcoded fallback for other roles
    expect(resolveModel(config, DUMMY_RIG, 'mayor')).toBe(HARDCODED_FALLBACK);
    expect(resolveModel(config, DUMMY_RIG, 'refinery')).toBe(HARDCODED_FALLBACK);
  });

  it('returns role-specific model for all three roles when all overridden', () => {
    const config = makeTownConfig({
      default_model: 'openai/gpt-4o',
      role_models: {
        mayor: 'anthropic/claude-opus-4',
        refinery: 'anthropic/claude-sonnet-4',
        polecat: 'google/gemini-2.5-pro',
      },
    });
    expect(resolveModel(config, DUMMY_RIG, 'mayor')).toBe('anthropic/claude-opus-4');
    expect(resolveModel(config, DUMMY_RIG, 'refinery')).toBe('anthropic/claude-sonnet-4');
    expect(resolveModel(config, DUMMY_RIG, 'polecat')).toBe('google/gemini-2.5-pro');
  });

  it('treats empty role_models the same as no role_models', () => {
    const config = makeTownConfig({
      default_model: 'openai/gpt-4o',
      role_models: {},
    });
    expect(resolveModel(config, DUMMY_RIG, 'polecat')).toBe('openai/gpt-4o');
    expect(resolveModel(config, DUMMY_RIG, 'mayor')).toBe('openai/gpt-4o');
  });

  it('treats undefined role_models the same as no role_models', () => {
    const config = makeTownConfig({ default_model: 'openai/gpt-4o' });
    expect(config.role_models).toBeUndefined();
    expect(resolveModel(config, DUMMY_RIG, 'polecat')).toBe('openai/gpt-4o');
  });

  it('falls back to default_model for unknown role strings', () => {
    const config = makeTownConfig({
      default_model: 'openai/gpt-4o',
      role_models: { mayor: 'anthropic/claude-opus-4' },
    });
    expect(resolveModel(config, DUMMY_RIG, 'unknown-role')).toBe('openai/gpt-4o');
    expect(resolveModel(config, DUMMY_RIG, '')).toBe('openai/gpt-4o');
  });

  it('falls back to hardcoded fallback for unknown role with no default_model', () => {
    const config = makeTownConfig({
      role_models: { mayor: 'anthropic/claude-opus-4' },
    });
    expect(resolveModel(config, DUMMY_RIG, 'unknown-role')).toBe(HARDCODED_FALLBACK);
  });
});

describe('resolveModel backward compatibility', () => {
  it('works with a config that has no role_models field (legacy town)', () => {
    // Simulate a legacy config stored before role_models existed
    const legacyRaw = {
      env_vars: {},
      default_model: 'openai/gpt-4o',
    };
    const config = TownConfigSchema.parse(legacyRaw);
    expect(config.role_models).toBeUndefined();
    expect(resolveModel(config, DUMMY_RIG, 'polecat')).toBe('openai/gpt-4o');
    expect(resolveModel(config, DUMMY_RIG, 'mayor')).toBe('openai/gpt-4o');
    expect(resolveModel(config, DUMMY_RIG, 'refinery')).toBe('openai/gpt-4o');
  });

  it('works with a completely empty config (new town defaults)', () => {
    const config = TownConfigSchema.parse({});
    expect(config.role_models).toBeUndefined();
    expect(config.default_model).toBeUndefined();
    expect(resolveModel(config, DUMMY_RIG, 'polecat')).toBe(HARDCODED_FALLBACK);
    expect(resolveModel(config, DUMMY_RIG, 'mayor')).toBe(HARDCODED_FALLBACK);
  });

  it('preserves resolution chain: role override > default_model > hardcoded', () => {
    const config = makeTownConfig({
      default_model: 'openai/gpt-4o',
      role_models: { polecat: 'google/gemini-2.5-pro' },
    });
    // polecat: role override wins
    expect(resolveModel(config, DUMMY_RIG, 'polecat')).toBe('google/gemini-2.5-pro');
    // mayor: no role override → default_model
    expect(resolveModel(config, DUMMY_RIG, 'mayor')).toBe('openai/gpt-4o');

    // Remove default_model to test final fallback
    const configNoDefault = makeTownConfig({
      role_models: { polecat: 'google/gemini-2.5-pro' },
    });
    // refinery: no role override, no default → hardcoded
    expect(resolveModel(configNoDefault, DUMMY_RIG, 'refinery')).toBe(HARDCODED_FALLBACK);
  });
});
