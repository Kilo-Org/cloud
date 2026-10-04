import { describe, expect, jest, test } from '@jest/globals';
import type { ReasoningEffort } from '@kilocode/db/schema-types';

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
        'moonshotai/kimi-k3': {
          id: 'moonshotai/kimi-k3',
          name: 'Kimi K3',
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

    const kimiVariants = await getOpenRouterDerivedModelVariants('moonshotai/kimi-k3');
    expect(Object.keys(kimiVariants ?? {})).toEqual(['minimal', 'low', 'medium', 'high', 'max']);
  });
});
