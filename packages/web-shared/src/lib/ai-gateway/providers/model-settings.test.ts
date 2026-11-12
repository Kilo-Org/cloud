import { describe, expect, jest, test } from '@jest/globals';
import type { GatewayModel, ReasoningEffort } from '@kilocode/db/schema-types';
import type {
  GatewayModelMap,
  GatewayModelWithEndpoints,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-model-metadata';
import type * as MapModelIdToVercelModule from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';

const supportedEfforts: ReasoningEffort[] = ['max', 'high', 'medium', 'low', 'minimal'];

function storedModel(
  id: string,
  reasoning: GatewayModelWithEndpoints['reasoning']
): GatewayModelWithEndpoints {
  return { id, name: id, endpoints: [], reasoning };
}

const defaultOpenRouterModels = Object.fromEntries(
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
);

/** A stored Vercel chat model that the catalog can list. */
function storedVercelModel(
  id: string,
  reasoning_options?: GatewayModel['reasoning_options']
): GatewayModelWithEndpoints {
  return {
    id,
    name: id,
    type: 'language',
    context_window: 128_000,
    modalities: { input: ['text'], output: ['text'] },
    pricing: { input: '0.000001', output: '0.000002' },
    reasoning_options,
    endpoints: [],
  };
}

const lowMediumHigh: GatewayModel['reasoning_options'] = [
  { type: 'effort', values: ['low', 'medium', 'high'] },
];

const defaultVercelModels = Object.fromEntries(
  [
    storedVercelModel('interfaze/interfaze-beta', lowMediumHigh),
    storedVercelModel('alibaba/qwen3.5-flash', [
      { type: 'budget_tokens' },
      { type: 'effort', values: ['instant', 'low', 'high'] },
    ]),
    storedVercelModel('openai/gpt-5-fast', lowMediumHigh),
    storedVercelModel('openai/gpt-5.9-vercel', [{ type: 'unknown' }]),
    storedVercelModel('vendor/model', [{ type: 'toggle' }]),
    storedVercelModel('vendor/no-reasoning', lowMediumHigh),
  ].map(model => [model.id, model])
);

async function loadModelSettings({
  vercelModels = defaultVercelModels,
  overrides = new Map<string, string>(),
  openRouterModels = defaultOpenRouterModels,
}: {
  vercelModels?: GatewayModelMap;
  overrides?: Map<string, string>;
  openRouterModels?: GatewayModelMap;
} = {}) {
  jest.resetModules();
  jest.doMock('@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel', () => ({
    ...jest.requireActual<typeof MapModelIdToVercelModule>(
      '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel'
    ),
    getVercelModelIdOverrides: jest.fn(async () => overrides),
  }));
  jest.doMock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
    getVercelModelsMetadataFromDatabase: jest.fn(async () => vercelModels),
    getOpenRouterModelsMetadataFromDatabase: jest.fn(async () => openRouterModels),
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

describe('getModelVariants for models only Vercel serves', () => {
  test('resolves the variants the catalog lists from Vercel reasoning options', async () => {
    const { getModelVariants, getGatewayOpenCodeSettings } = await loadModelSettings();

    expect(await getModelVariants('interfaze/interfaze-beta', true)).toEqual({
      low: { reasoning: { enabled: true, effort: 'low' } },
      medium: { reasoning: { enabled: true, effort: 'medium' } },
      high: { reasoning: { enabled: true, effort: 'high' } },
    });
    expect(await getGatewayOpenCodeSettings('qwen/qwen3.5-flash', false)).toEqual({
      ai_sdk_provider: undefined,
      reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'high'] }],
      variants: {
        none: { reasoning: { enabled: false, effort: 'none' } },
        low: { reasoning: { enabled: true, effort: 'low' } },
        high: { reasoning: { enabled: true, effort: 'high' } },
      },
      prompt: undefined,
    });
  });

  test('looks the Vercel model up under the id an admin override lists it as', async () => {
    const { getModelReasoningOptions } = await loadModelSettings({
      overrides: new Map([['openai/gpt-5-priority', 'openai/gpt-5-fast']]),
    });

    expect(await getModelReasoningOptions('openai/gpt-5-priority', false)).toEqual([
      { type: 'effort', values: ['low', 'medium', 'high'] },
    ]);
    expect(await getModelReasoningOptions('openai/gpt-5-fast', false)).toBeUndefined();
  });

  test('ignores a Vercel model an OpenRouter model routes to through an override', async () => {
    const { getModelReasoningOptions } = await loadModelSettings({
      overrides: new Map([['vendor/model', 'interfaze/interfaze-beta']]),
    });

    expect(await getModelReasoningOptions('interfaze/interfaze-beta', true)).toBeUndefined();
  });

  test('keeps OpenRouter reasoning metadata and the fallback for models OpenRouter lists', async () => {
    const { getModelReasoningOptions } = await loadModelSettings();

    expect(await getModelReasoningOptions('vendor/model', true)).toEqual([
      { type: 'effort', values: ['none', 'minimal', 'low', 'medium', 'high', 'max'] },
    ]);
    expect(await getModelReasoningOptions('vendor/no-reasoning', true)).toBeUndefined();
  });

  test('falls back by model name when no Vercel reasoning option translates', async () => {
    const { getModelReasoningOptions } = await loadModelSettings();

    expect(await getModelReasoningOptions('openai/gpt-5.9-vercel', false)).toBeUndefined();
    expect(await getModelReasoningOptions('openai/gpt-5.9-vercel', true)).toEqual([
      { type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] },
    ]);
  });

  test('ignores Vercel reasoning options without OpenRouter models to compare against', async () => {
    const { getModelReasoningOptions } = await loadModelSettings({ openRouterModels: {} });

    expect(await getModelReasoningOptions('interfaze/interfaze-beta', true)).toBeUndefined();
  });
});
