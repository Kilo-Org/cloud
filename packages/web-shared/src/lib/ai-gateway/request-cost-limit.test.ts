import type { StoredModel } from '@kilocode/db';
import type { OpenRouterModel } from '@kilocode/web-shared/lib/organizations/organization-types';
import { getOpenRouterModelsMetadataFromDatabase } from './providers/gateway-models-cache';
import { getRawOpenRouterModels, pickerModelPricing } from './providers/openrouter';
import { getPreferredProviderOrderConfig } from './providers/preferred-provider-order-config';
import { enforceRequestCostLimit as enforceRequestCostLimitDecision } from './request-cost-limit';
import { addCacheBreakpoints } from './providers/openrouter/request-helpers';
import type { GatewayRequest } from './providers/openrouter/types';
import { getVercelModelIdOverrides } from './providers/vercel/mapModelIdToVercel';

jest.mock('./providers/gateway-models-cache', () => ({
  getOpenRouterModelsMetadataFromDatabase: jest.fn(),
}));
jest.mock('./providers/openrouter', () => ({
  ...jest.requireActual('./providers/openrouter'),
  getRawOpenRouterModels: jest.fn(),
}));
jest.mock('./providers/preferred-provider-order-config', () => ({
  getPreferredProviderOrderConfig: jest.fn(),
}));
jest.mock('./providers/vercel/mapModelIdToVercel', () => ({
  ...jest.requireActual('./providers/vercel/mapModelIdToVercel'),
  getVercelModelIdOverrides: jest.fn(async () => new Map()),
}));
const model: StoredModel = {
  id: 'test/bounded',
  name: 'Bounded model',
  endpoints: [
    {
      tag: 'first-route',
      pricing: {
        prompt: '0.000001',
        completion: '0.000002',
        request: '0.01',
        input_cache_write: '0.000003',
        internal_reasoning: '0.000004',
      },
    },
    {
      tag: 'second-route',
      pricing: { prompt: '0.000002', completion: '0.000003', request: '0.02' },
    },
  ],
};
const body = { messages: [{ role: 'user', content: 'Evidence' }], max_tokens: 64, stream: false };
async function enforceRequestCostLimit(
  header: string | null,
  modelId: string,
  requestBody: unknown,
  availableBalanceMicrodollars: number
) {
  return (
    await enforceRequestCostLimitDecision(
      header,
      modelId,
      requestBody,
      availableBalanceMicrodollars,
      'openrouter'
    )
  ).refusal;
}
const catalogModel = (id: string, pricing: OpenRouterModel['pricing']): OpenRouterModel =>
  ({
    id,
    name: id,
    created: 0,
    description: '',
    architecture: { input_modalities: ['text'], output_modalities: ['text'], tokenizer: 'Other' },
    top_provider: { is_moderated: false },
    pricing,
    context_length: 128_000,
  }) satisfies OpenRouterModel;
