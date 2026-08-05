import {
  getModelsDevProvider,
  modelsDevReasoningOptionsToVariants,
} from '@/lib/ai-gateway/providers/models-dev';
import { StoredModelSchema } from '@kilocode/db/schema-types';

describe('models.dev metadata', () => {
  test('uses provider-specific reasoning options for duplicate model ids', () => {
    const catalog = {
      openrouter: {
        models: {
          'provider/model': {
            id: 'provider/model',
            reasoning_options: [{ type: 'effort', values: ['high', 'xhigh'] }],
          },
        },
      },
      vercel: {
        models: {
          'provider/model': {
            id: 'provider/model',
            reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['high', 'xhigh'] }],
          },
        },
      },
    };

    const openRouterModel = getModelsDevProvider(catalog, 'openrouter').models['provider/model'];
    const vercelModel = getModelsDevProvider(catalog, 'vercel').models['provider/model'];

    expect(modelsDevReasoningOptionsToVariants(openRouterModel.reasoning_options ?? [])).toEqual({
      high: { reasoning: { enabled: true, effort: 'high' } },
      xhigh: { reasoning: { enabled: true, effort: 'xhigh' } },
    });
    expect(modelsDevReasoningOptionsToVariants(vercelModel.reasoning_options ?? [])).toEqual({
      none: { reasoning: { enabled: false, effort: 'none' } },
      high: { reasoning: { enabled: true, effort: 'high' } },
      xhigh: { reasoning: { enabled: true, effort: 'xhigh' } },
    });
  });

  test('ignores unsupported options without discarding supported options', () => {
    expect(
      modelsDevReasoningOptionsToVariants([
        { type: 'toggle' },
        { type: 'budget_tokens', min: 0, max: 32_000 },
      ])
    ).toEqual({
      instant: { reasoning: { enabled: false, effort: 'none' } },
      thinking: { reasoning: { enabled: true, effort: 'high' } },
    });
  });

  test('keeps StoredModel variants optional and validates persisted variants', () => {
    const model = {
      id: 'provider/model',
      name: 'Model',
      endpoints: [],
    };

    expect(StoredModelSchema.parse(model)).toEqual(model);
    expect(
      StoredModelSchema.parse({
        ...model,
        variants: { high: { reasoning: { enabled: true, effort: 'high' } } },
      }).variants
    ).toEqual({ high: { reasoning: { enabled: true, effort: 'high' } } });
  });
});
