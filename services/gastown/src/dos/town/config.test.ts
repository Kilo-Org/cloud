import { describe, it, expect } from 'vitest';
import { TownConfigSchema } from '../../types';
import { getTownConfig, resolveModel } from './config';

const HARDCODED_FALLBACK = 'anthropic/claude-sonnet-4.6';

/** Parse a minimal TownConfig through the Zod schema (applies defaults). */
function makeTownConfig(
  overrides: { default_model?: string; role_models?: Record<string, string> } = {}
) {
  return TownConfigSchema.parse(overrides);
}

describe('resolveModel', () => {
  it('returns hardcoded fallback when no default_model and no role_models', () => {
    const config = makeTownConfig();
    expect(resolveModel(config, null, 'polecat')).toBe(HARDCODED_FALLBACK);
    expect(resolveModel(config, null, 'mayor')).toBe(HARDCODED_FALLBACK);
    expect(resolveModel(config, null, 'refinery')).toBe(HARDCODED_FALLBACK);
  });

  it('returns default_model when set and no role_models', () => {
    const config = makeTownConfig({ default_model: 'openai/gpt-4o' });
    expect(resolveModel(config, null, 'polecat')).toBe('openai/gpt-4o');
    expect(resolveModel(config, null, 'mayor')).toBe('openai/gpt-4o');
    expect(resolveModel(config, null, 'refinery')).toBe('openai/gpt-4o');
  });

  it('returns mayor-specific model when role_models.mayor is set', () => {
    const config = makeTownConfig({
      default_model: 'openai/gpt-4o',
      role_models: { mayor: 'anthropic/claude-opus-4' },
    });
    expect(resolveModel(config, null, 'mayor')).toBe('anthropic/claude-opus-4');
  });

  it('falls back to default_model for roles not overridden in role_models', () => {
    const config = makeTownConfig({
      default_model: 'openai/gpt-4o',
      role_models: { mayor: 'anthropic/claude-opus-4' },
    });
    expect(resolveModel(config, null, 'polecat')).toBe('openai/gpt-4o');
    expect(resolveModel(config, null, 'refinery')).toBe('openai/gpt-4o');
  });

  it('returns polecat model when set, falls back for other roles', () => {
    const config = makeTownConfig({
      role_models: { polecat: 'google/gemini-2.5-pro' },
    });
    expect(resolveModel(config, null, 'polecat')).toBe('google/gemini-2.5-pro');
    // No default_model → hardcoded fallback for other roles
    expect(resolveModel(config, null, 'mayor')).toBe(HARDCODED_FALLBACK);
    expect(resolveModel(config, null, 'refinery')).toBe(HARDCODED_FALLBACK);
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
    expect(resolveModel(config, null, 'mayor')).toBe('anthropic/claude-opus-4');
    expect(resolveModel(config, null, 'refinery')).toBe('anthropic/claude-sonnet-4');
    expect(resolveModel(config, null, 'polecat')).toBe('google/gemini-2.5-pro');
  });

  it('treats empty role_models the same as no role_models', () => {
    const config = makeTownConfig({
      default_model: 'openai/gpt-4o',
      role_models: {},
    });
    expect(resolveModel(config, null, 'polecat')).toBe('openai/gpt-4o');
    expect(resolveModel(config, null, 'mayor')).toBe('openai/gpt-4o');
  });

  it('treats undefined role_models the same as no role_models', () => {
    const config = makeTownConfig({ default_model: 'openai/gpt-4o' });
    expect(config.role_models).toBeUndefined();
    expect(resolveModel(config, null, 'polecat')).toBe('openai/gpt-4o');
  });

  it('falls back to default_model for unknown role strings', () => {
    const config = makeTownConfig({
      default_model: 'openai/gpt-4o',
      role_models: { mayor: 'anthropic/claude-opus-4' },
    });
    expect(resolveModel(config, null, 'unknown-role')).toBe('openai/gpt-4o');
    expect(resolveModel(config, null, '')).toBe('openai/gpt-4o');
  });

  it('falls back to hardcoded fallback for unknown role with no default_model', () => {
    const config = makeTownConfig({
      role_models: { mayor: 'anthropic/claude-opus-4' },
    });
    expect(resolveModel(config, null, 'unknown-role')).toBe(HARDCODED_FALLBACK);
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
    expect(resolveModel(config, null, 'polecat')).toBe('openai/gpt-4o');
    expect(resolveModel(config, null, 'mayor')).toBe('openai/gpt-4o');
    expect(resolveModel(config, null, 'refinery')).toBe('openai/gpt-4o');
  });

  it('works with a completely empty config (new town defaults)', () => {
    const config = TownConfigSchema.parse({});
    expect(config.role_models).toBeUndefined();
    expect(config.default_model).toBeUndefined();
    expect(resolveModel(config, null, 'polecat')).toBe(HARDCODED_FALLBACK);
    expect(resolveModel(config, null, 'mayor')).toBe(HARDCODED_FALLBACK);
  });

  it('preserves resolution chain: role override > default_model > hardcoded', () => {
    const config = makeTownConfig({
      default_model: 'openai/gpt-4o',
      role_models: { polecat: 'google/gemini-2.5-pro' },
    });
    // polecat: role override wins
    expect(resolveModel(config, null, 'polecat')).toBe('google/gemini-2.5-pro');
    // mayor: no role override → default_model
    expect(resolveModel(config, null, 'mayor')).toBe('openai/gpt-4o');

    // Remove default_model to test final fallback
    const configNoDefault = makeTownConfig({
      role_models: { polecat: 'google/gemini-2.5-pro' },
    });
    // refinery: no role override, no default → hardcoded
    expect(resolveModel(configNoDefault, null, 'refinery')).toBe(HARDCODED_FALLBACK);
  });
});

// Minimal in-memory stand-in for DurableObjectStorage. config.ts only calls
// .get(key) and .put(key, value), so we implement just those two and widen
// to DurableObjectStorage for the test's call sites. The double-cast is
// intentional and isolated to this test fake — production code doesn't cast.
function makeFakeStorage(initial: Map<string, unknown> = new Map()): DurableObjectStorage {
  const store = initial;
  const fake = {
    get: async (key: string) => store.get(key),
    put: async (key: string, value: unknown) => {
      store.set(key, value);
    },
  };
  return fake as unknown as DurableObjectStorage;
}

describe('getTownConfig seeding behavior', () => {
  it('seeds new-style defaults for a fresh town (no persisted config)', async () => {
    const storage = makeFakeStorage();
    const config = await getTownConfig(storage);
    expect(config.merge_strategy).toBe('pr');
    expect(config.staged_convoys_default).toBe(true);
    expect(config.refinery?.review_mode).toBe('comments');
    expect(config.refinery?.auto_resolve_pr_feedback).toBe(true);
    expect(config.refinery?.auto_merge_delay_minutes).toBe(5);
    // And the seeded value is persisted so subsequent reads return the same shape
    const reloaded = await getTownConfig(storage);
    expect(reloaded.merge_strategy).toBe('pr');
  });

  it('does NOT retroactively apply new defaults to an existing persisted config', async () => {
    // Legacy town stored before #2725: no merge_strategy, no refinery, no
    // staged_convoys_default. This mirrors real storage rows from production.
    const legacyRaw = {
      env_vars: {},
      default_model: 'openai/gpt-4o',
    };
    const storage = makeFakeStorage(new Map([['town:config', legacyRaw]]));
    const config = await getTownConfig(storage);
    expect(config.merge_strategy).toBe('direct');
    expect(config.staged_convoys_default).toBe(false);
    expect(config.refinery).toBeUndefined();
  });
});
