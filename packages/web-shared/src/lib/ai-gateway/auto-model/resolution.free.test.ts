import { beforeEach, describe, expect, it } from '@jest/globals';
import { getAutoFreeCandidates } from './resolution';
import { getOpenRouterModelsFromDatabase } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import {
  findKiloExclusiveModel,
  gemma_4_26b_a4b_it_free_model,
  glyph_cluster_stealth_free_model,
  kiloExclusiveModels,
  stepfun_5_preview_free_model,
} from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
import { OPENROUTER } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter';
import { getConfiguredAutoFreeModels } from '@kilocode/web-shared/lib/ai-gateway/auto-model/auto-free-config';
import type * as AutoFreeConfigModule from '@kilocode/web-shared/lib/ai-gateway/auto-model/auto-free-config';
import type * as ExclusiveModelsModule from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
import type * as GatewayModelsCache from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';

jest.mock('@kilocode/web-shared/lib/ai-gateway/auto-model/auto-free-config', () => ({
  ...jest.requireActual<typeof AutoFreeConfigModule>(
    '@kilocode/web-shared/lib/ai-gateway/auto-model/auto-free-config'
  ),
  getConfiguredAutoFreeModels: jest.fn(),
}));

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
  ...jest.requireActual<typeof GatewayModelsCache>(
    '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache'
  ),
  getOpenRouterModelsFromDatabase: jest.fn(),
}));

jest.mock('@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models', () => {
  const actual = jest.requireActual<typeof ExclusiveModelsModule>(
    '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models'
  );
  return {
    ...actual,
    findKiloExclusiveModel: jest.fn(actual.findKiloExclusiveModel),
  };
});

const actualFindKiloExclusiveModel = jest.requireActual<typeof ExclusiveModelsModule>(
  '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models'
).findKiloExclusiveModel;

function configure(models: string[]) {
  jest
    .mocked(getConfiguredAutoFreeModels)
    .mockResolvedValue(models.map(model => ({ model, weight: 1, reasoning: { enabled: true } })));
}

function restrictGemmaToChatCompletions() {
  jest.mocked(findKiloExclusiveModel).mockImplementation(model =>
    model === gemma_4_26b_a4b_it_free_model.public_id
      ? {
          ...gemma_4_26b_a4b_it_free_model,
          provider: { ...OPENROUTER, supportedChatApis: ['chat_completions'] },
        }
      : actualFindKiloExclusiveModel(model)
  );
}

describe('getAutoFreeCandidates', () => {
  beforeEach(() => {
    jest.mocked(findKiloExclusiveModel).mockImplementation(actualFindKiloExclusiveModel);
    jest.mocked(getOpenRouterModelsFromDatabase).mockResolvedValue(new Set(['test/present:free']));
    configure([
      ...kiloExclusiveModels.map(model => model.public_id),
      'test/present:free',
      'test/absent:free',
    ]);
  });

  it.each(['chat_completions', 'messages', 'responses', null] as const)(
    'includes hidden and public free models for %s without requiring catalog presence',
    async apiKind => {
      expect(await getAutoFreeCandidates(apiKind)).toEqual(
        [
          gemma_4_26b_a4b_it_free_model.public_id,
          glyph_cluster_stealth_free_model.public_id,
          stepfun_5_preview_free_model.public_id,
          'test/present:free',
        ].toSorted()
      );
    }
  );

  it('filters using the model provider capabilities', async () => {
    restrictGemmaToChatCompletions();

    expect(await getAutoFreeCandidates('messages')).toEqual(
      [
        glyph_cluster_stealth_free_model.public_id,
        stepfun_5_preview_free_model.public_id,
        'test/present:free',
      ].toSorted()
    );
  });

  it('does not filter provider capabilities when the API kind is null', async () => {
    restrictGemmaToChatCompletions();

    expect(await getAutoFreeCandidates(null)).toContain(gemma_4_26b_a4b_it_free_model.public_id);
  });

  it('skips configured models that are not free or need a non-default AI SDK provider', async () => {
    jest
      .mocked(getOpenRouterModelsFromDatabase)
      .mockResolvedValue(
        new Set(['test/present:free', 'test/paid', 'anthropic/claude-free:free', 'kilo-auto/free'])
      );
    configure(['test/present:free', 'test/paid', 'anthropic/claude-free:free', 'kilo-auto/free']);

    expect(await getAutoFreeCandidates('chat_completions')).toEqual(['test/present:free']);
  });

  it('falls back to openrouter/free when nothing is configured or the config is invalid', async () => {
    jest.mocked(getConfiguredAutoFreeModels).mockResolvedValue(null);

    expect(await getAutoFreeCandidates('chat_completions')).toEqual(['openrouter/free']);
  });

  it('falls back to openrouter/free when no configured model is eligible', async () => {
    configure(['test/absent:free', 'test/paid']);

    expect(await getAutoFreeCandidates('chat_completions')).toEqual(['openrouter/free']);
  });
});
