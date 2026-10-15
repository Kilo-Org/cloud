import type { StoredModel } from '@kilocode/db';
import { enforceRequestCostLimit, textRequestPriceCeiling } from './request-cost-limit';
import { addCacheBreakpoints } from './providers/openrouter/request-helpers';
import type { GatewayRequest } from './providers/openrouter/types';

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
