import { resolveEffectiveModel } from './model-selection';
import type { CodeReviewAgentConfig } from '@kilocode/db/schema-types';

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
