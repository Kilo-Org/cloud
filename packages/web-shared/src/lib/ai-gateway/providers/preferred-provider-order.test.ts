import { describe, expect, it } from '@jest/globals';
import {
  PreferredProviderOrderConfigSchema,
  type PreferredProviderOrderConfig,
} from '@kilocode/db/schema-types';
import {
  PREFERRED_PROVIDER_ORDER_FALLBACK_CONFIG,
  resolvePreferredProviderOrder,
} from '@kilocode/web-shared/lib/ai-gateway/providers/preferred-provider-order';

describe('PREFERRED_PROVIDER_ORDER_FALLBACK_CONFIG', () => {
  it('is a valid configuration', () => {
    expect(
      PreferredProviderOrderConfigSchema.safeParse(PREFERRED_PROVIDER_ORDER_FALLBACK_CONFIG).success
    ).toBe(true);
  });

  it.each([
    ['openai/gpt-5.5', ['openai']],
    ['openai/o3', ['openai']],
    ['gpt-5.5', ['openai']],
    ['openai/gpt-oss-120b', []],
    ['anthropic/claude-sonnet-4.5', ['google-vertex', 'amazon-bedrock']],
    ['minimax/minimax-m3', ['minimax/fp8']],
    ['mistralai/mistral-large', ['mistral']],
    ['moonshotai/kimi-k3', ['amazon-bedrock', 'alibaba']],
    ['stepfun/step-4', ['stepfun']],
    ['deepseek/deepseek-v4-pro', ['novita']],
    ['z-ai/glm-5.2', ['friendli', 'novita']],
    ['qwen/qwen3.7-coder', ['alibaba']],
    ['google/gemini-3-pro', []],
  ])('resolves %s to %j', (model, providers) => {
    expect(resolvePreferredProviderOrder(PREFERRED_PROVIDER_ORDER_FALLBACK_CONFIG, model)).toEqual(
      providers
    );
  });
});

describe('resolvePreferredProviderOrder', () => {
  const config: PreferredProviderOrderConfig = {
    rules: [
      {
        includes: ['model-x', 'model-y'],
        excludes: ['-lite'],
        providers: ['provider-a', 'provider-b'],
      },
      { includes: ['vendor/'], providers: ['provider-c'] },
    ],
  };

  it.each(['vendor/model-x', 'model-y'])('matches any include in %s', model => {
    expect(resolvePreferredProviderOrder(config, model)).toEqual(['provider-a', 'provider-b']);
  });

  it('skips a rule when an exclude matches and continues with the next rule', () => {
    expect(resolvePreferredProviderOrder(config, 'vendor/model-x-lite')).toEqual(['provider-c']);
  });

  it('returns no providers when nothing matches', () => {
    expect(resolvePreferredProviderOrder(config, 'other/model-z-lite')).toEqual([]);
  });

  it('returns a copy that callers can mutate', () => {
    resolvePreferredProviderOrder(config, 'vendor/model-x').push('provider-z');
    expect(config.rules[0].providers).toEqual(['provider-a', 'provider-b']);
  });
});

describe('PreferredProviderOrderConfigSchema', () => {
  it('accepts a rule without excludes', () => {
    const config = { rules: [{ includes: ['claude'], providers: ['google-vertex'] }] };
    expect(PreferredProviderOrderConfigSchema.safeParse(config).success).toBe(true);
  });

  it.each([
    ['no includes', { includes: [], providers: ['openai'] }],
    ['no providers', { includes: ['a'], providers: [] }],
    ['duplicate includes', { includes: ['a', 'a'], providers: ['openai'] }],
    ['duplicate excludes', { includes: ['a'], excludes: ['b', 'b'], providers: ['openai'] }],
    [
      'an include that is also excluded',
      { includes: ['a'], excludes: ['a'], providers: ['openai'] },
    ],
    ['duplicate providers', { includes: ['a'], providers: ['openai', 'openai'] }],
    ['an empty substring', { includes: [' '], providers: ['openai'] }],
    ['an uppercase substring', { includes: ['Claude'], providers: ['openai'] }],
    ['an uppercase provider', { includes: ['a'], providers: ['OpenAI'] }],
    ['a provider with two slashes', { includes: ['a'], providers: ['a/b/c'] }],
    ['the old substring shape', { substring: 'a', providers: ['openai'] }],
  ])('rejects a rule with %s', (_, rule) => {
    expect(PreferredProviderOrderConfigSchema.safeParse({ rules: [rule] }).success).toBe(false);
  });

  it('rejects an object mapping', () => {
    const config = { rules: { claude: ['google-vertex'] } };
    expect(PreferredProviderOrderConfigSchema.safeParse(config).success).toBe(false);
  });
});
