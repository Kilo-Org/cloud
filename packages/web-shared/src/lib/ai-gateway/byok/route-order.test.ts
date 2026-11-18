import { describe, expect, test } from '@jest/globals';
import {
  createByokRouteRank,
  sortByokKeysInRouteOrder,
} from '@kilocode/web-shared/lib/ai-gateway/byok/route-order';

type Key = { providerId: string; priority?: number };

function order(keys: Key[]) {
  return sortByokKeysInRouteOrder(keys, key => key).map(key => key.providerId);
}

describe('sortByokKeysInRouteOrder', () => {
  test('uses the default route order when no key has a priority', () => {
    expect(
      order([
        { providerId: 'openrouter' },
        { providerId: 'anthropic' },
        { providerId: 'zai-coding' },
        { providerId: 'vercel-ai-gateway' },
        { providerId: 'synthetic' },
        { providerId: 'bedrock' },
      ])
    ).toEqual([
      'synthetic',
      'zai-coding',
      'anthropic',
      'bedrock',
      'vercel-ai-gateway',
      'openrouter',
    ]);
  });

  test('follows the priorities the owner chose', () => {
    expect(
      order([
        { providerId: 'anthropic', priority: 2 },
        { providerId: 'openrouter', priority: 0 },
        { providerId: 'zai-coding', priority: 1 },
      ])
    ).toEqual(['openrouter', 'zai-coding', 'anthropic']);
  });

  test('places a key without a priority after the last key of the same or an earlier default rank', () => {
    expect(
      order([
        { providerId: 'openrouter', priority: 0 },
        { providerId: 'anthropic', priority: 1 },
        { providerId: 'vercel-ai-gateway', priority: 2 },
        { providerId: 'minimax' },
        { providerId: 'zai-coding' },
      ])
    ).toEqual(['zai-coding', 'openrouter', 'anthropic', 'minimax', 'vercel-ai-gateway']);
  });
});

describe('createByokRouteRank', () => {
  test('keeps the position a key without a priority has in the whole list', () => {
    const rank = createByokRouteRank([
      { providerId: 'openrouter', priority: 0 },
      { providerId: 'anthropic', priority: 1 },
      { providerId: 'minimax' },
    ]);

    expect(rank('openrouter')).toBeLessThan(rank('minimax'));
    expect(rank('anthropic')).toBeLessThan(rank('minimax'));
  });
});
