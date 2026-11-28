import { beforeEach, describe, expect, it } from '@jest/globals';
import type { OrganizationDataRegion } from '@kilocode/db/schema-types';
import type { ByokKeyState, StoredByokKeys } from '@kilocode/web-shared/lib/ai-gateway/byok';
import {
  getModelGatewayUserByokProviders,
  getModelInferenceUserByokProviders,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import { claudeBillingLinkTakesRequests } from '@kilocode/web-shared/lib/ai-gateway/claude-billing/routing';
import {
  findCustomLlm,
  type CustomLlm,
} from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import {
  gatewaySettingsIneligibleCandidates,
  type GatewaySettingsRouting,
} from '@kilocode/web-shared/lib/ai-gateway/gateway-settings-candidates';
import { getOpenAiChatGptByokModelIds } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/routing';
import {
  createDirectByokReferenceResolver,
  findDirectByokCatalogModels,
  getDirectByokModel,
  type DirectByokCatalogModel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import {
  getCachedVercelInferenceProviderIdsForModel,
  getCachedVercelInferenceRegionsForModel,
  getVercelLanguageModelIdsFromDatabase,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import type * as MapModelIdToVercelModule from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import {
  getEffectiveModelDecision,
  isModelAllowedForProviderKey,
  type EffectiveOrganizationModelPolicy,
} from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';

jest.mock('@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog', () => ({
  ...jest.requireActual<object>(
    '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog'
  ),
  findCustomLlm: jest.fn(async () => null),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
  ...jest.requireActual<object>(
    '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache'
  ),
  getCachedVercelInferenceRegionsForModel: jest.fn(),
  getCachedVercelInferenceProviderIdsForModel: jest.fn(),
  getVercelLanguageModelIdsFromDatabase: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel', () => {
  const actual = jest.requireActual<typeof MapModelIdToVercelModule>(
    '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel'
  );
  return {
    ...actual,
    mapModelIdToVercel: jest.fn(async (modelId: string) =>
      actual.mapResolvedModelIdToVercel(modelId, new Map())
    ),
    resolveVercelModelId: jest.fn(async (modelId: string) => ({
      vercelModelId: actual.mapResolvedModelIdToVercel(modelId, new Map()),
      overrides: new Map(),
    })),
  };
});
jest.mock('@kilocode/web-shared/lib/ai-gateway/byok', () => ({
  ...jest.requireActual<object>('@kilocode/web-shared/lib/ai-gateway/byok'),
  getModelInferenceUserByokProviders: jest.fn(async () => []),
  getModelGatewayUserByokProviders: jest.fn(async () => []),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/direct-byok', () => ({
  ...jest.requireActual<object>('@kilocode/web-shared/lib/ai-gateway/providers/direct-byok'),
  getDirectByokModel: jest.fn(async () => null),
  findDirectByokCatalogModels: jest.fn(async () => []),
  createDirectByokReferenceResolver: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/routing', () => ({
  ...jest.requireActual<object>('@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/routing'),
  getOpenAiChatGptCandidateModel: jest.fn(async () => null),
  getOpenAiChatGptByokModelIds: jest.fn(async () => null),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/claude-billing/routing', () => ({
  ...jest.requireActual<object>('@kilocode/web-shared/lib/ai-gateway/claude-billing/routing'),
  claudeBillingLinkTakesRequests: jest.fn(async () => false),
}));
jest.mock(
  '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server',
  () => ({
    ...jest.requireActual<object>(
      '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server'
    ),
    getEffectiveModelDecision: jest.fn(async () => ({ allowed: true })),
    isModelAllowedForProviderKey: jest.fn(async () => true),
  })
);

const IN_REGION = 'moonshotai/kimi-k2.6';
const US_ONLY = 'moonshotai/kimi-k2.5';
const UNLISTED = 'vendor/unlisted-model';
const GPT = 'openai/gpt-5';
const GPT_US_ONLY = 'openai/gpt-5-mini';
const GPT_BEDROCK_EU_ONLY = 'openai/gpt-5.1';
const CLAUDE = 'anthropic/claude-opus-4.8';
const CLAUDE_US_ONLY = 'anthropic/claude-sonnet-4.6';
const policy = { policyRevision: 1 } as EffectiveOrganizationModelPolicy;

/** What Vercel can pin each (Vercel) model id to at each inference provider. */
const vercelRegions: Record<string, Record<string, OrganizationDataRegion[]>> = {
  [IN_REGION]: { moonshotai: ['eu', 'us'] },
  [US_ONLY]: { moonshotai: ['us'] },
  // Only the Amazon Bedrock endpoint of a Kilo-paid OpenAI model is out of the region.
  [GPT]: { openai: ['eu', 'us'], bedrock: ['us'] },
  [GPT_US_ONLY]: { openai: ['us'] },
  [GPT_BEDROCK_EU_ONLY]: { bedrock: ['eu'] },
  [CLAUDE]: { anthropic: ['eu'], bedrock: ['us'] },
  [CLAUDE_US_ONLY]: { anthropic: ['us'] },
  'zai/glm-5.2': { zai: ['eu'] },
};

const readStoredKeys = jest.fn(async (): Promise<StoredByokKeys> => stored([]));
// Callers memoize the read, as `llm-proxy.ts` and the CLI path do.
let memoizedKeys: Promise<StoredByokKeys> | undefined;
const loadStoredByokKeys = () => (memoizedKeys ??= readStoredKeys());
const isNonTrialEnterprise = jest.fn(async () => true);

type KeyFixture = { providerId: string; serveCatalogModels?: boolean; isEnabled?: boolean };

function stored(keys: KeyFixture[]): StoredByokKeys {
  return {
    keys: keys.map(
      ({ providerId, serveCatalogModels = false, isEnabled = true }) =>
        ({ providerId, serveCatalogModels, isEnabled }) as ByokKeyState
    ),
    decrypt: async () => Promise.reject(new Error('not used')),
  };
}

function useKeys(...keys: KeyFixture[]) {
  readStoredKeys.mockResolvedValue(stored(keys));
}

function routing(overrides: Partial<GatewaySettingsRouting> = {}): GatewaySettingsRouting {
  return {
    region: 'eu',
    apiKind: 'chat_completions',
    policy: null,
    settings: undefined,
    requestProvider: undefined,
    effectivePrivacy: {},
    isNonTrialEnterprise,
    caller: { userId: 'user-1', organizationId: 'org-1' },
    loadStoredByokKeys: null,
    ...overrides,
  };
}

function ineligible(candidateIds: string[], overrides: Partial<GatewaySettingsRouting> = {}) {
  return gatewaySettingsIneligibleCandidates(routing(overrides), candidateIds);
}

/** A routing that may use the caller's keys and connections. */
function withKeys(overrides: Partial<GatewaySettingsRouting> = {}) {
  return { loadStoredByokKeys, ...overrides };
}

function catalogModel(
  providerId: string,
  supportedChatApis: string[],
  openrouterInferenceProviderId?: string
) {
  return {
    provider: {
      id: providerId,
      openrouter_inference_provider_id: openrouterInferenceProviderId,
      supportedChatApis,
    },
    model: { id: 'upstream-model', name: 'Model', context_length: 1, max_completion_tokens: 1 },
  } as unknown as DirectByokCatalogModel;
}

function mockCustomLlm(modelId: string, baseUrl = 'https://upstream.example.com/v1') {
  jest
    .mocked(findCustomLlm)
    .mockImplementation(async id =>
      id === modelId
        ? ({ public_id: id, definition: { base_url: baseUrl } } as unknown as CustomLlm)
        : null
    );
}

/** Provider model ids, mapped to the catalog id a catalog-mode key serves them as (null: none). */
function mockProviderModels(rewrites: Record<string, string | null>, providerId = 'synthetic') {
  jest
    .mocked(getDirectByokModel)
    .mockImplementation(async modelId =>
      modelId in rewrites
        ? ({ provider: { id: providerId }, model: {} } as unknown as Awaited<
            ReturnType<typeof getDirectByokModel>
          >)
        : null
    );
  jest
    .mocked(createDirectByokReferenceResolver)
    .mockImplementation(() => async modelId => (modelId in rewrites ? rewrites[modelId] : modelId));
}

beforeEach(() => {
  jest.mocked(findCustomLlm).mockReset().mockResolvedValue(null);
  jest
    .mocked(getCachedVercelInferenceRegionsForModel)
    .mockReset()
    .mockImplementation(async vercelModelId => {
      const providers = vercelRegions[vercelModelId];
      return providers
        ? new Map(
            Object.entries(providers).map(([providerId, regions]) => [providerId, new Set(regions)])
          )
        : null;
    });
  jest
    .mocked(getCachedVercelInferenceProviderIdsForModel)
    .mockReset()
    .mockImplementation(async vercelModelId => {
      const providers = vercelRegions[vercelModelId];
      return providers ? Object.keys(providers) : null;
    });
  jest
    .mocked(getVercelLanguageModelIdsFromDatabase)
    .mockReset()
    .mockResolvedValue(new Set(Object.keys(vercelRegions)));
  jest.mocked(getModelInferenceUserByokProviders).mockReset().mockResolvedValue([]);
  jest.mocked(getModelGatewayUserByokProviders).mockReset().mockResolvedValue([]);
  jest.mocked(getDirectByokModel).mockReset().mockResolvedValue(null);
  jest.mocked(findDirectByokCatalogModels).mockReset().mockResolvedValue([]);
  jest.mocked(createDirectByokReferenceResolver).mockReset();
  jest.mocked(getOpenAiChatGptByokModelIds).mockReset().mockResolvedValue(null);
  jest.mocked(claudeBillingLinkTakesRequests).mockReset().mockResolvedValue(false);
  jest.mocked(getEffectiveModelDecision).mockReset().mockResolvedValue({ allowed: true });
  jest.mocked(isModelAllowedForProviderKey).mockReset().mockResolvedValue(true);
  memoizedKeys = undefined;
  readStoredKeys.mockReset().mockResolvedValue(stored([]));
  isNonTrialEnterprise.mockReset().mockResolvedValue(true);
});

describe('gatewaySettingsIneligibleCandidates', () => {
  describe('on Kilo’s route', () => {
    it('keeps a model some provider serves in the region', async () => {
      await expect(ineligible([IN_REGION])).resolves.toEqual([]);
    });

    it('denies a model no provider serves in the region', async () => {
      await expect(ineligible([IN_REGION, US_ONLY])).resolves.toEqual([US_ONLY]);
    });

    it('denies a model Vercel does not list', async () => {
      await expect(ineligible([UNLISTED])).resolves.toEqual([UNLISTED]);
    });

    it('looks the model up under its Vercel id', async () => {
      await expect(ineligible(['z-ai/glm-5.2'])).resolves.toEqual([]);
      expect(getCachedVercelInferenceRegionsForModel).toHaveBeenCalledWith('zai/glm-5.2');
    });

    it('denies a custom LLM even when its id is servable in the region', async () => {
      mockCustomLlm(IN_REGION);

      await expect(ineligible([IN_REGION, GPT])).resolves.toEqual([IN_REGION]);
    });

    it('ignores virtual auto model ids and deduplicates candidates', async () => {
      await expect(
        ineligible(['kilo-auto/balanced', 'kilo-auto/free', US_ONLY, US_ONLY])
      ).resolves.toEqual([US_ONLY]);
      expect(getCachedVercelInferenceRegionsForModel).toHaveBeenCalledTimes(1);
    });

    it('returns nothing for no candidates', async () => {
      await expect(ineligible([], withKeys())).resolves.toEqual([]);
    });
  });

  describe('under the provider routing settings', () => {
    it.each([
      ['names the in-region provider', { only: ['openai'] }, []],
      [
        'names only a provider that serves the model outside the region',
        { only: ['amazon-bedrock'] },
        [GPT],
      ],
      ['ignores the in-region provider', { ignore: ['openai'] }, [GPT]],
      ['ignores only the out-of-region provider', { ignore: ['amazon-bedrock'] }, []],
    ])('a request whose provider.only/ignore %s', async (_name, requestProvider, expected) => {
      await expect(ineligible([GPT], { requestProvider })).resolves.toEqual(expected);
    });

    it('denies a model the provider settings leave only an out-of-region provider for, and keeps it with another', async () => {
      await expect(
        ineligible([GPT], { requestProvider: { only: ['amazon-bedrock'] } })
      ).resolves.toEqual([GPT]);
      await expect(ineligible([GPT])).resolves.toEqual([]);
    });

    it.each([
      ['the in-region provider', ['openai'], []],
      ['only a provider that serves the model outside the region', ['amazon-bedrock'], [GPT]],
    ])(
      'an organization policy whose eligible provider routes are %s',
      async (_name, routes, expected) => {
        jest
          .mocked(getEffectiveModelDecision)
          .mockResolvedValue({ allowed: true, eligibleProviderRoutes: new Set(routes) });

        await expect(ineligible([GPT], { policy })).resolves.toEqual(expected);
        expect(getEffectiveModelDecision).toHaveBeenCalledWith(policy, GPT);
      }
    );

    it('denies a model whose organization routes and request providers share none', async () => {
      jest
        .mocked(getEffectiveModelDecision)
        .mockResolvedValue({ allowed: true, eligibleProviderRoutes: new Set(['openai']) });

      await expect(
        ineligible([GPT], { policy, requestProvider: { only: ['amazon-bedrock'] } })
      ).resolves.toEqual([GPT]);
    });

    it('does not consult the policy without one', async () => {
      await ineligible([GPT]);

      expect(getEffectiveModelDecision).not.toHaveBeenCalled();
    });

    describe('Kilo’s own ignored providers', () => {
      it('leaves an Anthropic endpoint of a Claude model out of the region for a non-trial-enterprise organization', async () => {
        isNonTrialEnterprise.mockResolvedValue(false);

        await expect(ineligible([CLAUDE])).resolves.toEqual([CLAUDE]);
      });

      it('keeps it for a non-trial enterprise organization', async () => {
        isNonTrialEnterprise.mockResolvedValue(true);

        await expect(ineligible([CLAUDE])).resolves.toEqual([]);
      });

      it('leaves an Amazon Bedrock endpoint of an OpenAI model out of the region for a non-trial-enterprise organization', async () => {
        isNonTrialEnterprise.mockResolvedValue(false);

        await expect(ineligible([GPT_BEDROCK_EU_ONLY])).resolves.toEqual([GPT_BEDROCK_EU_ONLY]);
        await expect(ineligible([GPT])).resolves.toEqual([]);
      });

      it('keeps it for a non-trial enterprise organization', async () => {
        await expect(ineligible([GPT_BEDROCK_EU_ONLY])).resolves.toEqual([]);
      });

      it('does not apply to other models', async () => {
        isNonTrialEnterprise.mockResolvedValue(false);

        await expect(ineligible([IN_REGION])).resolves.toEqual([]);
      });
    });
  });

  describe('with the caller’s keys', () => {
    it('keeps an out-of-region model an inference key serves', async () => {
      useKeys({ providerId: 'moonshotai' });
      jest
        .mocked(getModelInferenceUserByokProviders)
        .mockImplementation(async modelId => (modelId === US_ONLY ? ['moonshotai'] : []));

      await expect(ineligible([US_ONLY, UNLISTED], withKeys())).resolves.toEqual([UNLISTED]);
    });

    it('denies the same model without a key loader', async () => {
      jest.mocked(getModelInferenceUserByokProviders).mockResolvedValue(['moonshotai']);

      await expect(ineligible([US_ONLY], { loadStoredByokKeys: null })).resolves.toEqual([US_ONLY]);
      expect(readStoredKeys).not.toHaveBeenCalled();
    });

    it.each([
      ['a disabled key', [{ providerId: 'moonshotai', isEnabled: false }]],
      ['a key of another provider', [{ providerId: 'anthropic' }]],
      ['no key', []],
    ])('denies an out-of-region model when the caller has %s', async (_name, keys) => {
      useKeys(...keys);
      jest.mocked(getModelInferenceUserByokProviders).mockResolvedValue(['moonshotai']);

      await expect(ineligible([US_ONLY], withKeys())).resolves.toEqual([US_ONLY]);
    });

    it('loads the keys only when some candidate is outside the region, and once', async () => {
      await ineligible([IN_REGION], withKeys());
      expect(readStoredKeys).not.toHaveBeenCalled();

      await ineligible([IN_REGION, US_ONLY, UNLISTED, GPT_US_ONLY], withKeys());
      expect(readStoredKeys).toHaveBeenCalledTimes(1);
    });

    it('denies a custom LLM even when a key serves a model of the same id', async () => {
      useKeys({ providerId: 'moonshotai' });
      jest.mocked(getModelInferenceUserByokProviders).mockResolvedValue(['moonshotai']);
      mockCustomLlm(US_ONLY);

      await expect(ineligible([US_ONLY], withKeys())).resolves.toEqual([US_ONLY]);
    });

    describe('an organization policy', () => {
      it.each([
        ['names the key provider', ['openai'], []],
        ['excludes the key provider', ['anthropic'], [GPT_US_ONLY]],
      ])(
        'whose eligible provider routes %s decides an inference key',
        async (_name, routes, expected) => {
          useKeys({ providerId: 'openai' });
          jest.mocked(getModelInferenceUserByokProviders).mockResolvedValue(['openai']);
          jest
            .mocked(getEffectiveModelDecision)
            .mockResolvedValue({ allowed: true, eligibleProviderRoutes: new Set(routes) });

          await expect(ineligible([GPT_US_ONLY], withKeys({ policy }))).resolves.toEqual(expected);
        }
      );

      it('leaves an inference key unrestricted when its decision names no routes', async () => {
        useKeys({ providerId: 'openai' });
        jest.mocked(getModelInferenceUserByokProviders).mockResolvedValue(['openai']);

        await expect(ineligible([GPT_US_ONLY], withKeys({ policy }))).resolves.toEqual([]);
      });
    });
  });

  describe('with a Vercel AI Gateway key', () => {
    beforeEach(() => {
      useKeys({ providerId: 'vercel-ai-gateway' });
      jest.mocked(getModelGatewayUserByokProviders).mockResolvedValue(['vercel-ai-gateway']);
    });

    it('keeps an out-of-region model the key can route', async () => {
      await expect(ineligible([US_ONLY], withKeys())).resolves.toEqual([]);
    });

    it('denies it when the request’s ignore list leaves no Vercel provider', async () => {
      await expect(
        ineligible([US_ONLY], withKeys({ requestProvider: { ignore: ['moonshotai'] } }))
      ).resolves.toEqual([US_ONLY]);
    });

    it('denies it when the request’s only list names no provider that serves the model', async () => {
      await expect(
        ineligible([US_ONLY], withKeys({ requestProvider: { only: ['openai'] } }))
      ).resolves.toEqual([US_ONLY]);
    });

    it('keeps it when the request’s only list names a provider that serves the model', async () => {
      await expect(
        ineligible([US_ONLY], withKeys({ requestProvider: { only: ['moonshotai'] } }))
      ).resolves.toEqual([]);
    });
  });

  describe('with a catalog-mode key', () => {
    const BESPOKE = 'synthetic/hf:moonshotai/kimi-k2.5-fast';

    beforeEach(() => {
      useKeys({ providerId: 'synthetic', serveCatalogModels: true });
      jest
        .mocked(findDirectByokCatalogModels)
        .mockImplementation(async modelId =>
          modelId === US_ONLY || modelId === IN_REGION
            ? [catalogModel('synthetic', ['chat_completions'])]
            : []
        );
    });

    it('evaluates a provider model id the key rewrites as its catalog id', async () => {
      mockProviderModels({ [BESPOKE]: US_ONLY });

      await expect(ineligible([BESPOKE], withKeys())).resolves.toEqual([]);
      expect(findDirectByokCatalogModels).toHaveBeenCalledWith(US_ONLY);
      expect(createDirectByokReferenceResolver).toHaveBeenCalledWith([
        { providerId: 'synthetic', serveCatalogModels: true },
      ]);
    });

    it('denies the rewrite when the organization policy excludes the key and Kilo’s route is out of the region', async () => {
      mockProviderModels({ [BESPOKE]: US_ONLY });
      jest.mocked(isModelAllowedForProviderKey).mockResolvedValue(false);

      await expect(ineligible([BESPOKE], withKeys({ policy }))).resolves.toEqual([BESPOKE]);
      expect(isModelAllowedForProviderKey).toHaveBeenCalledWith(policy, US_ONLY, 'synthetic');
    });

    it('keeps the rewrite when the policy excludes the key but Kilo’s route is in the region', async () => {
      mockProviderModels({ [BESPOKE]: IN_REGION });
      jest.mocked(isModelAllowedForProviderKey).mockResolvedValue(false);

      await expect(ineligible([BESPOKE], withKeys({ policy }))).resolves.toEqual([]);
    });

    it('checks the policy by the provider’s policy id', async () => {
      mockProviderModels({ [BESPOKE]: US_ONLY });
      jest
        .mocked(findDirectByokCatalogModels)
        .mockResolvedValue([catalogModel('synthetic', ['chat_completions'], 'synthetic-or')]);

      await ineligible([BESPOKE], withKeys({ policy }));

      expect(isModelAllowedForProviderKey).toHaveBeenCalledWith(policy, US_ONLY, 'synthetic-or');
    });

    it('does not deny a provider model id the key does not map to a catalog id', async () => {
      mockProviderModels({ [BESPOKE]: null });

      await expect(ineligible([BESPOKE], withKeys())).resolves.toEqual([]);
      expect(findDirectByokCatalogModels).not.toHaveBeenCalled();
    });

    it('does not deny a provider model id the key serves as it is', async () => {
      useKeys({ providerId: 'synthetic' });
      mockProviderModels({ [BESPOKE]: BESPOKE });

      await expect(ineligible([BESPOKE], withKeys())).resolves.toEqual([]);
    });

    it('treats a provider model id without an enabled key for its provider as any catalog id', async () => {
      useKeys({ providerId: 'synthetic', isEnabled: false });
      mockProviderModels({ [BESPOKE]: US_ONLY });

      await expect(ineligible([BESPOKE], withKeys())).resolves.toEqual([BESPOKE]);
      expect(createDirectByokReferenceResolver).not.toHaveBeenCalled();
    });

    it('does not exempt a catalog key that serves the model only over another API', async () => {
      jest
        .mocked(findDirectByokCatalogModels)
        .mockResolvedValue([catalogModel('synthetic', ['responses'])]);

      await expect(
        ineligible([US_ONLY], withKeys({ apiKind: 'chat_completions' }))
      ).resolves.toEqual([US_ONLY]);
    });

    it.each(['responses', null] as const)(
      'exempts a catalog key over another API when the request’s API is %s',
      async apiKind => {
        jest
          .mocked(findDirectByokCatalogModels)
          .mockResolvedValue([catalogModel('synthetic', ['responses'])]);

        await expect(ineligible([US_ONLY], withKeys({ apiKind }))).resolves.toEqual([]);
      }
    );

    it('does not exempt a key that is not in catalog mode', async () => {
      useKeys({ providerId: 'synthetic', serveCatalogModels: false });

      await expect(ineligible([US_ONLY], withKeys())).resolves.toEqual([US_ONLY]);
    });
  });

  describe('with OpenRouter off and no region', () => {
    const OPENROUTER_ONLY = 'vendor/openrouter-only-model';

    function offIneligible(
      candidateIds: string[],
      overrides: Partial<GatewaySettingsRouting> = {}
    ) {
      return ineligible(candidateIds, { region: null, ...overrides });
    }

    it('denies a model Vercel does not serve', async () => {
      await expect(offIneligible([OPENROUTER_ONLY, UNLISTED])).resolves.toEqual([
        OPENROUTER_ONLY,
        UNLISTED,
      ]);
    });

    it('keeps a model Vercel serves, whatever regions it can be pinned to', async () => {
      await expect(
        offIneligible([IN_REGION, US_ONLY, GPT_US_ONLY, GPT_BEDROCK_EU_ONLY])
      ).resolves.toEqual([]);
      expect(getCachedVercelInferenceRegionsForModel).not.toHaveBeenCalled();
    });

    it('looks the model up under its Vercel id', async () => {
      await expect(offIneligible(['z-ai/glm-5.2'])).resolves.toEqual([]);
    });

    it('ignores virtual auto model ids and deduplicates candidates', async () => {
      await expect(
        offIneligible(['kilo-auto/balanced', OPENROUTER_ONLY, OPENROUTER_ONLY])
      ).resolves.toEqual([OPENROUTER_ONLY]);
    });

    it('does not pin the region of a model, so a model without any pinnable endpoint is kept', async () => {
      jest
        .mocked(getCachedVercelInferenceRegionsForModel)
        .mockResolvedValue(new Map([['moonshotai', new Set()]]));

      await expect(offIneligible([US_ONLY])).resolves.toEqual([]);
    });

    describe('under the provider routing settings', () => {
      it.each([
        ['names a provider that serves the model', { only: ['amazon-bedrock'] }, []],
        ['names the provider that serves the model', { only: ['openai'] }, []],
        ['names only a provider that does not serve the model', { only: ['anthropic'] }, [GPT]],
        ['ignores one provider that serves the model', { ignore: ['openai'] }, []],
        [
          'ignores every provider that serves the model',
          { ignore: ['openai', 'amazon-bedrock'] },
          [GPT],
        ],
        ['ignores the only provider it names', { only: ['openai'], ignore: ['openai'] }, [GPT]],
      ])('a request whose provider.only/ignore %s', async (_name, requestProvider, expected) => {
        await expect(offIneligible([GPT], { requestProvider })).resolves.toEqual(expected);
      });

      it('applies an organization policy’s eligible provider routes', async () => {
        jest
          .mocked(getEffectiveModelDecision)
          .mockResolvedValue({ allowed: true, eligibleProviderRoutes: new Set(['anthropic']) });

        await expect(offIneligible([GPT], { policy })).resolves.toEqual([GPT]);

        jest
          .mocked(getEffectiveModelDecision)
          .mockResolvedValue({ allowed: true, eligibleProviderRoutes: new Set(['openai']) });

        await expect(offIneligible([GPT], { policy })).resolves.toEqual([]);
      });

      it('denies a model whose organization routes and request providers share none', async () => {
        jest
          .mocked(getEffectiveModelDecision)
          .mockResolvedValue({ allowed: true, eligibleProviderRoutes: new Set(['openai']) });

        await expect(
          offIneligible([GPT], { policy, requestProvider: { only: ['amazon-bedrock'] } })
        ).resolves.toEqual([GPT]);
      });

      it('leaves out the providers Kilo ignores for a non-trial-enterprise organization', async () => {
        isNonTrialEnterprise.mockResolvedValue(false);

        // Anthropic is ignored for Claude, Amazon Bedrock for OpenAI models.
        await expect(offIneligible([CLAUDE_US_ONLY, GPT_BEDROCK_EU_ONLY])).resolves.toEqual([
          CLAUDE_US_ONLY,
          GPT_BEDROCK_EU_ONLY,
        ]);
        // Another provider still serves these.
        await expect(offIneligible([CLAUDE, GPT])).resolves.toEqual([]);
      });

      it('keeps them for a non-trial enterprise organization', async () => {
        isNonTrialEnterprise.mockResolvedValue(true);

        await expect(offIneligible([CLAUDE_US_ONLY, GPT_BEDROCK_EU_ONLY])).resolves.toEqual([]);
      });
    });

    describe('a custom LLM', () => {
      it('is kept when its upstream is not OpenRouter', async () => {
        mockCustomLlm(OPENROUTER_ONLY);

        await expect(offIneligible([OPENROUTER_ONLY])).resolves.toEqual([]);
      });

      it('is kept even when Vercel lists a model of its id outside every region', async () => {
        mockCustomLlm(US_ONLY);

        await expect(offIneligible([US_ONLY])).resolves.toEqual([]);
      });

      it.each([
        'https://openrouter.ai/api/v1',
        'https://api.openrouter.ai/v1',
        'https://OPENROUTER.AI.:8443/api/v1',
      ])('is denied when its base_url is on OpenRouter (%s)', async baseUrl => {
        mockCustomLlm(OPENROUTER_ONLY, baseUrl);

        await expect(offIneligible([OPENROUTER_ONLY, IN_REGION])).resolves.toEqual([
          OPENROUTER_ONLY,
        ]);
      });

      it.each([
        'https://openrouter.ai.attacker.example/v1',
        'https://notopenrouter.ai/v1',
        'https://ai-gateway.vercel.sh/v1',
      ])('is kept when its base_url only resembles OpenRouter’s (%s)', async baseUrl => {
        mockCustomLlm(OPENROUTER_ONLY, baseUrl);

        await expect(offIneligible([OPENROUTER_ONLY])).resolves.toEqual([]);
      });

      it('is denied for a region, whatever its upstream', async () => {
        mockCustomLlm(IN_REGION);

        await expect(ineligible([IN_REGION], { region: 'eu' })).resolves.toEqual([IN_REGION]);
      });
    });

    describe('with the caller’s keys and connections', () => {
      it('keeps a model an inference key serves that Vercel does not', async () => {
        useKeys({ providerId: 'moonshotai' });
        jest
          .mocked(getModelInferenceUserByokProviders)
          .mockImplementation(async modelId => (modelId === OPENROUTER_ONLY ? ['moonshotai'] : []));

        await expect(offIneligible([OPENROUTER_ONLY, UNLISTED], withKeys())).resolves.toEqual([
          UNLISTED,
        ]);
      });

      it('keeps a model the owner’s OpenRouter key serves', async () => {
        useKeys({ providerId: 'openrouter' });
        jest.mocked(getModelGatewayUserByokProviders).mockResolvedValue(['openrouter']);

        await expect(offIneligible([OPENROUTER_ONLY], withKeys())).resolves.toEqual([]);
      });

      it('denies the same model without a key loader', async () => {
        jest.mocked(getModelInferenceUserByokProviders).mockResolvedValue(['moonshotai']);

        await expect(offIneligible([OPENROUTER_ONLY])).resolves.toEqual([OPENROUTER_ONLY]);
        expect(readStoredKeys).not.toHaveBeenCalled();
      });

      it('loads the keys only when some candidate is not served by Kilo’s route', async () => {
        await offIneligible([IN_REGION, US_ONLY], withKeys());
        expect(readStoredKeys).not.toHaveBeenCalled();

        await offIneligible([IN_REGION, OPENROUTER_ONLY, UNLISTED], withKeys());
        expect(readStoredKeys).toHaveBeenCalledTimes(1);
      });

      it('still exempts a model a ChatGPT connection serves', async () => {
        jest.mocked(getOpenAiChatGptByokModelIds).mockResolvedValue(new Set([OPENROUTER_ONLY]));

        await expect(
          offIneligible([OPENROUTER_ONLY], withKeys({ apiKind: 'responses' }))
        ).resolves.toEqual([]);
        await expect(
          offIneligible([OPENROUTER_ONLY], withKeys({ apiKind: 'chat_completions' }))
        ).resolves.toEqual([OPENROUTER_ONLY]);
      });

      it('still exempts a Claude model when the Claude link takes requests', async () => {
        jest.mocked(claudeBillingLinkTakesRequests).mockResolvedValue(true);
        jest.mocked(getVercelLanguageModelIdsFromDatabase).mockResolvedValue(new Set());

        await expect(offIneligible([CLAUDE_US_ONLY, US_ONLY], withKeys())).resolves.toEqual([
          US_ONLY,
        ]);
      });

      it('makes no connection lookups when Kilo’s route serves every candidate or the loader is null', async () => {
        await offIneligible([IN_REGION, GPT], withKeys({ apiKind: 'responses' }));
        await offIneligible([OPENROUTER_ONLY], { apiKind: 'responses' });

        expect(getOpenAiChatGptByokModelIds).not.toHaveBeenCalled();
        expect(claudeBillingLinkTakesRequests).not.toHaveBeenCalled();
      });
    });
  });

  describe('with the caller’s connections', () => {
    describe('ChatGPT', () => {
      beforeEach(() => {
        jest.mocked(getOpenAiChatGptByokModelIds).mockImplementation(async (_owner, ids) => {
          return new Set(ids.filter(modelId => modelId === GPT_US_ONLY));
        });
      });

      it.each(['responses', null] as const)(
        'keeps an out-of-region model it serves when the request’s API is %s',
        async apiKind => {
          await expect(ineligible([GPT_US_ONLY, US_ONLY], withKeys({ apiKind }))).resolves.toEqual([
            US_ONLY,
          ]);
          expect(getOpenAiChatGptByokModelIds).toHaveBeenCalledWith(
            { kiloUserId: 'user-1', organizationId: 'org-1' },
            [GPT_US_ONLY, US_ONLY]
          );
        }
      );

      it('denies the same model for Chat Completions, which it does not serve', async () => {
        await expect(
          ineligible([GPT_US_ONLY], withKeys({ apiKind: 'chat_completions' }))
        ).resolves.toEqual([GPT_US_ONLY]);
        expect(getOpenAiChatGptByokModelIds).not.toHaveBeenCalled();
      });

      it('denies an out-of-region model when there is no connection', async () => {
        jest.mocked(getOpenAiChatGptByokModelIds).mockResolvedValue(null);

        await expect(
          ineligible([GPT_US_ONLY], withKeys({ apiKind: 'responses' }))
        ).resolves.toEqual([GPT_US_ONLY]);
      });

      describe('for a service run', () => {
        const SHARED = { organizationId: 'org-1', scope: 'shared_services' };
        const OWN = { kiloUserId: 'user-1', organizationId: 'org-1' };
        const caller = { userId: 'user-1', organizationId: 'org-1', botId: 'bot-1' };

        /** Each connection serves the models listed for its owner. */
        function connectionsServe(shared: string[], own: string[]) {
          jest.mocked(getOpenAiChatGptByokModelIds).mockImplementation(async (owner, ids) => {
            const served = 'scope' in owner && owner.scope === 'shared_services' ? shared : own;
            return new Set(ids.filter(modelId => served.includes(modelId)));
          });
        }

        it('keeps a model only the organization’s shared connection serves', async () => {
          connectionsServe([GPT_US_ONLY], []);

          await expect(
            ineligible([GPT_US_ONLY, US_ONLY], withKeys({ apiKind: 'responses', caller }))
          ).resolves.toEqual([US_ONLY]);
          expect(
            jest.mocked(getOpenAiChatGptByokModelIds).mock.calls.map(([owner]) => owner)
          ).toEqual([SHARED, OWN]);
        });

        it('still counts the user’s own connection', async () => {
          connectionsServe([], [GPT_US_ONLY]);

          await expect(
            ineligible([GPT_US_ONLY], withKeys({ apiKind: 'responses', caller }))
          ).resolves.toEqual([]);
          expect(getOpenAiChatGptByokModelIds).toHaveBeenCalledWith(OWN, [GPT_US_ONLY]);
        });

        it('unions what the two connections serve', async () => {
          connectionsServe(['openai/gpt-5-mini'], ['openai/gpt-5.2']);
          vercelRegions['openai/gpt-5.2'] = { openai: ['us'] };

          try {
            await expect(
              ineligible(
                ['openai/gpt-5-mini', 'openai/gpt-5.2', US_ONLY],
                withKeys({ apiKind: null, caller })
              )
            ).resolves.toEqual([US_ONLY]);
          } finally {
            delete vercelRegions['openai/gpt-5.2'];
          }
        });

        it('does not consult the shared connection without a bot', async () => {
          connectionsServe([GPT_US_ONLY], []);

          await expect(
            ineligible(
              [GPT_US_ONLY],
              withKeys({
                apiKind: 'responses',
                caller: { userId: 'user-1', organizationId: 'org-1' },
              })
            )
          ).resolves.toEqual([GPT_US_ONLY]);
          expect(getOpenAiChatGptByokModelIds).toHaveBeenCalledTimes(1);
          expect(getOpenAiChatGptByokModelIds).toHaveBeenCalledWith(OWN, [GPT_US_ONLY]);
          expect(
            jest.mocked(getOpenAiChatGptByokModelIds).mock.calls.map(([owner]) => owner)
          ).toEqual([OWN]);
        });

        it('does not consult either connection for Chat Completions', async () => {
          connectionsServe([GPT_US_ONLY], [GPT_US_ONLY]);

          await expect(
            ineligible([GPT_US_ONLY], withKeys({ apiKind: 'chat_completions', caller }))
          ).resolves.toEqual([GPT_US_ONLY]);
          expect(getOpenAiChatGptByokModelIds).not.toHaveBeenCalled();
        });
      });

      it('asks only about the candidates still ineligible', async () => {
        await ineligible([IN_REGION, GPT_US_ONLY], withKeys({ apiKind: 'responses' }));

        expect(getOpenAiChatGptByokModelIds).toHaveBeenCalledWith(expect.anything(), [GPT_US_ONLY]);
      });
    });

    describe('Claude link', () => {
      it.each(['connected', 'billing_unavailable'])(
        'keeps an out-of-region Claude model when the link takes requests (%s)',
        async () => {
          jest.mocked(claudeBillingLinkTakesRequests).mockResolvedValue(true);

          await expect(ineligible([CLAUDE_US_ONLY], withKeys())).resolves.toEqual([]);
          expect(claudeBillingLinkTakesRequests).toHaveBeenCalledWith({
            userId: 'user-1',
            organizationId: 'org-1',
          });
        }
      );

      it.each(['no link', 'a removed link', 'a link in another status'])(
        'denies an out-of-region Claude model with %s',
        async () => {
          jest.mocked(claudeBillingLinkTakesRequests).mockResolvedValue(false);

          await expect(ineligible([CLAUDE_US_ONLY], withKeys())).resolves.toEqual([CLAUDE_US_ONLY]);
        }
      );

      it('exempts a latest alias of a Claude model, not a model of another vendor', async () => {
        jest.mocked(claudeBillingLinkTakesRequests).mockResolvedValue(true);

        await expect(
          ineligible([CLAUDE_US_ONLY, US_ONLY, GPT_US_ONLY], withKeys())
        ).resolves.toEqual([US_ONLY, GPT_US_ONLY]);
      });

      it('exempts the Claude model for every request API', async () => {
        jest.mocked(claudeBillingLinkTakesRequests).mockResolvedValue(true);

        for (const apiKind of ['chat_completions', 'messages', 'responses', null] as const) {
          await expect(ineligible([CLAUDE_US_ONLY], withKeys({ apiKind }))).resolves.toEqual([]);
        }
      });
    });

    describe('lookups', () => {
      it('makes none when every candidate is eligible', async () => {
        await expect(
          ineligible([IN_REGION, GPT], withKeys({ apiKind: 'responses' }))
        ).resolves.toEqual([]);

        expect(getOpenAiChatGptByokModelIds).not.toHaveBeenCalled();
        expect(claudeBillingLinkTakesRequests).not.toHaveBeenCalled();
        expect(readStoredKeys).not.toHaveBeenCalled();
      });

      it('makes none without a key loader, as for Auto Free', async () => {
        jest.mocked(claudeBillingLinkTakesRequests).mockResolvedValue(true);
        jest.mocked(getOpenAiChatGptByokModelIds).mockResolvedValue(new Set([GPT_US_ONLY]));

        await expect(
          ineligible([CLAUDE_US_ONLY, GPT_US_ONLY], {
            apiKind: 'responses',
            loadStoredByokKeys: null,
          })
        ).resolves.toEqual([CLAUDE_US_ONLY, GPT_US_ONLY]);

        expect(getOpenAiChatGptByokModelIds).not.toHaveBeenCalled();
        expect(claudeBillingLinkTakesRequests).not.toHaveBeenCalled();
      });

      it('makes each at most once for a request', async () => {
        jest.mocked(getOpenAiChatGptByokModelIds).mockResolvedValue(new Set());

        await ineligible([GPT_US_ONLY, US_ONLY, UNLISTED], withKeys({ apiKind: 'responses' }));

        expect(getOpenAiChatGptByokModelIds).toHaveBeenCalledTimes(1);
        expect(claudeBillingLinkTakesRequests).toHaveBeenCalledTimes(1);
      });
    });
  });
});
