import { describe, expect, it } from '@jest/globals';
import {
  composeProviderPreferences,
  getEffectiveProviderPrivacy,
  providerPreferencesSchema,
  providerPrivacySchema,
} from './provider-privacy';
import type { OpenRouterProviderConfig } from './providers/openrouter/types';

describe('getEffectiveProviderPrivacy', () => {
  it.each([
    ['deny', 'allow', 'deny'],
    ['allow', 'deny', 'deny'],
    ['deny', 'deny', 'deny'],
    ['allow', 'allow', 'allow'],
    [undefined, 'deny', 'deny'],
    [undefined, 'allow', 'allow'],
    ['deny', undefined, 'deny'],
    ['allow', null, 'allow'],
  ] as const)(
    'combines request %s and organization %s as %s',
    (requestDataCollection, organizationDataCollection, expected) => {
      expect(
        getEffectiveProviderPrivacy(
          { data_collection: requestDataCollection },
          organizationDataCollection
        )
      ).toEqual({ data_collection: expected });
    }
  );

  it.each([undefined, null] as const)(
    'leaves absent privacy absent with organization %s',
    setting => {
      expect(getEffectiveProviderPrivacy(undefined, setting)).toEqual({});
    }
  );

  it.each([true, false])('preserves zdr: %s independently of data collection', zdr => {
    expect(getEffectiveProviderPrivacy({ zdr })).toEqual({ zdr });
    expect(getEffectiveProviderPrivacy({ zdr }, 'allow')).toEqual({
      data_collection: 'allow',
      zdr,
    });
    expect(getEffectiveProviderPrivacy({ zdr }, 'deny')).toEqual({ data_collection: 'deny', zdr });
  });

  it('returns only privacy settings without changing request provider options', () => {
    const requestProvider: OpenRouterProviderConfig = {
      data_collection: 'allow',
      zdr: true,
      only: ['openai'],
      ignore: ['azure'],
      sort: 'latency',
    };

    expect(getEffectiveProviderPrivacy(requestProvider, 'deny')).toEqual({
      data_collection: 'deny',
      zdr: true,
    });
    expect(requestProvider).toEqual({
      data_collection: 'allow',
      zdr: true,
      only: ['openai'],
      ignore: ['azure'],
      sort: 'latency',
    });
  });
});

