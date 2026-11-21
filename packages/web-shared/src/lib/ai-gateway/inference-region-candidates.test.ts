import { beforeEach, describe, expect, it } from '@jest/globals';
import type { OrganizationDataRegion } from '@kilocode/db/schema-types';
import {
  getEnabledByokProviders,
  getModelUserByokProviders,
  type ByokOwner,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import { isCustomLlm } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import { inferenceRegionIneligibleCandidates } from '@kilocode/web-shared/lib/ai-gateway/inference-region-candidates';
import {
  getCatalogModeModelIds,
  getDirectByokModel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import {
  getEffectiveModelDecision,
  isModelAllowedForProviderKey,
  type EffectiveOrganizationModelPolicy,
} from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';
import { getCachedVercelInferenceRegionsForModel } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import type * as MapModelIdToVercelModule from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';

jest.mock('@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog', () => ({
  ...jest.requireActual<object>(
    '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog'
  ),
  isCustomLlm: jest.fn(async () => false),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
  ...jest.requireActual<object>(
    '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache'
  ),
  getCachedVercelInferenceRegionsForModel: jest.fn(),
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
  };
});
jest.mock('@kilocode/web-shared/lib/ai-gateway/byok', () => ({
  ...jest.requireActual<object>('@kilocode/web-shared/lib/ai-gateway/byok'),
  getEnabledByokProviders: jest.fn(async () => []),
  getModelUserByokProviders: jest.fn(async () => []),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/direct-byok', () => ({
  ...jest.requireActual<object>('@kilocode/web-shared/lib/ai-gateway/providers/direct-byok'),
  getCatalogModeModelIds: jest.fn(async () => new Set()),
  getDirectByokModel: jest.fn(async () => null),
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

const IN_REGION = 'anthropic/claude-sonnet-4.6';
const OUT_OF_REGION = 'openai/gpt-5';
const UNLISTED = 'vendor/unlisted-model';
const owner: ByokOwner = { type: 'organization', id: 'org-1' };
const policy = { policyRevision: 1 } as EffectiveOrganizationModelPolicy;

type IneligibleParams = Parameters<typeof inferenceRegionIneligibleCandidates>[0];

function ineligible(
  params: Omit<IneligibleParams, 'policy'> & { policy?: IneligibleParams['policy'] }
) {
  return inferenceRegionIneligibleCandidates({ policy: null, ...params });
}

/** A catalog-mode key of a provider serving the catalog model, as `getCatalogModeModelIds` finds. */
function serveCatalogModels(...served: Array<[catalogModelId: string, policyProviderId: string]>) {
  jest.mocked(getCatalogModeModelIds).mockImplementation(async (_keys, isServingAllowed) => {
    const modelIds = new Set<string>();
    for (const [modelId, policyProviderId] of served) {
      if (await isServingAllowed(modelId, policyProviderId)) modelIds.add(modelId);
    }
    return modelIds;
  });
}

/** What Vercel can pin each (Vercel) model id to. Ids not listed here are unlisted at Vercel. */
const vercelRegions: Record<string, OrganizationDataRegion[]> = {
  [IN_REGION]: ['eu', 'us'],
  [OUT_OF_REGION]: ['us'],
  'zai/glm-5.2': ['eu'],
  'acme/custom': ['eu'],
};

function enableByokKeys(...providerIds: string[]) {
  jest
    .mocked(getEnabledByokProviders)
    .mockResolvedValue(
      providerIds.map(providerId => ({ providerId, serveCatalogModels: false })) as never
    );
}

beforeEach(() => {
  jest.mocked(isCustomLlm).mockReset().mockResolvedValue(false);
  jest
    .mocked(getCachedVercelInferenceRegionsForModel)
    .mockReset()
    .mockImplementation(async vercelModelId => {
      const regions = vercelRegions[vercelModelId];
      return regions ? new Set(regions) : null;
    });
  jest.mocked(getEnabledByokProviders).mockReset().mockResolvedValue([]);
  jest.mocked(getModelUserByokProviders).mockReset().mockResolvedValue([]);
  jest.mocked(getCatalogModeModelIds).mockReset().mockResolvedValue(new Set());
  jest.mocked(getEffectiveModelDecision).mockReset().mockResolvedValue({ allowed: true });
  jest.mocked(isModelAllowedForProviderKey).mockReset().mockResolvedValue(true);
  jest.mocked(getDirectByokModel).mockReset().mockResolvedValue(null);
});

describe('inferenceRegionIneligibleCandidates', () => {
  it('keeps a model servable in the region', async () => {
    await expect(
      ineligible({
        region: 'eu',
        candidateIds: [IN_REGION],
        byokOwner: null,
      })
    ).resolves.toEqual([]);
  });

  it('denies a model not servable in the region', async () => {
    await expect(
      ineligible({
        region: 'eu',
        candidateIds: [IN_REGION, OUT_OF_REGION],
        byokOwner: null,
      })
    ).resolves.toEqual([OUT_OF_REGION]);
  });

  it('denies a model no region-pinning route serves', async () => {
    await expect(
      ineligible({
        region: 'eu',
        candidateIds: [UNLISTED],
        byokOwner: null,
      })
    ).resolves.toEqual([UNLISTED]);
  });

  it('looks the model up under its Vercel id', async () => {
    await expect(
      ineligible({
        region: 'eu',
        candidateIds: ['z-ai/glm-5.2'],
        byokOwner: null,
      })
    ).resolves.toEqual([]);
    expect(getCachedVercelInferenceRegionsForModel).toHaveBeenCalledWith('zai/glm-5.2');
  });

  it('denies a custom LLM even when its id is otherwise servable in the region', async () => {
    jest.mocked(isCustomLlm).mockImplementation(async modelId => modelId === 'acme/custom');

    await expect(
      ineligible({
        region: 'eu',
        candidateIds: ['acme/custom', IN_REGION],
        byokOwner: null,
      })
    ).resolves.toEqual(['acme/custom']);
  });

  it('ignores virtual auto model ids and deduplicates candidates', async () => {
    await expect(
      ineligible({
        region: 'eu',
        candidateIds: ['kilo-auto/balanced', 'kilo-auto/free', OUT_OF_REGION, OUT_OF_REGION],
        byokOwner: null,
      })
    ).resolves.toEqual([OUT_OF_REGION]);
    expect(getCachedVercelInferenceRegionsForModel).toHaveBeenCalledTimes(1);
  });

  it('returns nothing for no candidates', async () => {
    await expect(ineligible({ region: 'eu', candidateIds: [], byokOwner: owner })).resolves.toEqual(
      []
    );
  });

  describe('with BYOK', () => {
    it('keeps an out-of-region model the owner’s key serves', async () => {
      enableByokKeys('openai');
      jest
        .mocked(getModelUserByokProviders)
        .mockImplementation(async modelId => (modelId === OUT_OF_REGION ? ['openai'] : []));

      await expect(
        ineligible({
          region: 'eu',
          candidateIds: [OUT_OF_REGION, UNLISTED],
          byokOwner: owner,
        })
      ).resolves.toEqual([UNLISTED]);
      expect(getEnabledByokProviders).toHaveBeenCalledWith(expect.anything(), owner);
    });

    it('denies the same model when no BYOK owner is given', async () => {
      enableByokKeys('openai');
      jest.mocked(getModelUserByokProviders).mockResolvedValue(['openai']);

      await expect(
        ineligible({
          region: 'eu',
          candidateIds: [OUT_OF_REGION],
          byokOwner: null,
        })
      ).resolves.toEqual([OUT_OF_REGION]);
      expect(getEnabledByokProviders).not.toHaveBeenCalled();
    });

    it('does not look up BYOK when every candidate is in the region', async () => {
      enableByokKeys('openai');

      await expect(
        ineligible({
          region: 'eu',
          candidateIds: [IN_REGION],
          byokOwner: owner,
        })
      ).resolves.toEqual([]);
      expect(getEnabledByokProviders).not.toHaveBeenCalled();
    });

    it('denies an out-of-region model when the owner has no enabled keys', async () => {
      await expect(
        ineligible({
          region: 'eu',
          candidateIds: [OUT_OF_REGION],
          byokOwner: owner,
        })
      ).resolves.toEqual([OUT_OF_REGION]);
      expect(getModelUserByokProviders).not.toHaveBeenCalled();
    });

    it('denies an out-of-region model when the enabled keys cannot serve it', async () => {
      enableByokKeys('anthropic');
      jest.mocked(getModelUserByokProviders).mockResolvedValue(['openai']);

      await expect(
        ineligible({
          region: 'eu',
          candidateIds: [OUT_OF_REGION],
          byokOwner: owner,
        })
      ).resolves.toEqual([OUT_OF_REGION]);
    });

    it('keeps a model served by a catalog-mode key', async () => {
      enableByokKeys('moonshotai');
      serveCatalogModels(['moonshotai/kimi-k2.6', 'moonshotai']);

      await expect(
        ineligible({
          region: 'eu',
          candidateIds: ['moonshotai/kimi-k2.6', UNLISTED],
          byokOwner: owner,
        })
      ).resolves.toEqual([UNLISTED]);
      expect(getCatalogModeModelIds).toHaveBeenCalledTimes(1);
      expect(getEnabledByokProviders).toHaveBeenCalledTimes(1);
    });

    it('denies a custom LLM that shares its id with a catalog-mode key’s catalog model', async () => {
      enableByokKeys('moonshotai');
      serveCatalogModels(['moonshotai/kimi-k2.6', 'moonshotai']);
      jest
        .mocked(isCustomLlm)
        .mockImplementation(async modelId => modelId === 'moonshotai/kimi-k2.6');

      await expect(
        ineligible({
          region: 'eu',
          candidateIds: ['moonshotai/kimi-k2.6'],
          byokOwner: owner,
        })
      ).resolves.toEqual(['moonshotai/kimi-k2.6']);
    });

    it('denies a custom LLM that shares its id with a direct BYOK model', async () => {
      enableByokKeys('synthetic');
      jest
        .mocked(getDirectByokModel)
        .mockResolvedValue({ provider: { id: 'synthetic' }, model: {} } as never);
      jest
        .mocked(isCustomLlm)
        .mockImplementation(async modelId => modelId === 'synthetic/hf:vendor/model');

      await expect(
        ineligible({
          region: 'eu',
          candidateIds: ['synthetic/hf:vendor/model'],
          byokOwner: owner,
        })
      ).resolves.toEqual(['synthetic/hf:vendor/model']);
    });

    it.each([
      ['an enabled', ['synthetic'], []],
      ['a disabled', ['openai'], ['synthetic/hf:vendor/model']],
    ])('handles a direct BYOK model of %s provider key', async (_name, enabled, expectedDenied) => {
      enableByokKeys(...enabled);
      jest
        .mocked(getDirectByokModel)
        .mockResolvedValue({ provider: { id: 'synthetic' }, model: {} } as never);

      await expect(
        ineligible({
          region: 'eu',
          candidateIds: ['synthetic/hf:vendor/model'],
          byokOwner: owner,
        })
      ).resolves.toEqual(expectedDenied);
    });

    it('denies a custom LLM even when an enabled key lists the model', async () => {
      enableByokKeys('openai');
      jest.mocked(isCustomLlm).mockResolvedValue(true);
      jest.mocked(getModelUserByokProviders).mockResolvedValue(['openai']);

      await expect(
        ineligible({
          region: 'eu',
          candidateIds: ['acme/custom'],
          byokOwner: owner,
        })
      ).resolves.toEqual(['acme/custom']);
    });

    describe('under an organization model policy', () => {
      it('checks a catalog-mode key against the policy and denies when the policy disallows its provider', async () => {
        enableByokKeys('moonshotai');
        serveCatalogModels(['moonshotai/kimi-k2.6', 'moonshotai'], ['z-ai/glm-5.2', 'z-ai']);
        jest
          .mocked(isModelAllowedForProviderKey)
          .mockImplementation(async (_policy, _modelId, providerSlug) => providerSlug === 'z-ai');

        await expect(
          ineligible({
            region: 'eu',
            candidateIds: ['moonshotai/kimi-k2.6', 'z-ai/glm-5.2'],
            byokOwner: owner,
            policy,
          })
        ).resolves.toEqual(['moonshotai/kimi-k2.6']);
        expect(isModelAllowedForProviderKey).toHaveBeenCalledWith(
          policy,
          'moonshotai/kimi-k2.6',
          'moonshotai'
        );
      });

      it('does not consult the policy without one', async () => {
        enableByokKeys('moonshotai');
        serveCatalogModels(['moonshotai/kimi-k2.6', 'moonshotai']);
        jest.mocked(isModelAllowedForProviderKey).mockResolvedValue(false);

        await expect(
          ineligible({
            region: 'eu',
            candidateIds: ['moonshotai/kimi-k2.6'],
            byokOwner: owner,
            policy: null,
          })
        ).resolves.toEqual([]);
        expect(isModelAllowedForProviderKey).not.toHaveBeenCalled();
        expect(getEffectiveModelDecision).not.toHaveBeenCalled();
      });

      it.each([
        ['allows', true, []],
        ['disallows', false, ['synthetic/hf:vendor/model']],
      ])(
        'checks a direct BYOK key against the policy provider id when the policy %s it',
        async (_name, allowed, expectedDenied) => {
          enableByokKeys('synthetic');
          jest.mocked(getDirectByokModel).mockResolvedValue({
            provider: { id: 'synthetic', openrouter_inference_provider_id: 'synthetic-or' },
            model: {},
          } as never);
          jest.mocked(isModelAllowedForProviderKey).mockResolvedValue(allowed);

          await expect(
            ineligible({
              region: 'eu',
              candidateIds: ['synthetic/hf:vendor/model'],
              byokOwner: owner,
              policy,
            })
          ).resolves.toEqual(expectedDenied);
          expect(isModelAllowedForProviderKey).toHaveBeenCalledWith(
            policy,
            'synthetic/hf:vendor/model',
            'synthetic-or'
          );
        }
      );

      it.each([
        ['an only list that names the key provider', new Set(['openai']), []],
        ['an only list that excludes the key provider', new Set(['anthropic']), [OUT_OF_REGION]],
      ])(
        'passes the eligible provider routes as the allowed providers of an inference key: %s',
        async (_name, eligibleProviderRoutes, expectedDenied) => {
          enableByokKeys('openai');
          jest.mocked(getModelUserByokProviders).mockResolvedValue(['openai']);
          jest
            .mocked(getEffectiveModelDecision)
            .mockResolvedValue({ allowed: true, eligibleProviderRoutes });

          await expect(
            ineligible({
              region: 'eu',
              candidateIds: [OUT_OF_REGION],
              byokOwner: owner,
              policy,
            })
          ).resolves.toEqual(expectedDenied);
          expect(getEffectiveModelDecision).toHaveBeenCalledWith(policy, OUT_OF_REGION);
        }
      );

      it('keeps an inference key whose decision has no provider restriction', async () => {
        enableByokKeys('openai');
        jest.mocked(getModelUserByokProviders).mockResolvedValue(['openai']);

        await expect(
          ineligible({ region: 'eu', candidateIds: [OUT_OF_REGION], byokOwner: owner, policy })
        ).resolves.toEqual([]);
      });

      it('denies a model the policy does not allow even with a matching inference key', async () => {
        enableByokKeys('openai');
        jest.mocked(getModelUserByokProviders).mockResolvedValue(['openai']);
        jest
          .mocked(getEffectiveModelDecision)
          .mockResolvedValue({ allowed: false, denialSource: 'no_grant' });

        await expect(
          ineligible({ region: 'eu', candidateIds: [OUT_OF_REGION], byokOwner: owner, policy })
        ).resolves.toEqual([OUT_OF_REGION]);
      });
    });
  });
});
