import { describe, test, expect } from '@jest/globals';
import { getAutoFreeCandidates } from './resolution';
import { kiloExclusiveModels, preferredModels } from '@/lib/ai-gateway/models';
import { isKiloAutoModel } from '@/lib/kilo-auto';

const kiloExclusiveFreeModelIds = kiloExclusiveModels
  .filter(m => m.status === 'public' && !m.pricing)
  .map(m => m.public_id);

// Non-kilo-exclusive free model present in preferredModels
const NON_EXCLUSIVE_FREE_MODEL = 'inclusionai/ling-2.6-flash:free';

describe('getAutoFreeCandidates', () => {
  test('excludes non-kilo-exclusive free models when they are absent from the OpenRouter cache', () => {
    const candidates = getAutoFreeCandidates([]);
    expect(candidates).not.toContain(NON_EXCLUSIVE_FREE_MODEL);
  });

  test('includes non-kilo-exclusive free models when they are present in the OpenRouter cache', () => {
    const candidates = getAutoFreeCandidates([NON_EXCLUSIVE_FREE_MODEL]);
    expect(candidates).toContain(NON_EXCLUSIVE_FREE_MODEL);
  });

  test('always includes kilo-exclusive free models regardless of the OpenRouter cache', () => {
    const candidatesWithEmptyCache = getAutoFreeCandidates([]);
    const candidatesWithFullCache = getAutoFreeCandidates([NON_EXCLUSIVE_FREE_MODEL]);

    for (const modelId of kiloExclusiveFreeModelIds) {
      if (preferredModels.includes(modelId)) {
        expect(candidatesWithEmptyCache).toContain(modelId);
        expect(candidatesWithFullCache).toContain(modelId);
      }
    }
  });

  test('never includes kilo-auto models', () => {
    const candidates = getAutoFreeCandidates([NON_EXCLUSIVE_FREE_MODEL, 'kilo-auto/free']);
    for (const candidate of candidates) {
      expect(isKiloAutoModel(candidate)).toBe(false);
    }
  });

  test('never includes non-free preferred models', () => {
    const nonFreePreferredModels = preferredModels.filter(
      m => !m.endsWith(':free') && m !== 'openrouter/free' && !kiloExclusiveFreeModelIds.includes(m)
    );
    // Pass all non-free preferred models as if they were in the OpenRouter cache
    const candidates = getAutoFreeCandidates(nonFreePreferredModels);
    for (const model of nonFreePreferredModels) {
      expect(candidates).not.toContain(model);
    }
  });

  test('returns a sorted list', () => {
    const candidates = getAutoFreeCandidates([NON_EXCLUSIVE_FREE_MODEL]);
    const sorted = [...candidates].toSorted();
    expect(candidates).toEqual(sorted);
  });

  test('does not include duplicates', () => {
    const candidates = getAutoFreeCandidates([NON_EXCLUSIVE_FREE_MODEL, NON_EXCLUSIVE_FREE_MODEL]);
    const unique = [...new Set(candidates)];
    expect(candidates).toEqual(unique);
  });
});
