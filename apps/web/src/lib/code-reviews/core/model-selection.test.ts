import {
  catalogPricesFromStoredModels,
  resolveCheapSameVendorSmallModel,
  resolveEffectiveModel,
} from './model-selection';
import type { CodeReviewAgentConfig, StoredModel } from '@kilocode/db/schema-types';

const FALLBACK = 'anthropic/claude-sonnet-4.6';

function baseConfig(
  overrides?: CodeReviewAgentConfig['repository_model_overrides'],
  partial?: Partial<CodeReviewAgentConfig>
): Pick<CodeReviewAgentConfig, 'model_slug' | 'thinking_effort' | 'repository_model_overrides'> {
  return {
    model_slug: 'anthropic/claude-opus-4.8',
    thinking_effort: null,
    repository_model_overrides: overrides,
    ...partial,
  };
}

function priced(id: string, prompt: string): StoredModel {
  return {
    id,
    name: id,
    type: 'language',
    endpoints: [{ pricing: { prompt, completion: prompt } }],
  };
}

describe('resolveEffectiveModel', () => {
  it('uses the global model when there are no overrides', () => {
    const result = resolveEffectiveModel(baseConfig(), 'acme/api', FALLBACK);
    expect(result).toEqual({
      modelSlug: 'anthropic/claude-opus-4.8',
      thinkingEffort: null,
      source: 'global',
    });
  });

  it('falls back to the provided fallback when the global model_slug is empty', () => {
    const result = resolveEffectiveModel(
      baseConfig(undefined, { model_slug: '' }),
      'acme/api',
      FALLBACK
    );
    expect(result).toEqual({ modelSlug: FALLBACK, thinkingEffort: null, source: 'global' });
  });

  it('applies a matching override by repo_full_name', () => {
    const result = resolveEffectiveModel(
      baseConfig([
        {
          repository_id: 123,
          repo_full_name: 'acme/api',
          model_slug: 'openai/gpt-5',
          thinking_effort: 'high',
        },
      ]),
      'acme/api',
      FALLBACK
    );
    expect(result).toEqual({
      modelSlug: 'openai/gpt-5',
      thinkingEffort: 'high',
      source: 'repository_override',
    });
  });

  it('matches on repo_full_name regardless of the override id type (Bitbucket UUID)', () => {
    const result = resolveEffectiveModel(
      baseConfig([
        {
          repository_id: '9b3c1d2e-0000-4000-8000-000000000000',
          repo_full_name: 'workspace/repo',
          model_slug: 'openai/gpt-5',
        },
      ]),
      'workspace/repo',
      FALLBACK
    );
    expect(result.modelSlug).toBe('openai/gpt-5');
    expect(result.source).toBe('repository_override');
  });

  it('falls back to global when no override matches the repo', () => {
    const result = resolveEffectiveModel(
      baseConfig([
        { repository_id: 123, repo_full_name: 'acme/other', model_slug: 'openai/gpt-5' },
      ]),
      'acme/api',
      FALLBACK
    );
    expect(result.source).toBe('global');
    expect(result.modelSlug).toBe('anthropic/claude-opus-4.8');
  });

  it('does not match a different repo name (no coercion / substring matching)', () => {
    const result = resolveEffectiveModel(
      baseConfig([{ repository_id: 1, repo_full_name: 'acme/api', model_slug: 'openai/gpt-5' }]),
      'acme/api-internal',
      FALLBACK
    );
    expect(result.source).toBe('global');
  });

  it('treats a blank override model_slug as no override', () => {
    const result = resolveEffectiveModel(
      baseConfig([{ repository_id: 1, repo_full_name: 'acme/api', model_slug: '' }]),
      'acme/api',
      FALLBACK
    );
    expect(result.source).toBe('global');
    expect(result.modelSlug).toBe('anthropic/claude-opus-4.8');
  });

  it('defaults a matching override thinking effort to null when omitted', () => {
    const result = resolveEffectiveModel(
      baseConfig([{ repository_id: 1, repo_full_name: 'acme/api', model_slug: 'openai/gpt-5' }]),
      'acme/api',
      FALLBACK
    );
    expect(result.thinkingEffort).toBeNull();
  });

  it('uses the global model when the review has no repo name', () => {
    const result = resolveEffectiveModel(
      baseConfig([{ repository_id: 1, repo_full_name: 'acme/api', model_slug: 'openai/gpt-5' }]),
      null,
      FALLBACK
    );
    expect(result.source).toBe('global');
  });
});

describe('resolveCheapSameVendorSmallModel', () => {
  const catalog = catalogPricesFromStoredModels({
    'anthropic/claude-sonnet-4.6': priced('anthropic/claude-sonnet-4.6', '0.000003'),
    'anthropic/claude-haiku-4.5': priced('anthropic/claude-haiku-4.5', '0.0000008'),
    'anthropic/claude-opus-4.6': priced('anthropic/claude-opus-4.6', '0.000015'),
    'openai/gpt-5': priced('openai/gpt-5', '0.00001'),
    'openai/gpt-5-nano': priced('openai/gpt-5-nano', '0.0000001'),
  });

  it('picks the cheapest strictly-cheaper same-vendor sibling', () => {
    expect(resolveCheapSameVendorSmallModel('anthropic/claude-sonnet-4.6', catalog)).toBe(
      'anthropic/claude-haiku-4.5'
    );
  });

  it('does not cross vendors', () => {
    expect(resolveCheapSameVendorSmallModel('openai/gpt-5', catalog)).toBe('openai/gpt-5-nano');
  });

  it('leaves managed models unset when no cheaper sibling exists', () => {
    expect(resolveCheapSameVendorSmallModel('anthropic/claude-haiku-4.5', catalog)).toBeUndefined();
  });

  it('falls back to the primary for sole-model direct-BYOK vendors', () => {
    expect(resolveCheapSameVendorSmallModel('neuralwatt/glm-5.2-short', catalog)).toBe(
      'neuralwatt/glm-5.2-short'
    );
  });

  it('picks a cheaper BYOK sibling when catalog prices exist', () => {
    const byokCatalog = catalogPricesFromStoredModels({
      'neuralwatt/glm-5.2-short': priced('neuralwatt/glm-5.2-short', '0.000002'),
      'neuralwatt/glm-tiny': priced('neuralwatt/glm-tiny', '0.0000001'),
    });
    expect(resolveCheapSameVendorSmallModel('neuralwatt/glm-5.2-short', byokCatalog)).toBe(
      'neuralwatt/glm-tiny'
    );
  });
});
