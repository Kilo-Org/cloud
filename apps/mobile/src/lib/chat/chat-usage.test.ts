import { zeroUsage } from '@kilocode/harness-sdk';
import { describe, expect, it } from 'vitest';

import {
  countSessionUsage,
  countUsage,
  parseChatUsage,
  totalUsage,
  usageSince,
} from './chat-usage';

const used = (inputTokens: number, cost?: number) => ({
  ...zeroUsage,
  inputTokens,
  outputTokens: 1,
  ...(cost === undefined ? {} : { cost }),
});

describe('usageSince', () => {
  it('takes what was counted off the session total', () => {
    expect(usageSince(used(30, 0.3), used(10, 0.1))).toEqual({
      ...zeroUsage,
      inputTokens: 20,
      outputTokens: 0,
      cost: 0.3 - 0.1,
    });
  });

  it('reports no cost when the session never had one', () => {
    expect(usageSince(used(30), used(10))).not.toHaveProperty('cost');
  });
});

describe('countUsage', () => {
  it('adds a call to the model that answered it and leaves the others alone', () => {
    const before = { 'kilo/a': used(5, 0.05), 'local:apple': used(7) };

    const after = countUsage(before, 'kilo/a', used(5, 0.05));

    expect(after['kilo/a']).toEqual({ ...used(10, 0.1), outputTokens: 2 });
    expect(after['local:apple']).toBe(before['local:apple']);
  });

  it('starts a model the chat has not used yet', () => {
    expect(countUsage({}, 'kilo/a', used(5))).toEqual({ 'kilo/a': used(5) });
  });
});

describe('countSessionUsage', () => {
  it('counts routed tool and summary calls once across model changes and reopen', () => {
    const first = new Map([['anthropic/sonnet', used(10, 0.1)]]);
    const afterTool = countSessionUsage({
      usage: {},
      requested: 'kilo-auto/balanced',
      totals: first,
      counted: new Map(),
    });
    const completed = new Map([
      ['anthropic/sonnet', { ...used(30, 0.3), outputTokens: 2 }],
      ['openai/summary', used(40, 0.04)],
    ]);
    const afterAnswer = countSessionUsage({
      usage: afterTool,
      requested: 'kilo-auto/balanced',
      totals: completed,
      counted: first,
    });

    expect(
      countSessionUsage({
        usage: afterAnswer,
        requested: 'kilo-auto/balanced',
        totals: completed,
        counted: completed,
      })
    ).toBe(afterAnswer);
    const moved = countSessionUsage({
      usage: afterAnswer,
      requested: 'google/gemini',
      totals: new Map([['google/gemini', used(7, 0.07)]]),
      counted: new Map(),
    });
    const reopened = countSessionUsage({
      usage: parseChatUsage(JSON.stringify(moved)),
      requested: 'kilo-auto/balanced',
      totals: new Map([['anthropic/sonnet', used(5, 0.05)]]),
      counted: new Map(),
    });

    expect(Object.keys(reopened)).toEqual(['anthropic/sonnet', 'openai/summary', 'google/gemini']);
    expect(reopened['anthropic/sonnet']).toMatchObject({ inputTokens: 35, outputTokens: 3 });
    expect(reopened['anthropic/sonnet']?.cost).toBeCloseTo(0.35);
    expect(totalUsage(reopened).inputTokens).toBe(82);
    expect(totalUsage(reopened).cost).toBeCloseTo(0.46);
  });

  it('keeps direct-backend served models namespaced and native models on-device', () => {
    const backend = 'backend:b1:1:auto';
    const remote = countSessionUsage({
      usage: {},
      requested: backend,
      totals: new Map([['vendor/actual:model', used(5, 0.05)]]),
      counted: new Map(),
    });
    expect(remote).toEqual({ 'backend:b1:1:vendor%2Factual%3Amodel': used(5, 0.05) });
    expect(
      countSessionUsage({
        usage: {},
        requested: backend,
        totals: new Map([[backend, used(5)]]),
        counted: new Map(),
      })
    ).toEqual({ [backend]: used(5) });
    expect(
      countSessionUsage({
        usage: {},
        requested: 'local:apple',
        totals: new Map([['system-version', used(5)]]),
        counted: new Map(),
      })
    ).toEqual({ 'local:apple': used(5) });
  });

  it('preserves missing cost for an unpriced model beside a billed model', () => {
    const usage = countSessionUsage({
      usage: {},
      requested: 'kilo-auto/balanced',
      totals: new Map([
        ['paid', used(5, 0.05)],
        ['unpriced', used(10)],
      ]),
      counted: new Map(),
    });
    expect(parseChatUsage(JSON.stringify(usage))).toEqual({
      paid: used(5, 0.05),
      unpriced: used(10),
    });
  });

  it('keeps a completed call with unavailable counts distinct from no completed call', () => {
    const totals = new Map([['vendor/unreported', zeroUsage]]);
    const counted = countSessionUsage({
      usage: {},
      requested: 'kilo-auto/balanced',
      totals,
      counted: new Map(),
    });

    expect(counted).toEqual({ 'vendor/unreported': zeroUsage });
    expect(
      countSessionUsage({
        usage: counted,
        requested: 'kilo-auto/balanced',
        totals,
        counted: totals,
      })
    ).toBe(counted);
  });
});

describe('totalUsage', () => {
  it('sums every model, and the cost only of the models that had one', () => {
    expect(totalUsage({ a: used(5, 0.25), b: used(7) })).toEqual({
      ...zeroUsage,
      inputTokens: 12,
      outputTokens: 2,
      cost: 0.25,
    });
  });
});

describe('parseChatUsage', () => {
  it('reads back what was written', () => {
    const usage = { 'kilo/a': used(5, 0.05), 'local:apple': used(7) };

    expect(parseChatUsage(JSON.stringify(usage))).toEqual(usage);
  });

  it('reads a chat with no column, or a column it cannot parse, as nothing used', () => {
    expect(parseChatUsage(null)).toEqual({});
    expect(parseChatUsage('not json')).toEqual({});
    expect(parseChatUsage('{"kilo/a":{"inputTokens":"5"}}')).toEqual({});
  });
});
