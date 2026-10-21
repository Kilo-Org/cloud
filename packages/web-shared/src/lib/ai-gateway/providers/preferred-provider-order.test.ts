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
      { substring: 'model-x-lite', providers: [] },
      { substring: 'model-x', providers: ['provider-a', 'provider-b'] },
      { substring: 'vendor/', providers: ['provider-c'] },
    ],
  };

  it('uses the first matching rule', () => {
    expect(resolvePreferredProviderOrder(config, 'vendor/model-x')).toEqual([
      'provider-a',
      'provider-b',
    ]);
  });

  it('stops at a matching rule with no providers', () => {
    expect(resolvePreferredProviderOrder(config, 'vendor/model-x-lite')).toEqual([]);
  });

  it('returns no providers when nothing matches', () => {
    expect(resolvePreferredProviderOrder(config, 'other/model-y')).toEqual([]);
  });

  it('returns a copy that callers can mutate', () => {
    resolvePreferredProviderOrder(config, 'vendor/model-x').push('provider-z');
    expect(config.rules[1].providers).toEqual(['provider-a', 'provider-b']);
  });
});

describe('PreferredProviderOrderConfigSchema', () => {
  it.each([
    [
      'duplicate substrings',
      {
        rules: [
          { substring: 'a', providers: [] },
          { substring: 'a', providers: [] },
        ],
      },
    ],
    ['duplicate providers', { rules: [{ substring: 'a', providers: ['openai', 'openai'] }] }],
    ['an empty substring', { rules: [{ substring: ' ', providers: ['openai'] }] }],
    ['an uppercase substring', { rules: [{ substring: 'Claude', providers: ['openai'] }] }],
    ['an uppercase provider', { rules: [{ substring: 'a', providers: ['OpenAI'] }] }],
    ['a provider with two slashes', { rules: [{ substring: 'a', providers: ['a/b/c'] }] }],
    ['an object mapping', { rules: { claude: ['google-vertex'] } }],
  ])('rejects %s', (_, config) => {
    expect(PreferredProviderOrderConfigSchema.safeParse(config).success).toBe(false);
  });
});
