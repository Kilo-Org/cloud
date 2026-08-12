import { describe, expect, it } from '@jest/globals';
import {
  extractVercelInferenceProviderIdsFromModel,
  getLanguageModelIds,
} from '@/lib/ai-gateway/providers/gateway-models-cache';
import type { StoredModel } from '@kilocode/db';

function storedModel(partial: Partial<StoredModel> & Pick<StoredModel, 'id'>): StoredModel {
  return {
    name: partial.id,
    endpoints: [{ provider_name: 'test' }],
    ...partial,
  };
}

describe('getLanguageModelIds', () => {
  it('includes language models even when they have no endpoints', () => {
    expect(
      getLanguageModelIds({
        'vendor/with-endpoints': storedModel({ id: 'vendor/with-endpoints' }),
        'vendor/no-endpoints': storedModel({ id: 'vendor/no-endpoints', endpoints: [] }),
        'vendor/untyped': storedModel({ id: 'vendor/untyped', type: undefined, endpoints: [] }),
        'vendor/embedding': storedModel({
          id: 'vendor/embedding',
          type: 'embedding',
          endpoints: [],
        }),
        'vendor/image': storedModel({ id: 'vendor/image', type: 'image' }),
      })
    ).toEqual(['vendor/with-endpoints', 'vendor/no-endpoints', 'vendor/untyped']);
  });
});

describe('extractVercelInferenceProviderIdsFromModel', () => {
  it('builds a deduplicated plain provider list for a model', () => {
    const model: StoredModel = {
      id: 'anthropic/claude-sonnet-4.5',
      name: 'Claude Sonnet 4.5',
      endpoints: [
        { provider_name: 'anthropic' },
        { provider_name: 'bedrock' },
        { provider_name: 'anthropic' },
        { tag: 'fallback-without-provider-name' },
      ],
    };

    expect(extractVercelInferenceProviderIdsFromModel(model)).toEqual(['anthropic', 'bedrock']);
  });
});
