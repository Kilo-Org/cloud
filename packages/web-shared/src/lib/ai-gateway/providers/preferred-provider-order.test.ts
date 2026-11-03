import { describe, expect, it } from '@jest/globals';
import {
  PreferredProviderOrderConfigSchema,
  type PreferredProviderOrderConfig,
} from '@kilocode/db/schema-types';
import {
  EMPTY_PREFERRED_PROVIDER_ORDER_CONFIG,
  findPreferredProviderOrderRuleIndex,
  resolvePreferredProviderOrder,
} from '@kilocode/web-shared/lib/ai-gateway/providers/preferred-provider-order';

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

  it('returns no providers for the empty config', () => {
    expect(
      resolvePreferredProviderOrder(EMPTY_PREFERRED_PROVIDER_ORDER_CONFIG, 'vendor/model-x')
    ).toEqual([]);
  });

  it('returns a copy that callers can mutate', () => {
    resolvePreferredProviderOrder(config, 'vendor/model-x').push('provider-z');
    expect(config.rules[0].providers).toEqual(['provider-a', 'provider-b']);
  });

  it.each([
    ['vendor/model-x', 0],
    ['vendor/model-x-lite', 1],
    ['other/model-z-lite', -1],
  ])('finds the first matching rule index for %s', (model, index) => {
    expect(findPreferredProviderOrderRuleIndex(config, model)).toBe(index);
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
