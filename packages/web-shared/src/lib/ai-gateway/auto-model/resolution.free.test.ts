import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { getAutoFreeCandidates } from './resolution';
import { getOpenRouterModelsFromDatabase } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { AUTO_SMALL_TARGET_MODELS } from '@kilocode/web-shared/lib/ai-gateway/auto-model';
import { getConfiguredAutoFreeModels } from '@kilocode/web-shared/lib/ai-gateway/auto-model/auto-free-config';
import { getRuntimeGatewayRoutingConfig } from '@kilocode/web-shared/lib/ai-gateway/providers/routing-config';
import type * as AutoFreeConfigModule from '@kilocode/web-shared/lib/ai-gateway/auto-model/auto-free-config';
import type * as GatewayModelsCache from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import {
  customLlmDefinition,
  deleteCustomLlmForTest,
  insertCustomLlmForTest,
  publicCustomLlmDefinition,
} from '@kilocode/web-shared/tests/helpers/custom-llm.helper';

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

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/vercel', () => ({
  isVercelModel: jest.fn(async (model: string) => model === 'reflection/beam-free'),
}));

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/routing-config', () => ({
  getRuntimeGatewayRoutingConfig: jest.fn(),
}));

function configure(models: string[]) {
  jest
    .mocked(getConfiguredAutoFreeModels)
    .mockResolvedValue(models.map(model => ({ model, weight: 1, reasoning: { enabled: true } })));
}

describe('getAutoFreeCandidates', () => {
  beforeEach(() => {
    jest
      .mocked(getRuntimeGatewayRoutingConfig)
      .mockResolvedValue({ vercelEnabled: true, vercelOptOutModels: new Set() });
    jest.mocked(getOpenRouterModelsFromDatabase).mockResolvedValue(new Set(['test/present:free']));
    configure([AUTO_SMALL_TARGET_MODELS.free, 'test/present:free', 'test/absent:free']);
  });

  it.each(['chat_completions', 'messages', 'responses', null] as const)(
    'includes only free models present in the OpenRouter catalog for %s',
    async apiKind => {
      expect(await getAutoFreeCandidates(apiKind)).toEqual(['test/present:free']);
    }
  );

  it('includes free models Vercel serves while Kilo routes them to Vercel', async () => {
    configure(['test/present:free', 'reflection/beam-free']);
    expect(await getAutoFreeCandidates('chat_completions')).toEqual([
      'reflection/beam-free',
      'test/present:free',
    ]);

    jest
      .mocked(getRuntimeGatewayRoutingConfig)
      .mockResolvedValue({ vercelEnabled: false, vercelOptOutModels: new Set() });
    expect(await getAutoFreeCandidates('chat_completions')).toEqual(['test/present:free']);

    jest.mocked(getRuntimeGatewayRoutingConfig).mockResolvedValue({
      vercelEnabled: true,
      vercelOptOutModels: new Set(['reflection/beam-free']),
    });
    expect(await getAutoFreeCandidates('chat_completions')).toEqual(['test/present:free']);
  });

  it('includes the kilo-auto/small free model when the OpenRouter catalog lists it', async () => {
    jest
      .mocked(getOpenRouterModelsFromDatabase)
      .mockResolvedValue(new Set([AUTO_SMALL_TARGET_MODELS.free, 'test/present:free']));

    expect(await getAutoFreeCandidates('chat_completions')).toEqual(
      [AUTO_SMALL_TARGET_MODELS.free, 'test/present:free'].toSorted()
    );
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

  describe('custom LLMs', () => {
    const customLlmIds = ['acme/chat-free', 'acme/multi-free', 'acme/private-free'];

    beforeEach(async () => {
      await insertCustomLlmForTest('acme/chat-free', publicCustomLlmDefinition(['acme']));
      await insertCustomLlmForTest(
        'acme/multi-free',
        publicCustomLlmDefinition(['acme'], { api_kinds: ['chat_completions', 'messages'] })
      );
      await insertCustomLlmForTest('acme/private-free', customLlmDefinition());
      configure(customLlmIds);
    });

    afterEach(async () => {
      for (const id of customLlmIds) await deleteCustomLlmForTest(id);
    });

    it.each([
      ['chat_completions', ['acme/chat-free', 'acme/multi-free']],
      ['messages', ['acme/multi-free']],
      ['responses', ['openrouter/free']],
      [null, ['acme/chat-free', 'acme/multi-free']],
    ] as const)('includes public custom LLMs that serve %s', async (apiKind, expected) => {
      expect(await getAutoFreeCandidates(apiKind)).toEqual(expected);
    });
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
