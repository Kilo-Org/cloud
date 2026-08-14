import { describe, expect, jest, test } from '@jest/globals';
import type { ReasoningEffort } from '@kilocode/db/schema-types';
import { PERPLEXITY_KIMI_PUBLIC_ID } from '@/lib/ai-gateway/providers/moonshotai';
import { FRIENDLI_GLM_PUBLIC_ID } from '@/lib/ai-gateway/providers/zai';

describe('getOpenRouterDerivedModelVariants', () => {
  test('reverses OpenRouter efforts and places none first', async () => {
    const supportedEfforts: ReasoningEffort[] = ['max', 'high', 'medium', 'low', 'minimal'];
    jest.resetModules();
    jest.doMock('@/lib/ai-gateway/providers/gateway-models-cache', () => ({
      getOpenRouterModelsMetadataFromDatabase: jest.fn(async () => ({
        'vendor/model': {
          id: 'vendor/model',
          name: 'Model',
          endpoints: [],
          reasoning: { mandatory: false, supported_efforts: supportedEfforts },
        },
      })),
    }));
    const { getOpenRouterDerivedModelVariants } =
      await import('@/lib/ai-gateway/providers/model-settings');

    const variants = await getOpenRouterDerivedModelVariants('vendor/model');

    expect(Object.keys(variants ?? {})).toEqual([
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'max',
    ]);
    expect(supportedEfforts).toEqual(['max', 'high', 'medium', 'low', 'minimal']);
  });
});

describe('getAiSdkProvider', () => {
  test.each([
    PERPLEXITY_KIMI_PUBLIC_ID,
    FRIENDLI_GLM_PUBLIC_ID,
    'moonshotai/kimi-k3-fast',
    'z-ai/glm-5.1',
  ])('uses the Anthropic provider for gateway model %s', async model => {
    const { getAiSdkProvider } = await import('@/lib/ai-gateway/providers/model-settings');

    expect(getAiSdkProvider(model, null)).toBe('anthropic');
    expect(getAiSdkProvider(model, 'zai-coding')).toBeUndefined();
  });

  test('does not apply GLM/Kimi settings to unrelated models', async () => {
    const { getAiSdkProvider } = await import('@/lib/ai-gateway/providers/model-settings');

    expect(getAiSdkProvider('vendor/unrelated-model', null)).toBeUndefined();
  });
});
