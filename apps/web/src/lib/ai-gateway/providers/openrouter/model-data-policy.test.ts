import { describe, expect, test } from '@jest/globals';
import {
  modelRetainsPrompts,
  modelTrains,
} from '@/lib/ai-gateway/providers/openrouter/model-data-policy';
import { OpenRouterSearchResponse } from '@/lib/ai-gateway/providers/openrouter/openrouter-types';

const baseModel = {
  slug: 'anthropic/claude-fable-5',
  name: 'Claude Fable 5',
  author: 'anthropic',
  description: '',
  context_length: 200_000,
  input_modalities: ['text'],
  output_modalities: ['text'],
  group: 'Claude Fable',
  updated_at: '2026-06-09T00:00:00Z',
};

describe('model data policy', () => {
  test('preserves and uses model endpoint policy overrides', () => {
    const response = OpenRouterSearchResponse.parse({
      data: {
        models: [
          {
            ...baseModel,
            endpoint: {
              provider_display_name: 'Amazon Bedrock (BYOK Only)',
              is_free: false,
              pricing: { prompt: '0.000005', completion: '0.000025' },
              data_policy: {
                training: false,
                retainsPrompts: true,
                retentionDays: 30,
              },
            },
          },
        ],
      },
    });

    const model = response.data.models[0];
    expect(model?.endpoint?.data_policy).toEqual({ training: false, retainsPrompts: true });
    expect(model && modelTrains(model, true)).toBe(false);
    expect(model && modelRetainsPrompts(model, false)).toBe(true);
  });

  test('falls back to the provider policy for snapshots without endpoint policy', () => {
    const response = OpenRouterSearchResponse.parse({
      data: {
        models: [
          {
            ...baseModel,
            endpoint: {
              provider_display_name: 'Amazon Bedrock',
              is_free: false,
              pricing: { prompt: '0.000005', completion: '0.000025' },
            },
          },
        ],
      },
    });

    const model = response.data.models[0];
    expect(model && modelTrains(model, true)).toBe(true);
    expect(model && modelRetainsPrompts(model, true)).toBe(true);
  });
});