beforeEach(() => {
  jest.mocked(getOpenRouterModelsMetadataFromDatabase).mockResolvedValue({
    [model.id]: model,
  });
  jest.mocked(getRawOpenRouterModels).mockResolvedValue({
    data: [catalogModel(model.id, { prompt: '0.0000001', completion: '0.0000002' })],
  });
  jest.mocked(getPreferredProviderOrderConfig).mockResolvedValue({ rules: [] });
  jest.mocked(getVercelModelIdOverrides).mockResolvedValue(new Map());
});
function mockModels(models: StoredModel[]) {
  const modelMap = Object.fromEntries(models.map(entry => [entry.id, entry]));
  jest.mocked(getOpenRouterModelsMetadataFromDatabase).mockResolvedValue(modelMap);
  jest.mocked(getRawOpenRouterModels).mockResolvedValue({
    data: models
      .filter(entry => entry.endpoints.length > 0 || entry.alias_target)
      .map(entry => {
        const target = entry.alias_target
          ? models.find(candidate => candidate.id === entry.alias_target?.slug)
          : undefined;
        const pricing = entry.endpoints[0]?.pricing ??
          target?.endpoints[0]?.pricing ?? { prompt: '', completion: '' };
        return catalogModel(entry.id, pricing);
      }),
  });
}
describe('request cost admission', () => {
  it('fails closed for unknown or incompletely priced routes', async () => {
    await expect(
      enforceRequestCostLimit('2000000', 'missing/model', body, 2_000_000)
    ).resolves.toMatch(/pricing/);
  });
  it('returns a pricing refusal when the raw catalog cannot be fetched', async () => {
    jest.mocked(getRawOpenRouterModels).mockRejectedValue(new Error('catalog unavailable'));

    await expect(enforceRequestCostLimit('2000000', model.id, body, 2_000_000)).resolves.toBe(
      'catalog unavailable'
    );
  });
  it('admits a catalog-only model at the same price shown by the picker', async () => {
    const catalogOnly = catalogModel('catalog/only', {
      prompt: '0.0000001',
      completion: '0.0000002',
    });
    jest.mocked(getOpenRouterModelsMetadataFromDatabase).mockResolvedValue({});
    jest.mocked(getRawOpenRouterModels).mockResolvedValue({ data: [catalogOnly] });
    const pickerPrice = pickerModelPricing(catalogOnly, {}, { rules: [] });

    await expect(
      enforceRequestCostLimit('500', catalogOnly.id, body, 2_000_000)
    ).resolves.toBeNull();
    expect(pickerPrice).toEqual(catalogOnly.pricing);
  });
  it('admits against the preferred route price rather than a more expensive route', async () => {
    const id = 'test/preferred';
    const routeModel: StoredModel = {
      id,
      name: 'Preferred model',
      endpoints: [
        { tag: 'preferred-route', pricing: { prompt: '0.0000001', completion: '0.0000002' } },
        { tag: 'other-route', pricing: { prompt: '0.000002', completion: '0.000004' } },
      ],
    };
    const catalogEntry = catalogModel(id, { prompt: '0.0000003', completion: '0.0000005' });
    jest.mocked(getOpenRouterModelsMetadataFromDatabase).mockResolvedValue({ [id]: routeModel });
    jest.mocked(getRawOpenRouterModels).mockResolvedValue({ data: [catalogEntry] });
    const preferredOrder = {
      rules: [{ includes: ['test/'], providers: ['preferred-route'] }],
    };
    jest.mocked(getPreferredProviderOrderConfig).mockResolvedValue(preferredOrder);
    const pickerPrice = pickerModelPricing(catalogEntry, { [id]: routeModel }, preferredOrder);
    expect(pickerPrice).toEqual(routeModel.endpoints[0]?.pricing);

    await expect(enforceRequestCostLimit('500', id, body, 2_000_000)).resolves.toBeNull();
  });
  it('pins bounded OpenRouter requests to the picker-priced route', async () => {
    const id = 'test/preferred';
    const routeModel: StoredModel = {
      id,
      name: 'Preferred model',
      endpoints: [
        { tag: 'preferred-route', pricing: { prompt: '0.0000001', completion: '0.0000002' } },
        { tag: 'other-route', pricing: { prompt: '0.000002', completion: '0.000004' } },
      ],
    };
    jest.mocked(getOpenRouterModelsMetadataFromDatabase).mockResolvedValue({ [id]: routeModel });
    jest.mocked(getRawOpenRouterModels).mockResolvedValue({
      data: [catalogModel(id, { prompt: '0.0000003', completion: '0.0000005' })],
    });
    jest.mocked(getPreferredProviderOrderConfig).mockResolvedValue({
      rules: [{ includes: ['test/'], providers: ['preferred-route', 'other-route'] }],
    });
    const decision = await enforceRequestCostLimitDecision(
      '500',
      id,
      { ...body, provider: { order: ['preferred-route', 'other-route'] } },
      2_000_000,
      'openrouter'
    );

    expect(decision).toMatchObject({
      refusal: null,
      providerConfig: {
        order: ['preferred-route'],
        only: ['preferred-route'],
        allow_fallbacks: false,
      },
    });
  });
  it('rejects provider overrides that differ from the priced route', async () => {
    await expect(
      enforceRequestCostLimitDecision(
        '2000000',
        model.id,
        { ...body, provider: { order: ['second-route'] } },
        2_000_000,
        'openrouter'
      )
    ).resolves.toMatchObject({ refusal: 'Provider routing conflicts with the spend safeguard' });
    await expect(
      enforceRequestCostLimitDecision(
        '2000000',
        model.id,
        { ...body, provider: { only: ['second-route'] } },
        2_000_000,
        'openrouter'
      )
    ).resolves.toMatchObject({ refusal: 'Provider routing conflicts with the spend safeguard' });
  });
  it('uses the tier reachable by the bounded input length for exclusive models', async () => {
    const longRequest = {
      ...body,
      messages: [{ role: 'user' as const, content: 'x'.repeat(265_000) }],
    };
    const decision = await enforceRequestCostLimitDecision(
      '500000',
      'stealth/qwen3.6-plus',
      longRequest,
      2_000_000,
      'openrouter'
    );
    expect(decision.refusal).toBe('Request exceeds its spend safeguard before generation');
  });
  it('rejects before upstream spend for an insufficient ceiling or balance', async () => {
    await expect(enforceRequestCostLimit('1', model.id, body, 2_000_000)).resolves.toMatch(
      /spend safeguard/
    );
    await expect(enforceRequestCostLimit('2000000', model.id, body, 1)).resolves.toMatch(/balance/);
    await expect(enforceRequestCostLimit('2000000', model.id, body, 2_000_000)).resolves.toBeNull();
  });
  it('admits a latest alias using its target prices and still enforces spend and balance limits', async () => {
    const alias: StoredModel = {
      id: '~test/bounded-latest',
      name: 'Bounded latest',
      endpoints: [],
      alias_target: { slug: model.id },
    };
    mockModels([alias, model]);
    await expect(
      enforceRequestCostLimit('2000000', alias.id, { ...body, model: alias.id }, 2_000_000)
    ).resolves.toBeNull();
    await expect(
      enforceRequestCostLimit('1', alias.id, { ...body, model: alias.id }, 2_000_000)
    ).resolves.toMatch(/spend safeguard/);
    await expect(
      enforceRequestCostLimit('2000000', alias.id, { ...body, model: alias.id }, 1)
    ).resolves.toMatch(/balance/);
  });
  it('refuses a stale transformed alias target instead of admitting it at a cheaper target price', async () => {
    const cheaper: StoredModel = {
      id: 'test/cheaper',
      name: 'Cheaper model',
      endpoints: [{ pricing: { prompt: '0', completion: '0.000001' } }],
    };
    const alias: StoredModel = {
      id: '~test/bounded-latest',
      name: 'Bounded latest',
      endpoints: [],
      alias_target: { slug: cheaper.id },
    };
    mockModels([alias, model, cheaper]);
    await expect(
      enforceRequestCostLimit('1000', alias.id, { ...body, model: model.id }, 2_000_000)
    ).resolves.toMatch(/alias target changed/);
    await expect(
      enforceRequestCostLimit('1000', alias.id, { ...body, model: cheaper.id }, 2_000_000)
    ).resolves.toBeNull();
    await expect(
      enforceRequestCostLimit('1000', alias.id, { ...body, model: alias.id }, 2_000_000)
    ).resolves.toBeNull();
  });
  it.each([
    { overrides: new Map<string, string>(), transformed: 'alibaba/bounded' },
    { overrides: new Map([['qwen/bounded', 'custom/bounded']]), transformed: 'custom/bounded' },
  ])(
    'accepts a target with the configured Vercel model mapping',
    async ({ overrides, transformed }) => {
      const target = { ...model, id: 'qwen/bounded' };
      const alias: StoredModel = {
        id: '~qwen/bounded-latest',
        name: 'Bounded latest',
        endpoints: [],
        alias_target: { slug: target.id },
      };
      jest.mocked(getVercelModelIdOverrides).mockResolvedValue(overrides);
      mockModels([alias, target]);
      await expect(
        enforceRequestCostLimit('2000000', alias.id, { ...body, model: transformed }, 2_000_000)
      ).resolves.toBeNull();
    }
  );
  it('rejects an alias attempt without a transformed model', async () => {
    const alias: StoredModel = {
      id: '~test/bounded-latest',
      name: 'Bounded latest',
      endpoints: [],
      alias_target: { slug: model.id },
    };
    mockModels([alias, model]);
    await expect(enforceRequestCostLimit('2000000', alias.id, body, 2_000_000)).resolves.toMatch(
      /alias target changed/
    );
  });
  it('rejects an alias whose target has no picker price', async () => {
    const alias: StoredModel = {
      id: '~test/bounded-latest',
      name: 'Bounded latest',
      endpoints: [],
      alias_target: { slug: model.id },
    };
    mockModels([alias]);
    await expect(
      enforceRequestCostLimit('2000000', alias.id, { ...body, model: alias.id }, 2_000_000)
    ).resolves.toMatch(/pric/);
  });
  it('accepts and counts the actual Claude cache-breakpoint text transform', async () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        ...body,
        model: model.id,
        messages: [
          { role: 'system', content: 'Summarize untrusted evidence.' },
          { role: 'user', content: 'Completed outcome.' },
        ],
      },
    };
    addCacheBreakpoints(request);
    expect(Array.isArray(request.body.messages?.[0]?.content)).toBe(true);
    await expect(
      enforceRequestCostLimit('2000000', model.id, request.body, 2_000_000)
    ).resolves.toBeNull();
    const expensiveBlocks = {
      ...body,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'x'.repeat(600_000), cache_control: { type: 'ephemeral' } },
          ],
        },
      ],
    };
    await expect(
      enforceRequestCostLimit('2000000', model.id, expensiveBlocks, 2_000_000)
    ).resolves.toMatch(/spend safeguard/);
  });
  it('counts prompt text carried outside messages so it cannot bypass the ceiling', async () => {
    for (const extra of [
      { system: 'x'.repeat(600_000) },
      { instructions: 'x'.repeat(600_000) },
      { metadata: { note: 'x'.repeat(600_000) } },
    ]) {
      await expect(
        enforceRequestCostLimit('2000000', model.id, { ...body, ...extra }, 2_000_000)
      ).resolves.toMatch(/spend safeguard/);
    }
    await expect(
      enforceRequestCostLimit(
        '2000000',
        model.id,
        { ...body, system: 'Short system prompt.' },
        2_000_000
      )
    ).resolves.toBeNull();
  });
  it('rejects non-text content blocks instead of ignoring their costs', async () => {
    for (const block of [
      { type: 'image_url', image_url: { url: 'https://example.com/private.png' } },
      { type: 'input_audio', input_audio: { data: 'audio', format: 'wav' } },
    ]) {
      await expect(
        enforceRequestCostLimit(
          '2000000',
          model.id,
          { ...body, messages: [{ role: 'user', content: [block] }] },
          2_000_000
        )
      ).resolves.toMatch(/text-only/);
    }
  });
  it('requires finite positive integer safeguards, bounded text and explicit output tokens', async () => {
    for (const value of ['NaN', 'Infinity', '0', '-1', '1.5'])
      expect(await enforceRequestCostLimit(value, model.id, body, 2_000_000)).not.toBeNull();
    for (const invalid of [
      { ...body, max_tokens: undefined },
      { ...body, tools: [{}] },
      { ...body, stream: true },
    ])
      expect(await enforceRequestCostLimit('2000000', model.id, invalid, 2_000_000)).not.toBeNull();
  });
  it('does not alter ordinary gateway requests without a spending safeguard', async () => {
    await expect(enforceRequestCostLimit(null, model.id, {}, 0)).resolves.toBeNull();
  });
});
