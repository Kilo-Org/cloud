import type { StoredModel } from '@kilocode/db';
import { enforceRequestCostLimit, textRequestPriceCeiling } from './request-cost-limit';
import { addCacheBreakpoints } from './providers/openrouter/request-helpers';
import type { GatewayRequest } from './providers/openrouter/types';
import { getVercelModelIdOverrides } from './providers/vercel/mapModelIdToVercel';

const mockCatalogLimit = jest.fn();
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: {
    select: () => ({
      from: () => ({
        orderBy: () => ({ limit: (...args: unknown[]) => mockCatalogLimit(...args) }),
      }),
    }),
  },
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
      pricing: {
        prompt: '0.000001',
        completion: '0.000002',
        request: '0.01',
        input_cache_write: '0.000003',
        internal_reasoning: '0.000004',
      },
    },
    { pricing: { prompt: '0.000002', completion: '0.000003', request: '0.02' } },
  ],
};
const body = { messages: [{ role: 'user', content: 'Evidence' }], max_tokens: 64, stream: false };
beforeEach(() => {
  mockCatalogLimit.mockResolvedValue([{ models: { [model.id]: model } }]);
  jest.mocked(getVercelModelIdOverrides).mockResolvedValue(new Map());
});
describe('request cost admission', () => {
  it('bounds every route including cache, reasoning and per-request fees', () => {
    const price = textRequestPriceCeiling(model);
    expect(price.inputRate).toBeCloseTo(0.000004, 12);
    expect(price.outputRate).toBeCloseTo(0.000006, 12);
    expect(price.requestCost).toBe(0.02);
  });
  it('fails closed for unknown or incompletely priced routes', async () => {
    await expect(
      enforceRequestCostLimit('2000000', 'missing/model', body, 2_000_000)
    ).resolves.toMatch(/pricing/);
    expect(() => textRequestPriceCeiling({ ...model, endpoints: [{}] })).toThrow();
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
    mockCatalogLimit.mockResolvedValue([{ models: { [alias.id]: alias, [model.id]: model } }]);
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
    mockCatalogLimit.mockResolvedValue([
      { models: { [alias.id]: alias, [model.id]: model, [cheaper.id]: cheaper } },
    ]);
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
      mockCatalogLimit.mockResolvedValue([{ models: { [alias.id]: alias, [target.id]: target } }]);
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
    mockCatalogLimit.mockResolvedValue([{ models: { [alias.id]: alias, [model.id]: model } }]);
    await expect(enforceRequestCostLimit('2000000', alias.id, body, 2_000_000)).resolves.toMatch(
      /alias target changed/
    );
  });
  it.each([undefined, { ...model, endpoints: [] }, { ...model, endpoints: [{}] }])(
    'rejects an alias whose target has no usable pricing',
    async unavailableTarget => {
      const alias: StoredModel = {
        id: '~test/bounded-latest',
        name: 'Bounded latest',
        endpoints: [],
        alias_target: { slug: model.id },
      };
      mockCatalogLimit.mockResolvedValue([
        {
          models: {
            [alias.id]: alias,
            ...(unavailableTarget ? { [model.id]: unavailableTarget } : {}),
          },
        },
      ]);
      await expect(
        enforceRequestCostLimit('2000000', alias.id, { ...body, model: alias.id }, 2_000_000)
      ).resolves.toMatch(/pric/);
    }
  );
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
      enforceRequestCostLimit('29000', model.id, { ...body, model: model.id }, 2_000_000)
    ).resolves.toBeNull();
    await expect(
      enforceRequestCostLimit('29000', model.id, { ...body, model: model.id, n: 3 }, 2_000_000)
    ).resolves.toMatch(/spend safeguard/);
    await expect(
      enforceRequestCostLimit(
        '29000',
        model.id,
        { ...body, model: model.id, max_completion_tokens: 1000 },
        2_000_000
      )
    ).resolves.toMatch(/spend safeguard/);
    await expect(
      enforceRequestCostLimit(
        '35000',
        model.id,
        { ...body, model: model.id, max_completion_tokens: 1000 },
        2_000_000
      )
    ).resolves.toBeNull();
    await expect(
      enforceRequestCostLimit(
        '29000',
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
