import { zeroUsage } from '@kilocode/harness-sdk';
import { describe, expect, it } from 'vitest';

import { countUsage, parseChatUsage, totalUsage, usageSince } from './chat-usage';

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
