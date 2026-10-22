import { type ModelUsage, zeroUsage } from '@kilocode/harness-sdk';
import { describe, expect, it } from 'vitest';

import { countSessionUsage, parseChatUsage, totalUsage } from '@/lib/chat/chat-usage';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

import {
  chatContextInfo,
  chatCost,
  chatModelUsages,
  estimatedCost,
  modelCost,
  modelNameOf,
} from './chat-details-state';

const KILO = 'anthropic/claude-sonnet-4.6';
const CUSTOM = 'backend:b1:1:gpt-local';
const LOCAL = 'local:apple';

const option = (id: string, extra: Partial<SessionModelOption> = {}): SessionModelOption => ({
  id,
  name: `${id} name`,
  displayId: id,
  variants: [],
  isPreferred: false,
  showGatewayMetadata: true,
  ...extra,
});

const usage = {
  inputTokens: 1000,
  outputTokens: 100,
  cacheReadTokens: 10_000,
  cacheWriteTokens: 0,
};

const pricing = {
  prompt: '0.000003',
  completion: '0.000015',
  input_cache_read: '0.0000003',
};

describe('estimatedCost', () => {
  it('prices each kind of token at its own list price', () => {
    expect(estimatedCost(usage, pricing)).toBeCloseTo(1000 * 3e-6 + 100 * 15e-6 + 10_000 * 3e-7);
  });

  it('charges a cache read at the input price when the catalog has no cache price', () => {
    expect(estimatedCost(usage, { prompt: '0.000003', completion: '0.000015' })).toBeCloseTo(
      11_000 * 3e-6 + 100 * 15e-6
    );
  });

  it('has no estimate without an input and an output price', () => {
    expect(estimatedCost(usage, undefined)).toBeUndefined();
    expect(estimatedCost(usage, { prompt: '0.000003' })).toBeUndefined();
    expect(estimatedCost(usage, { prompt: 'free', completion: '0' })).toBeUndefined();
  });
});

describe('modelCost', () => {
  it('takes the figure the gateway billed over the list price', () => {
    expect(modelCost(KILO, { ...usage, cost: 0.02 }, option(KILO, { pricing }))).toEqual({
      kind: 'billed',
      usd: 0.02,
    });
  });

  it('estimates from the list price when no figure came back', () => {
    expect(modelCost(KILO, usage, option(KILO, { pricing }))).toMatchObject({
      kind: 'estimated',
    });
  });

  it('knows no price for a custom backend, and no cost for an on-device model', () => {
    expect(modelCost(CUSTOM, usage, option(CUSTOM))).toEqual({ kind: 'unknown' });
    expect(modelCost(LOCAL, usage, option(LOCAL))).toEqual({ kind: 'onDevice' });
  });
});

describe('chatCost', () => {
  it('adds the known costs and says what is estimated or left out', () => {
    expect(
      chatCost([
        { kind: 'billed', usd: 0.5 },
        { kind: 'estimated', usd: 0.25 },
        { kind: 'unknown' },
        { kind: 'onDevice' },
      ])
    ).toEqual({ kind: 'known', usd: 0.75, estimated: true, partial: true });
  });

  it('is not known when nothing in the chat has a price', () => {
    expect(chatCost([{ kind: 'unknown' }, { kind: 'onDevice' }])).toEqual({ kind: 'unknown' });
  });

  it('costs nothing when every answer came from this device, and nothing yet before any', () => {
    expect(chatCost([{ kind: 'onDevice' }])).toEqual({ kind: 'onDevice' });
    expect(chatCost([])).toEqual({ kind: 'none' });
  });
});

describe('chatModelUsages', () => {
  it('names and prices each model the chat used', () => {
    expect(
      chatModelUsages({ [KILO]: { ...usage, cost: 0.1 }, [LOCAL]: zeroUsage }, [
        option(KILO, { pricing }),
      ])
    ).toEqual([
      {
        model: KILO,
        name: `${KILO} name`,
        usage: { ...usage, cost: 0.1 },
        cost: { kind: 'billed', usd: 0.1 },
      },
      { model: LOCAL, name: 'system', usage: zeroUsage, cost: { kind: 'onDevice' } },
    ]);
  });

  it('shows the routed model names and persisted billed, estimated and unknown costs instead of Auto', () => {
    const unpriced = 'vendor/unpriced';
    const auto = 'kilo-auto/balanced';
    const recorded = countSessionUsage({
      usage: {},
      requested: auto,
      totals: new Map<string, ModelUsage>([
        [KILO, { ...usage, cost: 0.02 }],
        [CUSTOM, usage],
        [unpriced, usage],
      ]),
      counted: new Map(),
    });
    const reopened = parseChatUsage(JSON.stringify(recorded));
    const models = chatModelUsages(reopened, [
      option(auto, { pricing: { prompt: '0', completion: '0' } }),
      option(KILO, { name: 'Claude Sonnet', pricing }),
      option(CUSTOM, { name: 'Direct model' }),
      option(unpriced, { name: 'Estimated model', pricing }),
    ]);

    expect(models.map(model => model.name)).toEqual([
      'Claude Sonnet',
      'Direct model',
      'Estimated model',
    ]);
    expect(models.map(model => model.cost)).toEqual([
      { kind: 'billed', usd: 0.02 },
      { kind: 'unknown' },
      { kind: 'estimated', usd: estimatedCost(usage, pricing) },
    ]);
    expect(chatCost(models.map(model => model.cost))).toEqual({
      kind: 'known',
      usd: 0.02 + (estimatedCost(usage, pricing) ?? 0),
      estimated: true,
      partial: true,
    });
    expect(totalUsage(reopened)).toMatchObject({
      inputTokens: 3000,
      outputTokens: 300,
      cacheReadTokens: 30_000,
      cost: 0.02,
    });
  });
});

describe('modelNameOf', () => {
  it('names a deleted backend model by its id rather than by the whole target', () => {
    expect(modelNameOf(CUSTOM, [])).toBe('gpt-local');
    expect(modelNameOf('backend:broken', [])).toBe('backend:broken');
  });
});

describe('chatContextInfo', () => {
  it('measures the last call against the window of the model the chat is on', () => {
    expect(chatContextInfo(KILO, 50_000, [option(KILO, { contextWindow: 200_000 })])).toEqual({
      contextTokens: 50_000,
      providerID: 'kilo',
      modelID: KILO,
      contextWindow: 200_000,
      percentage: 25,
    });
  });

  it('has no reading before the first answer, and no percentage without a window', () => {
    expect(chatContextInfo(KILO, 0, [])).toBeUndefined();
    expect(chatContextInfo(CUSTOM, 10, [])).toMatchObject({
      contextWindow: undefined,
      percentage: undefined,
    });
  });
});
