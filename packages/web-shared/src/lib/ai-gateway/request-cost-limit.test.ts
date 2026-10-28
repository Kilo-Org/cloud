import type { StoredModel } from '@kilocode/db';
import type { OpenRouterModel } from '@kilocode/web-shared/lib/organizations/organization-types';
import { getOpenRouterModelsMetadataFromDatabase } from './providers/gateway-models-cache';
import { getRawOpenRouterModels, pickerModelPricing } from './providers/openrouter';
import { getPreferredProviderOrderConfig } from './providers/preferred-provider-order-config';
import {
  enforceRequestCostLimit as enforceRequestCostLimitDecision,
  SYSTEM_ONE_MAX_OUTPUT_TOKENS,
  systemOneRequestCostBound,
} from './request-cost-limit';
import { SYSTEM_ONE_MAX_QUESTIONS, SYSTEM_ONE_MAX_STATE_BYTES } from './typesafe/schemas';
import { addCacheBreakpoints } from './providers/openrouter/request-helpers';
import type { GatewayRequest } from './providers/openrouter/types';
import { getVercelModelIdOverrides } from './providers/vercel/mapModelIdToVercel';
import { TEST_CUSTOM_PRICING_CONFIG } from '@kilocode/web-shared/tests/helpers/custom-pricing.helper';
import {
  tieredStealthModelFixture,
  useKiloExclusiveModel,
} from '@kilocode/web-shared/tests/helpers/kilo-exclusive-models.helper';

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
      { id: 'openrouter', userFunded: false }
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
  useKiloExclusiveModel(tieredStealthModelFixture);

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
  it('refuses a managed provider that cannot enforce the quoted route price', async () => {
    const decision = await enforceRequestCostLimitDecision(
      '2000000',
      model.id,
      { ...body, provider: { only: ['second-route'] } },
      2_000_000,
      { id: 'vercel', userFunded: false }
    );

    expect(decision).toEqual({
      refusal: 'Bounded spending requires a provider that can enforce it',
      providerConfig: null,
    });
  });
  it('admits a managed provider whose route ceiling the caller funds itself', async () => {
    const decision = await enforceRequestCostLimitDecision(
      '2000000',
      model.id,
      { ...body, provider: { only: ['second-route'] } },
      2_000_000,
      { id: 'vercel', userFunded: true }
    );

    expect(decision).toEqual({ refusal: null, providerConfig: null });
  });
  it('admits a free model on a managed provider without a route price cap', async () => {
    const decision = await enforceRequestCostLimitDecision(
      '2000000',
      'google/gemma-4-26b-a4b-it:free',
      body,
      2_000_000,
      { id: 'vercel', userFunded: false }
    );

    expect(decision).toEqual({ refusal: null, providerConfig: null });
  });
  it('caps a free OpenRouter-served model at zero route prices', async () => {
    const decision = await enforceRequestCostLimitDecision(
      '2000000',
      'google/gemma-4-26b-a4b-it:free',
      body,
      2_000_000,
      { id: 'openrouter', userFunded: false }
    );

    expect(decision).toEqual({
      refusal: null,
      providerConfig: { max_price: { prompt: 0, completion: 0, request: 0 } },
    });
  });
  it('caps provider prices while preserving provider exclusions and organization allow-lists', async () => {
    const provider = {
      order: ['first-route', 'second-route'],
      only: ['first-route', 'second-route'],
      ignore: ['first-route'],
      data_collection: 'deny',
    };
    const decision = await enforceRequestCostLimitDecision(
      '2000000',
      model.id,
      { ...body, provider },
      2_000_000,
      { id: 'openrouter', userFunded: false }
    );
    expect(decision).toEqual({
      refusal: null,
      providerConfig: {
        ...provider,
        max_price: { prompt: 4, completion: 6, request: 0.01 },
      },
    });
  });

  it('caps catalog-only routing at the catalog price even without known endpoints', async () => {
    jest.mocked(getOpenRouterModelsMetadataFromDatabase).mockResolvedValue({});
    const decision = await enforceRequestCostLimitDecision('1000', model.id, body, 2_000_000, {
      id: 'openrouter',
      userFunded: false,
    });
    expect(decision).toEqual({
      refusal: null,
      providerConfig: { max_price: { prompt: 0.1, completion: 0.2, request: 0 } },
    });
  });

  it('keeps caller price constraints when they are stricter than admission rates', async () => {
    const decision = await enforceRequestCostLimitDecision(
      '2000000',
      model.id,
      { ...body, provider: { max_price: { prompt: 0.05, completion: 0.1, request: 0 } } },
      2_000_000,
      { id: 'openrouter', userFunded: false }
    );
    expect(decision.providerConfig?.max_price).toEqual({
      prompt: 0.05,
      completion: 0.1,
      request: 0,
    });
  });
  it('uses the tier reachable by the bounded input length for exclusive models', async () => {
    const longRequest = {
      ...body,
      messages: [{ role: 'user' as const, content: 'x'.repeat(265_000) }],
    };
    const decision = await enforceRequestCostLimitDecision(
      '500000',
      tieredStealthModelFixture.public_id,
      longRequest,
      2_000_000,
      { id: 'openrouter', userFunded: false }
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
    await expect(
      enforceRequestCostLimit(
        '2000000',
        model.id,
        { ...body, metadata: { note: 'x'.repeat(600_000) } },
        2_000_000
      )
    ).resolves.toMatch(/spend safeguard/);
  });
  it('refuses top-level properties the admission bound does not price', async () => {
    for (const extra of [
      { system: 'Short system prompt.' },
      { instructions: 'Short instructions.' },
      { modalities: ['text', 'audio'] },
      { web_search_options: {} },
      { models: ['test/cheaper'] },
    ]) {
      await expect(
        enforceRequestCostLimit('2000000', model.id, { ...body, ...extra }, 2_000_000)
      ).resolves.toMatch(/does not price the \w+ request property/);
    }
  });
  it('prices every choice and the full output ceiling the request can use', async () => {
    await expect(
      enforceRequestCostLimit('19000', model.id, { ...body, model: model.id }, 2_000_000)
    ).resolves.toBeNull();
    await expect(
      enforceRequestCostLimit('19000', model.id, { ...body, model: model.id, n: 3 }, 2_000_000)
    ).resolves.toMatch(/spend safeguard/);
    await expect(
      enforceRequestCostLimit(
        '19000',
        model.id,
        { ...body, model: model.id, max_completion_tokens: 1000 },
        2_000_000
      )
    ).resolves.toMatch(/spend safeguard/);
    await expect(
      enforceRequestCostLimit(
        '25000',
        model.id,
        { ...body, model: model.id, max_completion_tokens: 1000 },
        2_000_000
      )
    ).resolves.toBeNull();
    await expect(
      enforceRequestCostLimit(
        '19000',
        model.id,
        { messages: body.messages, max_completion_tokens: 64, stream: false },
        2_000_000
      )
    ).resolves.toBeNull();
  });
  it('refuses a service tier the catalog price does not cover', async () => {
    for (const service_tier of ['priority', 'scale', 'unpriced']) {
      await expect(
        enforceRequestCostLimit('2000000', model.id, { ...body, service_tier }, 2_000_000)
      ).resolves.toMatch(/auto, default and flex/);
    }
  });
  it('refuses a choice count outside the priced range', async () => {
    for (const n of [0, -2, 1.5, 129]) {
      await expect(
        enforceRequestCostLimit('2000000', model.id, { ...body, n }, 2_000_000)
      ).resolves.toMatch(/between 1 and 128 choices/);
    }
  });
  it('admits the cost-neutral properties the gateway adds before admission', async () => {
    await expect(
      enforceRequestCostLimit(
        '40000',
        model.id,
        {
          ...body,
          model: model.id,
          provider: {
            order: ['anthropic'],
            sort: 'price',
            max_price: { prompt: 4, completion: 6 },
            allow_fallbacks: false,
          },
          providerOptions: { gateway: { only: ['anthropic'] } },
          prompt_cache_key: 'session-hash',
          safety_identifier: 'user-hash',
          user: 'user-hash',
          service_tier: 'flex',
          temperature: 0.2,
          top_p: 0.9,
          stop: ['\n\n'],
          reasoning: { effort: 'high' },
          reasoning_effort: 'high',
          transforms: ['middle-out'],
          stream_options: { include_usage: true },
          metadata: { session: 'hash' },
        },
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
    await expect(
      enforceRequestCostLimit('2000000', model.id, { ...body, max_tokens: undefined }, 2_000_000)
    ).resolves.toMatch(/explicit output token limit/);
    for (const invalid of [
      { ...body, tools: [{}] },
      { ...body, stream: true },
    ])
      await expect(
        enforceRequestCostLimit('2000000', model.id, invalid, 2_000_000)
      ).resolves.toMatch(/text-only/);
  });
  it('does not alter ordinary gateway requests without a spending safeguard', async () => {
    await expect(enforceRequestCostLimit(null, model.id, {}, 0)).resolves.toBeNull();
  });
});

describe('System One request cost bound', () => {
  const jev: StoredModel = {
    id: 'typesafe/jev-1.13',
    name: 'TypeSafe: Jev 1.13',
    endpoints: [{ pricing: { prompt: '0.000000042', completion: '0' } }],
  };
  const questions = { relevant: { type: 'noul' as const } };

  function boundOf(
    metadata: StoredModel,
    state: unknown,
    askedQuestions: Record<string, unknown> = questions
  ): number {
    const bound = systemOneRequestCostBound(
      metadata,
      { state, questions: askedQuestions },
      TEST_CUSTOM_PRICING_CONFIG
    );
    if (bound === null) throw new Error('Expected a cost bound');
    return bound;
  }

  it('prices additional state bytes only at the input ceiling', () => {
    expect(
      boundOf(model, { text: 'x'.repeat(11_000) }) - boundOf(model, { text: 'x'.repeat(1000) })
    ).toBe(40_000);
  });

  it('prices additional questions bytes at the input and output ceilings', () => {
    const question = (parts: number) => ({
      q: { type: 'noul' as const, instructions: { text: 'x'.repeat(parts) } },
    });
    const questionBytes = (value: object) => Buffer.byteLength(JSON.stringify(value), 'utf8');
    const delta = questionBytes(question(2000)) - questionBytes(question(1000));

    expect(boundOf(model, null, question(2000)) - boundOf(model, null, question(1000))).toBe(
      delta * 10
    );
  });

  it('includes the per-request fee for a request with no measurable tokens', () => {
    const flat: StoredModel = {
      id: 'typesafe/flat',
      name: 'Flat',
      endpoints: [{ pricing: { prompt: '0', completion: '0', request: '0.02' } }],
    };

    expect(boundOf(flat, null, { q: { type: 'noul' } })).toBe(20_000);
  });

  it('reserves the output allowance on a model that bills completion', () => {
    const completionPriced: StoredModel = {
      id: 'typesafe/completion-priced',
      name: 'Completion priced',
      endpoints: [{ pricing: { prompt: '0', completion: '0.000001' } }],
    };
    const zeroCompletion: StoredModel = {
      ...completionPriced,
      endpoints: [{ pricing: { prompt: '0', completion: '0' } }],
    };

    const allowance =
      boundOf(completionPriced, null, { q: { type: 'noul' } }) -
      boundOf(zeroCompletion, null, { q: { type: 'noul' } });

    expect(allowance).toBeGreaterThanOrEqual(SYSTEM_ONE_MAX_OUTPUT_TOKENS);
    expect(allowance).toBeLessThan(SYSTEM_ONE_MAX_OUTPUT_TOKENS + 100);
  });

  it('bounds a maximum-size request at the fixture input rate', () => {
    const state = 'x'.repeat(SYSTEM_ONE_MAX_STATE_BYTES - 2);
    const maxQuestions = Object.fromEntries(
      Array.from({ length: SYSTEM_ONE_MAX_QUESTIONS }, (_, index) => [
        `q${index}`,
        { type: 'noul', instructions: 'x'.repeat(1800) },
      ])
    );
    const inputBytes =
      Buffer.byteLength(JSON.stringify(state), 'utf8') +
      Buffer.byteLength(JSON.stringify(maxQuestions), 'utf8');

    // 42 nanodollars per input token and no completion price.
    expect(boundOf(jev, state, maxQuestions)).toBe(
      Math.ceil((inputBytes + 1024) * 0.000000042 * 1_000_000)
    );
  });

  it('bounds a discounted route at its undiscounted price', () => {
    const discounted: StoredModel = {
      id: 'typesafe/discounted',
      name: 'Discounted',
      endpoints: [{ pricing: { prompt: '0.0000005', completion: '0', discount: 0.5 } }],
    };
    const full: StoredModel = {
      id: 'typesafe/full',
      name: 'Full',
      endpoints: [{ pricing: { prompt: '0.000001', completion: '0' } }],
    };

    expect(boundOf(discounted, { text: 'x'.repeat(1000) })).toBe(
      boundOf(full, { text: 'x'.repeat(1000) })
    );
  });

  it('returns null for a model without usable pricing', () => {
    expect(
      systemOneRequestCostBound(
        { ...model, endpoints: [] },
        { state: null, questions },
        TEST_CUSTOM_PRICING_CONFIG
      )
    ).toBeNull();
    expect(
      systemOneRequestCostBound(
        { ...model, endpoints: [{}] },
        { state: null, questions },
        TEST_CUSTOM_PRICING_CONFIG
      )
    ).toBeNull();
  });

  it('propagates failures that are not about catalog pricing', () => {
    const broken = {
      id: 'typesafe/broken',
      name: 'Broken',
      get endpoints(): never {
        throw new TypeError('unexpected');
      },
    } as unknown as StoredModel;

    expect(() =>
      systemOneRequestCostBound(broken, { state: null, questions }, TEST_CUSTOM_PRICING_CONFIG)
    ).toThrow(TypeError);
  });
});
