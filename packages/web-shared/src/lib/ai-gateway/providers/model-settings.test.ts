import { describe, expect, jest, test } from '@jest/globals';
import type { ReasoningEffort, StoredModel } from '@kilocode/db/schema-types';

const supportedEfforts: ReasoningEffort[] = ['max', 'high', 'medium', 'low', 'minimal'];

function storedModel(id: string, reasoning: StoredModel['reasoning']): StoredModel {
  return { id, name: id, endpoints: [], reasoning };
}

async function loadModelSettings() {
  jest.resetModules();
  jest.doMock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
    getOpenRouterModelsMetadataFromDatabase: jest.fn(async () =>
      Object.fromEntries(
        [
          storedModel('vendor/model', { mandatory: false, supported_efforts: supportedEfforts }),
          storedModel('moonshotai/kimi-k3', {
            mandatory: false,
            supported_efforts: supportedEfforts,
          }),
          storedModel('vendor/mandatory', {
            mandatory: true,
            supported_efforts: ['high', 'low'],
          }),
          storedModel('vendor/binary', { mandatory: false }),
          storedModel('vendor/always-on', { mandatory: true }),
          storedModel('anthropic/claude-sonnet-4.6', {
            mandatory: false,
            supported_efforts: ['max', 'high', 'medium', 'low'],
          }),
          storedModel('vendor/no-reasoning', undefined),
        ].map(model => [model.id, model])
      )
    ),
  }));
  return await import('@kilocode/web-shared/lib/ai-gateway/providers/model-settings');
}

describe('getOpenRouterReasoningOptions', () => {
  test('sorts OpenRouter efforts ascending and adds none when reasoning is optional', async () => {
    const { getOpenRouterReasoningOptions } = await loadModelSettings();

    expect(await getOpenRouterReasoningOptions('vendor/model')).toEqual([
      { type: 'effort', values: ['none', 'minimal', 'low', 'medium', 'high', 'max'] },
    ]);
    expect(supportedEfforts).toEqual(['max', 'high', 'medium', 'low', 'minimal']);
  });

  test('does not add none for Kimi K3 or mandatory reasoning', async () => {
    const { getOpenRouterReasoningOptions } = await loadModelSettings();

    expect(await getOpenRouterReasoningOptions('moonshotai/kimi-k3')).toEqual([
      { type: 'effort', values: ['minimal', 'low', 'medium', 'high', 'max'] },
    ]);
    expect(await getOpenRouterReasoningOptions('vendor/mandatory')).toEqual([
      { type: 'effort', values: ['low', 'high'] },
    ]);
  });

  test('uses a toggle or no controls when OpenRouter lists no efforts', async () => {
    const { getOpenRouterReasoningOptions } = await loadModelSettings();

    expect(await getOpenRouterReasoningOptions('vendor/binary')).toEqual([{ type: 'toggle' }]);
    expect(await getOpenRouterReasoningOptions('vendor/always-on')).toEqual([]);
    expect(await getOpenRouterReasoningOptions('vendor/no-reasoning')).toBeUndefined();
  });
});

describe('getGatewayOpenCodeSettings', () => {
  test('derives legacy variants from the reasoning options', async () => {
    const { getGatewayOpenCodeSettings } = await loadModelSettings();

    expect(
      JSON.stringify(await getGatewayOpenCodeSettings('anthropic/claude-sonnet-4.6', true))
    ).toBe(
      JSON.stringify({
        ai_sdk_provider: 'anthropic',
        variants: {
          none: { reasoning: { enabled: false, effort: 'none' } },
          low: { reasoning: { enabled: true, effort: 'low' }, verbosity: 'low' },
          medium: { reasoning: { enabled: true, effort: 'medium' }, verbosity: 'medium' },
          high: { reasoning: { enabled: true, effort: 'high' }, verbosity: 'high' },
          max: { reasoning: { enabled: true, effort: 'max' }, verbosity: 'max' },
        },
        reasoning_options: [{ type: 'effort', values: ['none', 'low', 'medium', 'high', 'max'] }],
      })
    );
  });

  test('keeps the legacy variant names for binary and always-on reasoning', async () => {
    const { getGatewayOpenCodeSettings } = await loadModelSettings();

    expect((await getGatewayOpenCodeSettings('vendor/binary', true))?.variants).toEqual({
      instant: { reasoning: { enabled: false, effort: 'none' } },
      thinking: { reasoning: { enabled: true, effort: 'high' } },
    });
    expect((await getGatewayOpenCodeSettings('vendor/always-on', true))?.variants).toEqual({
      thinking: { reasoning: { enabled: true, effort: 'high' } },
    });
  });

  test('only uses the model-name fallback when allowed', async () => {
    const { getGatewayOpenCodeSettings } = await loadModelSettings();

    expect(await getGatewayOpenCodeSettings('openai/gpt-5.9', false)).toEqual({
      ai_sdk_provider: 'openai',
    });
    expect((await getGatewayOpenCodeSettings('openai/gpt-5.9', true))?.reasoning_options).toEqual([
      { type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] },
    ]);
  });
});
