import { beforeEach, describe, expect, it } from '@jest/globals';
import { getAutoFreeCandidates } from './resolution';
import { getOpenRouterModelsFromDatabase } from '@/lib/ai-gateway/providers/gateway-models-cache';
import {
  findKiloExclusiveModel,
  gemma_4_26b_a4b_it_free_model,
  stepfun_37_flash_free_model,
} from '@/lib/ai-gateway/kilo-exclusive-models';
import { OPENROUTER } from '@/lib/ai-gateway/providers/definitions/openrouter';
import type * as ModelsModule from '@/lib/ai-gateway/models';
import type * as ExclusiveModelsModule from '@/lib/ai-gateway/kilo-exclusive-models';
import type * as GatewayModelsCache from '@/lib/ai-gateway/providers/gateway-models-cache';

jest.mock('@/lib/ai-gateway/models', () => {
  const actual = jest.requireActual<typeof ModelsModule>('@/lib/ai-gateway/models');
  const { kiloExclusiveModels } = jest.requireActual<typeof ExclusiveModelsModule>(
    '@/lib/ai-gateway/kilo-exclusive-models'
  );
  return {
    ...actual,
    autoFreeModels: [
      ...kiloExclusiveModels.map(model => model.public_id),
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

jest.mock('@/lib/ai-gateway/kilo-exclusive-models', () => {
  const actual = jest.requireActual<typeof ExclusiveModelsModule>(
    '@/lib/ai-gateway/kilo-exclusive-models'
  );
  return {
    ...actual,
    findKiloExclusiveModel: jest.fn(actual.findKiloExclusiveModel),
  };
});

describe('getAutoFreeCandidates exclusive model capabilities', () => {
  beforeEach(() => {
    jest.mocked(getOpenRouterModelsFromDatabase).mockResolvedValue(new Set(['test/present:free']));
  });

  it.each(['chat_completions', 'messages', 'responses', null] as const)(
    'includes hidden and public free models for %s without requiring catalog presence',
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

  it('filters using the model provider capabilities', async () => {
    jest.mocked(findKiloExclusiveModel).mockReturnValueOnce({
      ...gemma_4_26b_a4b_it_free_model,
      provider: { ...OPENROUTER, supportedChatApis: ['chat_completions'] },
    });

    expect(await getAutoFreeCandidates('messages')).toEqual(
      [stepfun_37_flash_free_model.public_id, 'test/present:free'].toSorted()
    );
  });

  it('does not filter provider capabilities when the API kind is null', async () => {
    jest.mocked(findKiloExclusiveModel).mockReturnValueOnce({
      ...gemma_4_26b_a4b_it_free_model,
      provider: { ...OPENROUTER, supportedChatApis: ['chat_completions'] },
    });

    expect(await getAutoFreeCandidates(null)).toContain(gemma_4_26b_a4b_it_free_model.public_id);
  });
});
