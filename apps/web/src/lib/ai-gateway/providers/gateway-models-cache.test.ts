import { describe, expect, it } from '@jest/globals';
import { getVercelInferenceProvidersByModel } from '@/lib/ai-gateway/providers/gateway-models-cache';
import type { StoredModel } from '@kilocode/db';

describe('getVercelInferenceProvidersByModel', () => {
  it('builds deduplicated plain provider lists for each model', () => {
    const models: Record<string, StoredModel> = {
      'anthropic/claude-sonnet-4.5': {
        id: 'anthropic/claude-sonnet-4.5',
        name: 'Claude Sonnet 4.5',
        endpoints: [
          { provider_name: 'anthropic' },
          { provider_name: 'bedrock' },
          { provider_name: 'anthropic' },
          { tag: 'fallback-without-provider-name' },
        ],
      },
      'openai/gpt-5': {
        id: 'openai/gpt-5',
        name: 'GPT-5',
        endpoints: [],
      },
    };

    expect(getVercelInferenceProvidersByModel(models)).toEqual({
      'anthropic/claude-sonnet-4.5': ['anthropic', 'bedrock'],
      'openai/gpt-5': [],
    });
  });
});
