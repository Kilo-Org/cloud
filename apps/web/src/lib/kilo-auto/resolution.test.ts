import { describe, test, expect } from '@jest/globals';
import { getAutoFreeCandidates } from './resolution';
import { kiloExclusiveModels, preferredModels } from '@/lib/ai-gateway/models';
import { isKiloAutoModel } from '@/lib/kilo-auto';

const kiloExclusiveFreeModelIds = kiloExclusiveModels
  .filter(m => m.status !== 'disabled' && !m.pricing)
  .map(m => m.public_id);

// Non-kilo-exclusive free model present in preferredModels
const NON_EXCLUSIVE_FREE_MODEL = 'inclusionai/ling-2.6-flash:free';

// Kilo-exclusive free models whose gateway does not support all API kinds:
// bytedance and martian both omit 'messages'. morph only supports chat_completions.
const restrictedGateways = ['bytedance', 'martian', 'morph'] as const;
const kiloExclusiveModelsWithRestrictedGateways = kiloExclusiveModels.filter(
  m =>
    m.status !== 'disabled' &&
    !m.pricing &&
    (restrictedGateways as ReadonlyArray<string>).includes(m.gateway)
);

// A kilo-exclusive free model whose gateway supports all three API kinds (openrouter).
const kiloExclusiveOpenRouterFreeModels = kiloExclusiveModels.filter(
  m => m.status !== 'disabled' && !m.pricing && m.gateway === 'openrouter'
);

describe('getAutoFreeCandidates', () => {
  test('excludes non-kilo-exclusive free models when they are absent from the OpenRouter cache', () => {
    const candidates = getAutoFreeCandidates([], 'chat_completions');
    expect(candidates).not.toContain(NON_EXCLUSIVE_FREE_MODEL);
  });

  test('includes non-kilo-exclusive free models when they are present in the OpenRouter cache', () => {
    const candidates = getAutoFreeCandidates([NON_EXCLUSIVE_FREE_MODEL], 'chat_completions');
    expect(candidates).toContain(NON_EXCLUSIVE_FREE_MODEL);
  });

  test('includes kilo-exclusive free models whose gateway supports the API kind', () => {
    // All kilo-exclusive free models with openrouter gateway should be included for all API kinds
    for (const model of kiloExclusiveOpenRouterFreeModels) {
      if (!preferredModels.includes(model.public_id)) continue;
      expect(getAutoFreeCandidates([], 'chat_completions')).toContain(model.public_id);
      expect(getAutoFreeCandidates([], 'messages')).toContain(model.public_id);
      expect(getAutoFreeCandidates([], 'responses')).toContain(model.public_id);
    }
  });

  test('excludes kilo-exclusive free models whose gateway does not support the API kind', () => {
    // bytedance and martian gateways do not support 'messages'
    for (const model of kiloExclusiveModelsWithRestrictedGateways) {
      if (!preferredModels.includes(model.public_id)) continue;
      expect(getAutoFreeCandidates([], 'messages')).not.toContain(model.public_id);
    }
  });

  test('includes kilo-exclusive free models with restricted gateways for supported API kinds', () => {
    // bytedance and martian gateways support chat_completions and responses
    const chatAndResponsGateways = ['bytedance', 'martian'] as const;
    const models = kiloExclusiveModels.filter(
      m =>
        m.status !== 'disabled' &&
        !m.pricing &&
        (chatAndResponsGateways as ReadonlyArray<string>).includes(m.gateway)
    );
    for (const model of models) {
      if (!preferredModels.includes(model.public_id)) continue;
      expect(getAutoFreeCandidates([], 'chat_completions')).toContain(model.public_id);
      expect(getAutoFreeCandidates([], 'responses')).toContain(model.public_id);
    }
  });

  test('includes all kilo-exclusive free models when apiKind is null', () => {
    for (const modelId of kiloExclusiveFreeModelIds) {
      if (!preferredModels.includes(modelId)) continue;
      expect(getAutoFreeCandidates([], null)).toContain(modelId);
    }
  });

  test('never includes kilo-auto models', () => {
    const candidates = getAutoFreeCandidates([NON_EXCLUSIVE_FREE_MODEL, 'kilo-auto/free'], null);
    for (const candidate of candidates) {
      expect(isKiloAutoModel(candidate)).toBe(false);
    }
  });

  test('never includes non-free preferred models', () => {
    const nonFreePreferredModels = preferredModels.filter(
      m => !m.endsWith(':free') && m !== 'openrouter/free' && !kiloExclusiveFreeModelIds.includes(m)
    );
    // Pass all non-free preferred models as if they were in the OpenRouter cache
    const candidates = getAutoFreeCandidates(nonFreePreferredModels, 'chat_completions');
    for (const model of nonFreePreferredModels) {
      expect(candidates).not.toContain(model);
    }
  });

  test('returns a sorted list', () => {
    const candidates = getAutoFreeCandidates([NON_EXCLUSIVE_FREE_MODEL], 'chat_completions');
    const sorted = [...candidates].toSorted();
    expect(candidates).toEqual(sorted);
  });

  test('does not include duplicates', () => {
    const candidates = getAutoFreeCandidates(
      [NON_EXCLUSIVE_FREE_MODEL, NON_EXCLUSIVE_FREE_MODEL],
      'chat_completions'
    );
    const unique = [...new Set(candidates)];
    expect(candidates).toEqual(unique);
  });
});
