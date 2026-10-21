import type { StoredModel } from '@kilocode/db';
import {
  enforceRequestCostLimit,
  SYSTEM_ONE_MAX_OUTPUT_TOKENS,
  systemOneRequestCostBound,
  textRequestPriceCeiling,
} from './request-cost-limit';
import { SYSTEM_ONE_MAX_QUESTIONS, SYSTEM_ONE_MAX_STATE_BYTES } from './typesafe/schemas';
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
    const bound = systemOneRequestCostBound(metadata, { state, questions: askedQuestions });
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

  it('returns null for a model without usable pricing', () => {
    expect(
      systemOneRequestCostBound({ ...model, endpoints: [] }, { state: null, questions })
    ).toBeNull();
    expect(
      systemOneRequestCostBound({ ...model, endpoints: [{}] }, { state: null, questions })
    ).toBeNull();
  });
});
