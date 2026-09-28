import { describe, expect, it } from '@jest/globals';
import { getEffectiveProviderPrivacy, providerPrivacySchema } from './provider-privacy';
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
