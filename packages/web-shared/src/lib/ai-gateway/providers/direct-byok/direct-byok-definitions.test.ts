import { describe, expect, test } from '@jest/globals';
import DIRECT_BYOK_PROVIDERS from './direct-byok-definitions';
import { DIRECT_BYOK_PROVIDERS_META } from './direct-byok-meta';
import { formatDirectByokModelId } from './index';
import type { DirectByokModel } from './types';

function model(id: string): DirectByokModel {
  return { id, name: id, context_length: 4096, max_completion_tokens: 1024 };
}

describe('direct BYOK provider registry', () => {
  test('registers each provider id once', () => {
    const ids = DIRECT_BYOK_PROVIDERS.map(provider => provider.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  test('names exactly the registered providers in the shared metadata', () => {
    expect(DIRECT_BYOK_PROVIDERS.map(provider => provider.id).sort()).toEqual(
      Object.keys(DIRECT_BYOK_PROVIDERS_META).sort()
    );
  });

  test.each(DIRECT_BYOK_PROVIDERS.map(provider => [provider.id, provider] as const))(
    'formats %s model ids as its lowercase id prefix',
    (providerId, provider) => {
      const formatted = formatDirectByokModelId(provider, model('Vendor/Model-ID'));

      expect(formatted).toBe(`${providerId}/vendor/model-id`);
      expect(formatted).toBe(formatted.toLowerCase());
      expect(formatted.startsWith(`${providerId}/`)).toBe(true);
    }
  );

  test('gives the same model id to only one provider', () => {
    const formatted = DIRECT_BYOK_PROVIDERS.map(provider =>
      formatDirectByokModelId(provider, model('shared-model'))
    );

    expect(new Set(formatted).size).toBe(formatted.length);
  });
});
