import { describe, expect, it } from '@jest/globals';
import { getEffectiveProviderPrivacy } from './provider-privacy';
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
