import { describe, it, expect } from '@jest/globals';
import { getSuggestedFreeModels } from './free-model-suggestions';
import { kiloExclusiveModels } from '@/lib/ai-gateway/models';
import { KILO_AUTO_FREE_MODEL } from '@/lib/kilo-auto';
import type { RedisKey } from '@/lib/redis-keys';

function makeRedisGetFn(value: string | null): (key: RedisKey) => Promise<string | null> {
  return async () => value;
}

function makeFailingRedisGetFn(): (key: RedisKey) => Promise<string | null> {
  return async () => {
    throw new Error('Redis unavailable');
  };
}

describe('getSuggestedFreeModels', () => {
  it('should not include kilo-auto/free in suggestions', async () => {
    const suggestions = await getSuggestedFreeModels(makeRedisGetFn(null));

    expect(suggestions).not.toContain(KILO_AUTO_FREE_MODEL.id);
  });

  it('should return at most 3 suggestions', async () => {
    const suggestions = await getSuggestedFreeModels(makeRedisGetFn(null));

    expect(suggestions.length).toBeLessThanOrEqual(3);
  });

  it('should include kilo exclusive free models from preferred list when redis is empty', async () => {
    const suggestions = await getSuggestedFreeModels(makeRedisGetFn(null));

    for (const suggestion of suggestions) {
      const isKiloExclusive = kiloExclusiveModels.some(
        m => m.public_id === suggestion && m.status !== 'disabled'
      );
      const endsWithFree = suggestion.endsWith(':free');
      expect(isKiloExclusive || endsWithFree).toBe(true);
    }
  });

  it('should include openrouter :free models when present in cache', async () => {
    const openrouterModelIds: Record<string, unknown> = {
      'inclusionai/ling-2.6-flash:free': {},
    };
    const suggestions = await getSuggestedFreeModels(
      makeRedisGetFn(JSON.stringify(openrouterModelIds))
    );

    expect(suggestions).toContain('inclusionai/ling-2.6-flash:free');
  });

  it('should gracefully handle redis failures and return kilo exclusive models only', async () => {
    const suggestions = await getSuggestedFreeModels(makeFailingRedisGetFn());

    expect(Array.isArray(suggestions)).toBe(true);
    for (const suggestion of suggestions) {
      const isKiloExclusive = kiloExclusiveModels.some(
        m => m.public_id === suggestion && m.status !== 'disabled'
      );
      expect(isKiloExclusive).toBe(true);
    }
  });

  it('should gracefully handle null redis response', async () => {
    const suggestions = await getSuggestedFreeModels(makeRedisGetFn(null));

    expect(Array.isArray(suggestions)).toBe(true);
  });
});
