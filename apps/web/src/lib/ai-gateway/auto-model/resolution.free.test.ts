import { beforeEach, describe, expect, it } from '@jest/globals';
import { getAutoFreeCandidates } from './resolution';
import { getOpenRouterModelsFromDatabase } from '@/lib/ai-gateway/providers/gateway-models-cache';
import { findKiloExclusiveModelServing } from '@/lib/ai-gateway/providers/kilo-exclusive-model-serving';
import { gemma_4_26b_a4b_it_free_model } from '@/lib/ai-gateway/providers/google';
import { stepfun_37_flash_free_model } from '@/lib/ai-gateway/providers/stepfun';
import { OPENROUTER } from '@/lib/ai-gateway/providers/definitions/openrouter';
import type * as ModelsModule from '@/lib/ai-gateway/models';
import type * as ServingModule from '@/lib/ai-gateway/providers/kilo-exclusive-model-serving';
import type * as GatewayModelsCache from '@/lib/ai-gateway/providers/gateway-models-cache';

jest.mock('@/lib/ai-gateway/models', () => {
  const actual = jest.requireActual<typeof ModelsModule>('@/lib/ai-gateway/models');
  return {
    ...actual,
    autoFreeModels: [
      ...actual.kiloExclusiveModels.map(model => model.public_id),
      'test/present:free',
      'test/absent:free',
    ].map(model => ({ model, weight: 1, reasoning: { enabled: true } })),
  };
});

jest.mock('@/lib/ai-gateway/providers/gateway-models-cache', () => ({
  ...jest.requireActual<typeof GatewayModelsCache>(
    '@/lib/ai-gateway/providers/gateway-models-cache'
  ),
  getOpenRouterModelsFromDatabase: jest.fn(),
}));

jest.mock('@/lib/ai-gateway/providers/kilo-exclusive-model-serving', () => {
  const actual = jest.requireActual<typeof ServingModule>(
    '@/lib/ai-gateway/providers/kilo-exclusive-model-serving'
  );
  return {
    ...actual,
    findKiloExclusiveModelServing: jest.fn(actual.findKiloExclusiveModelServing),
  };
});

describe('getAutoFreeCandidates exclusive model capabilities', () => {
  beforeEach(() => {
    jest.mocked(getOpenRouterModelsFromDatabase).mockResolvedValue(new Set(['test/present:free']));
  });

  it.each(['chat_completions', 'messages', 'responses', null] as const)(
    'includes hidden and public free bindings for %s without requiring catalog presence',
    async apiKind => {
      expect(await getAutoFreeCandidates(apiKind)).toEqual(
        [
          gemma_4_26b_a4b_it_free_model.public_id,
          stepfun_37_flash_free_model.public_id,
          'test/present:free',
        ].toSorted()
      );
    }
  );

  it('filters using the bound provider capabilities rather than the metadata gateway', async () => {
    jest.mocked(findKiloExclusiveModelServing).mockReturnValueOnce({
      model: gemma_4_26b_a4b_it_free_model,
      provider: { ...OPENROUTER, supportedChatApis: ['chat_completions'] },
    });

    expect(await getAutoFreeCandidates('messages')).toEqual(
      [stepfun_37_flash_free_model.public_id, 'test/present:free'].toSorted()
    );
  });

  it('does not filter provider capabilities when the API kind is null', async () => {
    jest.mocked(findKiloExclusiveModelServing).mockReturnValueOnce({
      model: gemma_4_26b_a4b_it_free_model,
      provider: { ...OPENROUTER, supportedChatApis: ['chat_completions'] },
    });

    expect(await getAutoFreeCandidates(null)).toContain(gemma_4_26b_a4b_it_free_model.public_id);
  });
});
