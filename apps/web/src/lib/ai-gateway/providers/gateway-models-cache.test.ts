import { describe, expect, it } from '@jest/globals';
import { extractVercelInferenceProviderIdsFromModel } from '@/lib/ai-gateway/providers/gateway-models-cache';
import type { StoredModel } from '@kilocode/db';

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
