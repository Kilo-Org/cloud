import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('@/lib/redis', () => ({
  redisGet: jest.fn(),
}));

import { getSuggestedFreeModels } from './free-model-suggestions';
import { redisGet } from '@/lib/redis';
import { kiloExclusiveModels } from '@/lib/ai-gateway/models';
import { KILO_AUTO_FREE_MODEL } from '@/lib/kilo-auto';

const mockedRedisGet = redisGet as jest.MockedFunction<typeof redisGet>;

describe('getSuggestedFreeModels', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should not include kilo-auto/free in suggestions', async () => {
    mockedRedisGet.mockResolvedValue(null);

    const suggestions = await getSuggestedFreeModels();

    expect(suggestions).not.toContain(KILO_AUTO_FREE_MODEL.id);
  });

  it('should return at most 3 suggestions', async () => {
    mockedRedisGet.mockResolvedValue(null);

    const suggestions = await getSuggestedFreeModels();

    expect(suggestions.length).toBeLessThanOrEqual(3);
  });

  it('should include kilo exclusive free models from preferred list', async () => {
    mockedRedisGet.mockResolvedValue(null);

    const suggestions = await getSuggestedFreeModels();

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
    mockedRedisGet.mockResolvedValue(JSON.stringify(openrouterModelIds));

    const suggestions = await getSuggestedFreeModels();

    expect(suggestions).toContain('inclusionai/ling-2.6-flash:free');
  });

  it('should gracefully handle redis failures and return kilo exclusive models only', async () => {
    mockedRedisGet.mockRejectedValue(new Error('Redis unavailable'));

    const suggestions = await getSuggestedFreeModels();

    expect(Array.isArray(suggestions)).toBe(true);
    for (const suggestion of suggestions) {
      const isKiloExclusive = kiloExclusiveModels.some(
        m => m.public_id === suggestion && m.status !== 'disabled'
      );
      expect(isKiloExclusive).toBe(true);
    }
  });

  it('should gracefully handle null redis response', async () => {
    mockedRedisGet.mockResolvedValue(null);

    const suggestions = await getSuggestedFreeModels();

    expect(Array.isArray(suggestions)).toBe(true);
  });
});