describe('composeProviderPreferences', () => {
  it('returns the request provider unchanged when the organization requires nothing', () => {
    const requestProvider: OpenRouterProviderConfig = {
      data_collection: 'allow',
      zdr: true,
      only: ['openai'],
      ignore: ['azure'],
      order: ['openai', 'anthropic'],
    };
    const effectivePrivacy = getEffectiveProviderPrivacy(requestProvider);

    expect(
      composeProviderPreferences({
        requestProvider,
        organizationOnly: undefined,
        effectivePrivacy,
      })
    ).toEqual({ kind: 'eligible', provider: requestProvider });
  });

  it('keeps the request options while the organization privacy wins', () => {
    const requestProvider: OpenRouterProviderConfig = {
      data_collection: 'allow',
      zdr: false,
      order: ['openai'],
      sort: 'latency',
      require_parameters: true,
      max_price: { prompt: 1, completion: 2 },
    };

    expect(
      composeProviderPreferences({
        requestProvider,
        organizationOnly: undefined,
        effectivePrivacy: getEffectiveProviderPrivacy(requestProvider, 'deny'),
      })
    ).toEqual({
      kind: 'eligible',
      provider: {
        data_collection: 'deny',
        zdr: false,
        order: ['openai'],
        sort: 'latency',
        require_parameters: true,
        max_price: { prompt: 1, completion: 2 },
      },
    });
  });

  it('intersects the request only list with the organization routes', () => {
    const requestProvider: OpenRouterProviderConfig = { only: ['openai', 'azure'] };

    expect(
      composeProviderPreferences({
        requestProvider,
        organizationOnly: ['openai', 'anthropic'],
        effectivePrivacy: getEffectiveProviderPrivacy(requestProvider),
      })
    ).toEqual({ kind: 'eligible', provider: { only: ['openai'] } });
  });

  it('drops an ignored provider from the intersection and keeps the ignore list', () => {
    const requestProvider: OpenRouterProviderConfig = {
      only: ['openai', 'azure'],
      ignore: ['azure'],
    };

    expect(
      composeProviderPreferences({
        requestProvider,
        organizationOnly: ['openai', 'azure'],
        effectivePrivacy: getEffectiveProviderPrivacy(requestProvider),
      })
    ).toEqual({ kind: 'eligible', provider: { only: ['openai'], ignore: ['azure'] } });
  });

  it('uses the organization routes when the request has no only list', () => {
    const requestProvider: OpenRouterProviderConfig = { ignore: ['azure'], zdr: true };
    expect(
      composeProviderPreferences({
        requestProvider,
        organizationOnly: ['openai', 'azure'],
        effectivePrivacy: getEffectiveProviderPrivacy(requestProvider),
      })
    ).toEqual({ kind: 'eligible', provider: { ignore: ['azure'], zdr: true, only: ['openai'] } });
  });

  it.each<[OpenRouterProviderConfig, string[]]>([
    [{ only: ['azure'] }, ['openai']],
    [{ ignore: ['openai'] }, ['openai']],
  ])('reports no eligible provider for request %j and routes %j', (requestProvider, routes) => {
    expect(
      composeProviderPreferences({
        requestProvider,
        organizationOnly: routes,
        effectivePrivacy: getEffectiveProviderPrivacy(requestProvider),
      })
    ).toEqual({ kind: 'none' });
  });

  it('treats an empty request only list as no restriction', () => {
    const noRestriction: OpenRouterProviderConfig = { only: [] };
    expect(
      composeProviderPreferences({
        requestProvider: noRestriction,
        organizationOnly: undefined,
        effectivePrivacy: getEffectiveProviderPrivacy(noRestriction),
      })
    ).toEqual({ kind: 'eligible', provider: { only: [] } });

    expect(
      composeProviderPreferences({
        requestProvider: noRestriction,
        organizationOnly: ['openai', 'azure'],
        effectivePrivacy: getEffectiveProviderPrivacy(noRestriction),
      })
    ).toEqual({ kind: 'eligible', provider: { only: ['openai', 'azure'] } });
  });

  it('leaves the provider undefined when neither the request nor the organization sets one', () => {
    expect(
      composeProviderPreferences({
        requestProvider: undefined,
        organizationOnly: undefined,
        effectivePrivacy: {},
      })
    ).toEqual({ kind: 'eligible', provider: undefined });
  });
});

describe('providerPrivacySchema', () => {
  it.each([
    null,
    [],
    'deny',
    { data_collection: true },
    { data_collection: 'invalid' },
    { zdr: 'true' },
  ])('rejects invalid privacy preferences: %j', provider => {
    expect(providerPrivacySchema.safeParse(provider).success).toBe(false);
  });

  it('only exposes validated privacy fields', () => {
    expect(
      providerPrivacySchema.parse({
        data_collection: 'deny',
        zdr: true,
        only: ['openai'],
        api_key: 'untrusted-client-key',
      })
    ).toEqual({ data_collection: 'deny', zdr: true });
  });
});

describe('providerPreferencesSchema', () => {
  it.each([
    {},
    { only: ['openai'], ignore: ['azure'], order: ['openai', 'anthropic'] },
    { only: [], ignore: [], order: [] },
    { only: null, ignore: null, order: null },
    {
      only: ['openai'],
      data_collection: 'deny',
      zdr: true,
      sort: 'latency',
      require_parameters: true,
      allow_fallbacks: false,
      max_price: { prompt: 1, completion: 2 },
      future_option: { enabled: true },
    },
  ])('accepts valid provider preferences: %j', provider => {
    expect(providerPreferencesSchema.safeParse(provider).success).toBe(true);
  });

  it.each([
    null,
    [],
    'openai',
    { only: [['openai']] },
    { only: 'openai' },
    { only: { openai: true } },
    { only: [1] },
    { only: [null] },
    { ignore: [['azure']] },
    { ignore: 'azure' },
    { ignore: [{ id: 'azure' }] },
    { order: [['openai']] },
    { order: 'openai' },
    { order: [true] },
    { zdr: 'true' },
  ])('rejects malformed provider preferences: %j', provider => {
    expect(providerPreferencesSchema.safeParse(provider).success).toBe(false);
  });
});
