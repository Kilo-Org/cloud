import { describe, it, expect } from 'vitest';
import { TownConfigSchema } from '../../types';
import { resolveModel, resolveRigConfig } from './config';

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

describe('resolveRigConfig', () => {
  it('falls back entirely to town config when rigOverride is null', () => {
    const town = TownConfigSchema.parse({
      default_model: 'openai/gpt-4o',
      merge_strategy: 'pr',
      refinery: { review_mode: 'comments', code_review: false },
      custom_instructions: { polecat: 'town polecat', mayor: 'town mayor' },
    });
    const effective = resolveRigConfig(town, null);
    expect(effective.default_model).toBe('openai/gpt-4o');
    expect(effective.merge_strategy).toBe('pr');
    expect(effective.review_mode).toBe('comments');
    expect(effective.code_review).toBe(false);
    expect(effective.custom_instructions.polecat).toBe('town polecat');
    // mayor is always town-level
    expect(effective.custom_instructions.mayor).toBe('town mayor');
  });

  it('falls back entirely to town config when rigOverride is undefined', () => {
    const town = TownConfigSchema.parse({ default_model: 'openai/gpt-4o' });
    const effective = resolveRigConfig(town, undefined);
    expect(effective.default_model).toBe('openai/gpt-4o');
    expect(effective.merge_strategy).toBe('direct');
    expect(effective.review_mode).toBe('rework');
    expect(effective.code_review).toBe(true);
  });

  it('rig override takes precedence over town config for model', () => {
    const town = TownConfigSchema.parse({ default_model: 'openai/gpt-4o' });
    const effective = resolveRigConfig(town, { default_model: 'google/gemini-2.5-pro' });
    expect(effective.default_model).toBe('google/gemini-2.5-pro');
  });

  it('rig role_models override town role_models', () => {
    const town = TownConfigSchema.parse({
      role_models: { polecat: 'openai/gpt-4o', refinery: 'openai/gpt-4o-mini' },
    });
    const effective = resolveRigConfig(town, {
      role_models: { polecat: 'google/gemini-2.5-pro' },
    });
    expect(effective.role_models.polecat).toBe('google/gemini-2.5-pro');
    // refinery falls back to town when rig doesn't override
    expect(effective.role_models.refinery).toBe('openai/gpt-4o-mini');
  });

  it('mayor model is always from town config, never rig override', () => {
    const town = TownConfigSchema.parse({
      role_models: { mayor: 'anthropic/claude-opus-4' },
    });
    // Even if rigOverride had a mayor field, it would not affect this —
    // the function always reads townConfig.role_models?.mayor for mayor.
    const effective = resolveRigConfig(town, { default_model: 'google/gemini-2.5-pro' });
    expect(effective.role_models.mayor).toBe('anthropic/claude-opus-4');
  });

  it('rig merge_strategy overrides town merge_strategy', () => {
    const town = TownConfigSchema.parse({ merge_strategy: 'direct' });
    const effective = resolveRigConfig(town, { merge_strategy: 'pr' });
    expect(effective.merge_strategy).toBe('pr');
  });

  it('rig review_mode overrides town refinery.review_mode', () => {
    const town = TownConfigSchema.parse({ refinery: { review_mode: 'rework' } });
    const effective = resolveRigConfig(town, { review_mode: 'comments' });
    expect(effective.review_mode).toBe('comments');
  });

  it('rig code_review=false skips refinery for that rig only', () => {
    const town = TownConfigSchema.parse({ refinery: { code_review: true } });
    const effective = resolveRigConfig(town, { code_review: false });
    expect(effective.code_review).toBe(false);
  });

  it('rig custom_instructions.polecat overrides town, mayor stays town-level', () => {
    const town = TownConfigSchema.parse({
      custom_instructions: { polecat: 'town polecat', mayor: 'town mayor' },
    });
    const effective = resolveRigConfig(town, {
      custom_instructions: { polecat: 'rig polecat' },
    });
    expect(effective.custom_instructions.polecat).toBe('rig polecat');
    expect(effective.custom_instructions.mayor).toBe('town mayor');
  });

  it('rig git_push_flags are passed through', () => {
    const town = TownConfigSchema.parse({});
    const effective = resolveRigConfig(town, { git_push_flags: '--atomic' });
    expect(effective.git_push_flags).toBe('--atomic');
  });

  it('git_push_flags is undefined when not set on rig', () => {
    const town = TownConfigSchema.parse({});
    const effective = resolveRigConfig(town, null);
    expect(effective.git_push_flags).toBeUndefined();
  });

  it('auto_merge_delay_minutes: null from rig overrides town default', () => {
    const town = TownConfigSchema.parse({
      refinery: { auto_merge_delay_minutes: 30 },
    });
    const effective = resolveRigConfig(town, { auto_merge_delay_minutes: null });
    expect(effective.auto_merge_delay_minutes).toBeNull();
  });

  it('max_concurrent_polecats falls back to townConfig.max_polecats_per_rig', () => {
    const town = TownConfigSchema.parse({ max_polecats_per_rig: 3 });
    const effective = resolveRigConfig(town, null);
    expect(effective.max_concurrent_polecats).toBe(3);
  });

  it('rig max_concurrent_polecats overrides town', () => {
    const town = TownConfigSchema.parse({ max_polecats_per_rig: 3 });
    const effective = resolveRigConfig(town, { max_concurrent_polecats: 1 });
    expect(effective.max_concurrent_polecats).toBe(1);
  });

  it('produces stable defaults when both town and rig are empty', () => {
    const town = TownConfigSchema.parse({});
    const effective = resolveRigConfig(town, null);
    expect(effective.merge_strategy).toBe('direct');
    expect(effective.convoy_merge_mode).toBe('review-then-land');
    expect(effective.review_mode).toBe('rework');
    expect(effective.code_review).toBe(true);
    expect(effective.auto_resolve_pr_feedback).toBe(false);
    expect(effective.auto_merge_delay_minutes).toBeNull();
  });
});
