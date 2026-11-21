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
  getDirectByokCatalogModelIds,
  getDirectByokModel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
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
  getDirectByokCatalogModelIds: jest.fn(async () => new Set()),
  getDirectByokModel: jest.fn(async () => null),
}));

const IN_REGION = 'anthropic/claude-sonnet-4.6';
const OUT_OF_REGION = 'openai/gpt-5';
const UNLISTED = 'vendor/unlisted-model';
const owner: ByokOwner = { type: 'organization', id: 'org-1' };

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
  jest.mocked(getDirectByokCatalogModelIds).mockReset().mockResolvedValue(new Set());
  jest.mocked(getDirectByokModel).mockReset().mockResolvedValue(null);
});

describe('inferenceRegionIneligibleCandidates', () => {
  it('keeps a model Vercel can pin to the region', async () => {
    await expect(
      inferenceRegionIneligibleCandidates({
        region: 'eu',
        candidateIds: [IN_REGION],
        byokOwner: null,
      })
    ).resolves.toEqual([]);
  });

  it('denies a model Vercel cannot pin to the region', async () => {
    await expect(
      inferenceRegionIneligibleCandidates({
        region: 'eu',
        candidateIds: [IN_REGION, OUT_OF_REGION],
        byokOwner: null,
      })
    ).resolves.toEqual([OUT_OF_REGION]);
  });

  it('denies a model Vercel does not list', async () => {
    await expect(
      inferenceRegionIneligibleCandidates({
        region: 'eu',
        candidateIds: [UNLISTED],
        byokOwner: null,
      })
    ).resolves.toEqual([UNLISTED]);
  });

  it('looks the model up under its Vercel id', async () => {
    await expect(
      inferenceRegionIneligibleCandidates({
        region: 'eu',
        candidateIds: ['z-ai/glm-5.2'],
        byokOwner: null,
      })
    ).resolves.toEqual([]);
    expect(getCachedVercelInferenceRegionsForModel).toHaveBeenCalledWith('zai/glm-5.2');
  });

  it('denies a custom LLM even when Vercel lists the same id in the region', async () => {
    jest.mocked(isCustomLlm).mockImplementation(async modelId => modelId === 'acme/custom');

    await expect(
      inferenceRegionIneligibleCandidates({
        region: 'eu',
        candidateIds: ['acme/custom', IN_REGION],
        byokOwner: null,
      })
    ).resolves.toEqual(['acme/custom']);
  });

  it('ignores virtual auto model ids and deduplicates candidates', async () => {
    await expect(
      inferenceRegionIneligibleCandidates({
        region: 'eu',
        candidateIds: ['kilo-auto/balanced', 'kilo-auto/free', OUT_OF_REGION, OUT_OF_REGION],
        byokOwner: null,
      })
    ).resolves.toEqual([OUT_OF_REGION]);
    expect(getCachedVercelInferenceRegionsForModel).toHaveBeenCalledTimes(1);
  });

  it('returns nothing for no candidates', async () => {
    await expect(
      inferenceRegionIneligibleCandidates({ region: 'eu', candidateIds: [], byokOwner: owner })
    ).resolves.toEqual([]);
  });

  describe('with BYOK', () => {
    it('keeps an out-of-region model the owner’s key serves', async () => {
      enableByokKeys('openai');
      jest
        .mocked(getModelUserByokProviders)
        .mockImplementation(async modelId => (modelId === OUT_OF_REGION ? ['openai'] : []));

      await expect(
        inferenceRegionIneligibleCandidates({
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
        inferenceRegionIneligibleCandidates({
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
        inferenceRegionIneligibleCandidates({
          region: 'eu',
          candidateIds: [IN_REGION],
          byokOwner: owner,
        })
      ).resolves.toEqual([]);
      expect(getEnabledByokProviders).not.toHaveBeenCalled();
    });

    it('denies an out-of-region model when the owner has no enabled keys', async () => {
      await expect(
        inferenceRegionIneligibleCandidates({
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
        inferenceRegionIneligibleCandidates({
          region: 'eu',
          candidateIds: [OUT_OF_REGION],
          byokOwner: owner,
        })
      ).resolves.toEqual([OUT_OF_REGION]);
    });

    it('keeps a model served by a catalog-mode key', async () => {
      enableByokKeys('moonshotai');
      jest
        .mocked(getDirectByokCatalogModelIds)
        .mockResolvedValue(new Set(['moonshotai/kimi-k2.6']));

      await expect(
        inferenceRegionIneligibleCandidates({
          region: 'eu',
          candidateIds: ['moonshotai/kimi-k2.6', UNLISTED],
          byokOwner: owner,
        })
      ).resolves.toEqual([UNLISTED]);
      expect(getDirectByokCatalogModelIds).toHaveBeenCalledWith(owner);
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
        inferenceRegionIneligibleCandidates({
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
        inferenceRegionIneligibleCandidates({
          region: 'eu',
          candidateIds: ['acme/custom'],
          byokOwner: owner,
        })
      ).resolves.toEqual(['acme/custom']);
    });
  });
});
