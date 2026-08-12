import { describe, expect, it, jest } from '@jest/globals';
import type { EffectiveOrganizationModelPolicy } from '@/lib/organizations/effective-model-access.server';
import { MINIMAX_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/minimax';
import {
  candidateModelIdsFromRoutingTable,
  candidateModelIdsFromSources,
  collectDeniedAutoRoutingModelIds,
  policyNeedsCandidateEvaluation,
} from './auto-routing-denied-models';

function policy(
  overrides: Partial<EffectiveOrganizationModelPolicy> = {}
): EffectiveOrganizationModelPolicy {
  return {
    requireModelInCurrentSnapshot: false,
    organizationModelDenyList: [],
    memberGrant: { mode: 'unrestricted' },
    policyRevision: 1,
    ...overrides,
  };
}

describe('policyNeedsCandidateEvaluation', () => {
  it('is false for an unrestricted policy with only a deny list', () => {
    expect(
      policyNeedsCandidateEvaluation(policy({ organizationModelDenyList: ['openai/gpt-4o'] }))
    ).toBe(false);
  });

  it('is true when a provider ceiling is set', () => {
    expect(
      policyNeedsCandidateEvaluation(policy({ organizationProviderCeiling: ['anthropic'] }))
    ).toBe(true);
  });

  it('is true for a selected member grant', () => {
    expect(
      policyNeedsCandidateEvaluation(
        policy({
          memberGrant: {
            mode: 'selected',
            modelAllowList: ['anthropic/claude'],
            providerAllowList: [],
          },
        })
      )
    ).toBe(true);
  });

  it('is true when the current snapshot is required', () => {
    expect(policyNeedsCandidateEvaluation(policy({ requireModelInCurrentSnapshot: true }))).toBe(
      true
    );
  });
});

describe('collectDeniedAutoRoutingModelIds', () => {
  it('returns the organization deny list without loading candidates', async () => {
    const loadCandidateModelIds = jest.fn(async () => ['google/gemini-2.5-flash']);
    const decideModel = jest.fn(async () => ({ allowed: false }));

    await expect(
      collectDeniedAutoRoutingModelIds(
        policy({ organizationModelDenyList: ['openai/gpt-4o:free'] }),
        { loadCandidateModelIds, decideModel }
      )
    ).resolves.toEqual(['openai/gpt-4o']);
    expect(loadCandidateModelIds).not.toHaveBeenCalled();
    expect(decideModel).not.toHaveBeenCalled();
  });

  it('does not load candidates when owner is set but the policy cannot deny anything', async () => {
    const loadCandidateModelIds = jest.fn(async () => ['google/gemini-2.5-flash']);
    const loadEffectivePoolModelIds = jest.fn(async () => ['pool/only-model']);

    await expect(
      collectDeniedAutoRoutingModelIds(policy(), {
        owner: { userId: 'user-1', organizationId: 'org-1' },
        loadCandidateModelIds,
        loadEffectivePoolModelIds,
      })
    ).resolves.toEqual([]);
    expect(loadCandidateModelIds).not.toHaveBeenCalled();
    expect(loadEffectivePoolModelIds).not.toHaveBeenCalled();
  });

  it('adds models that fail the effective access policy', async () => {
    const decideModel = jest.fn(
      async (_policy: EffectiveOrganizationModelPolicy, modelId: string) => ({
        allowed: modelId !== 'google/gemini-2.5-flash',
      })
    );

    await expect(
      collectDeniedAutoRoutingModelIds(
        policy({
          organizationProviderCeiling: ['anthropic'],
          organizationModelDenyList: ['openai/o3'],
        }),
        {
          candidateModelIds: ['anthropic/claude', 'google/gemini-2.5-flash', 'kilo-auto/efficient'],
          decideModel,
        }
      )
    ).resolves.toEqual(['openai/o3', 'google/gemini-2.5-flash']);
    expect(decideModel).toHaveBeenCalledTimes(2);
    expect(decideModel).not.toHaveBeenCalledWith(expect.anything(), 'kilo-auto/efficient');
  });

  it('loads routing-table and fallback candidates when a provider ceiling is set', async () => {
    const decideModel = jest.fn(
      async (_policy: EffectiveOrganizationModelPolicy, modelId: string) => ({
        allowed: modelId !== 'google/gemini-2.5-flash',
      })
    );

    const denied = await collectDeniedAutoRoutingModelIds(
      policy({ organizationProviderCeiling: ['anthropic'] }),
      {
        loadCandidateModelIds: async () => ['google/gemini-2.5-flash', 'anthropic/claude'],
        decideModel,
      }
    );

    expect(denied).toEqual(['google/gemini-2.5-flash']);
    expect(decideModel).toHaveBeenCalledWith(expect.anything(), 'google/gemini-2.5-flash');
    expect(decideModel).toHaveBeenCalledWith(expect.anything(), 'anthropic/claude');
  });

  it('keeps the exact denied candidate id, including suffixes', async () => {
    const decideModel = jest.fn(
      async (_policy: EffectiveOrganizationModelPolicy, modelId: string) => ({
        allowed: modelId !== 'deepseek/deepseek-v4-pro:discounted',
      })
    );

    await expect(
      collectDeniedAutoRoutingModelIds(policy({ organizationProviderCeiling: ['deepseek'] }), {
        candidateModelIds: ['deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-pro:discounted'],
        decideModel,
      })
    ).resolves.toEqual(['deepseek/deepseek-v4-pro:discounted']);
  });

  it('expands a normalized deny-list entry to matching suffixed candidates', async () => {
    await expect(
      collectDeniedAutoRoutingModelIds(
        policy({ organizationModelDenyList: ['deepseek/deepseek-v4-pro'] }),
        {
          candidateModelIds: ['anthropic/claude', 'deepseek/deepseek-v4-pro:discounted'],
        }
      )
    ).resolves.toEqual(['deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-pro:discounted']);
  });

  it('denies a custom-pool-only model excluded by a selected member grant', async () => {
    const decideModel = jest.fn(
      async (_policy: EffectiveOrganizationModelPolicy, modelId: string) => ({
        allowed: modelId === 'anthropic/claude',
      })
    );

    await expect(
      collectDeniedAutoRoutingModelIds(
        policy({
          memberGrant: {
            mode: 'selected',
            modelAllowList: ['anthropic/claude'],
            providerAllowList: [],
          },
        }),
        {
          candidateModelIds: ['pool/only-model', 'anthropic/claude'],
          decideModel,
        }
      )
    ).resolves.toEqual(['pool/only-model']);
    expect(decideModel).toHaveBeenCalledWith(expect.anything(), 'pool/only-model');
    expect(decideModel).not.toHaveBeenCalledWith(expect.anything(), 'google/gemini-2.5-flash');
  });
});

describe('candidateModelIdsFromSources', () => {
  it('uses the custom pool instead of the platform table when a pool is configured', () => {
    expect(
      candidateModelIdsFromSources({
        table: {
          routes: {
            'implementation/code_generation': [{ model: 'google/gemini-2.5-flash' }],
          },
        },
        poolModelIds: ['pool/only-model'],
      })
    ).toEqual(expect.arrayContaining(['pool/only-model', MINIMAX_CURRENT_MODEL_ID]));
    expect(
      candidateModelIdsFromSources({
        table: {
          routes: {
            'implementation/code_generation': [{ model: 'google/gemini-2.5-flash' }],
          },
        },
        poolModelIds: ['pool/only-model'],
      })
    ).not.toContain('google/gemini-2.5-flash');
  });
});

describe('candidateModelIdsFromRoutingTable', () => {
  it('includes routing-table models plus coding-plan default ids', () => {
    expect(
      candidateModelIdsFromRoutingTable({
        routes: {
          'implementation/code_generation': [
            { model: 'google/gemini-2.5-flash' },
            { model: 'kilo-auto/balanced' },
          ],
        },
      })
    ).toEqual(
      expect.arrayContaining([
        'google/gemini-2.5-flash',
        MINIMAX_CURRENT_MODEL_ID,
        'byteplus-coding/bytedance-seed-code',
      ])
    );
    const ids = candidateModelIdsFromRoutingTable({
      routes: {
        'implementation/code_generation': [{ model: 'kilo-auto/balanced' }],
      },
    });
    expect(ids).not.toContain('kilo-auto/balanced');
    expect(ids).not.toContain('qwen/qwen3.7-plus');
  });
});
