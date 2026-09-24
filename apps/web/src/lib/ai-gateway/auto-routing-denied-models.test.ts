import { beforeEach, describe, expect, it } from '@jest/globals';
import type { EffectiveOrganizationModelPolicy } from '@/lib/organizations/effective-model-access.server';
import { MINIMAX_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/minimax';
import { PRIMARY_DEFAULT_MODEL } from '@/lib/ai-gateway/models';
import { getAutoRoutingSettings } from '@/lib/ai-gateway/auto-routing-admin-client';
import { getCachedRoutingTable } from '@/lib/ai-gateway/auto-routing-table-cache';
import { hasBestEffortGuessDataCollectionRequirement } from '@/lib/ai-gateway/is-free-model';
import { getModelDataPolicies } from '@/lib/ai-gateway/providers/openrouter/model-data-policy.server';
import { getEffectiveModelDecision } from '@/lib/organizations/effective-model-access.server';
import {
  candidateModelIdsFromSources,
  collectDeniedAutoRoutingModelIds,
  deniedModelIdsForCandidates,
  policyNeedsCandidateEvaluation,
} from './auto-routing-denied-models';

jest.mock('@/lib/ai-gateway/auto-routing-admin-client');
jest.mock('@/lib/ai-gateway/auto-routing-table-cache');
jest.mock('@/lib/ai-gateway/is-free-model');
jest.mock('@/lib/ai-gateway/providers/openrouter/model-data-policy.server');
jest.mock('@/lib/organizations/effective-model-access.server');

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

const owner = { userId: 'user-1', organizationId: 'org-1' };

describe('policyNeedsCandidateEvaluation', () => {
  it('is false for an unrestricted policy with an inactive baseline deny list', () => {
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
            includeOrganizationBaseline: false,
            modelAllowList: ['anthropic/claude'],
            providerAllowList: [],
          },
        })
      )
    ).toBe(true);
  });

  it('is true for an organization baseline grant', () => {
    expect(
      policyNeedsCandidateEvaluation(policy({ memberGrant: { mode: 'organization_baseline' } }))
    ).toBe(true);
  });

  it('is true when the current snapshot is required', () => {
    expect(policyNeedsCandidateEvaluation(policy({ requireModelInCurrentSnapshot: true }))).toBe(
      true
    );
  });
});

describe('collectDeniedAutoRoutingModelIds', () => {
  const contributor = 'meta/muse-spark-1.3-contributor';
  const standard = 'meta/muse-spark-1.3';

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(getCachedRoutingTable).mockResolvedValue(null);
    jest.mocked(getAutoRoutingSettings).mockResolvedValue({
      status: 200,
      body: { configuredPool: [{ model: contributor }, { model: standard }] },
    } as Awaited<ReturnType<typeof getAutoRoutingSettings>>);
    jest.mocked(hasBestEffortGuessDataCollectionRequirement).mockResolvedValue(false);
    jest.mocked(getEffectiveModelDecision).mockResolvedValue({ allowed: true });
    jest.mocked(getModelDataPolicies).mockResolvedValue(
      new Map([
        [contributor, [{ providerSlug: 'meta', training: true, retainsPrompts: true }]],
        [standard, [{ providerSlug: 'meta', training: false, retainsPrompts: true }]],
      ])
    );
  });

  it('returns no denials without loading when the policy cannot deny anything', async () => {
    await expect(collectDeniedAutoRoutingModelIds(policy(), owner)).resolves.toEqual([]);
    expect(getModelDataPolicies).not.toHaveBeenCalled();
    expect(getAutoRoutingSettings).not.toHaveBeenCalled();
  });

  it('excludes paid training models for personal data-collection deny requests', async () => {
    await expect(
      collectDeniedAutoRoutingModelIds(null, owner, { data_collection: 'deny' })
    ).resolves.toEqual([contributor]);
  });

  it('enforces organization privacy even with unrestricted model access and a client allow', async () => {
    await expect(
      collectDeniedAutoRoutingModelIds(policy({ dataCollection: 'deny' }), owner, {
        data_collection: 'allow',
      })
    ).resolves.toEqual([contributor]);
  });

  it('excludes retained-only models for ZDR but not for training denial', async () => {
    await expect(collectDeniedAutoRoutingModelIds(null, owner, { zdr: true })).resolves.toEqual([
      contributor,
      standard,
    ]);
  });

  it('keeps mixed-policy models when a nontraining route is eligible', async () => {
    jest.mocked(getModelDataPolicies).mockResolvedValue(
      new Map([
        [
          contributor,
          [
            { providerSlug: 'meta', training: true, retainsPrompts: true },
            { providerSlug: 'safe', training: false, retainsPrompts: false },
          ],
        ],
      ])
    );
    await expect(
      collectDeniedAutoRoutingModelIds(null, owner, { data_collection: 'deny' })
    ).resolves.toEqual([]);
    await expect(
      collectDeniedAutoRoutingModelIds(null, owner, { data_collection: 'deny', only: ['meta'] })
    ).resolves.toEqual([contributor]);
    await expect(
      collectDeniedAutoRoutingModelIds(null, owner, { data_collection: 'deny', ignore: ['safe'] })
    ).resolves.toEqual([contributor]);
    jest.mocked(getEffectiveModelDecision).mockResolvedValue({
      allowed: true,
      eligibleProviderRoutes: new Set(['meta']),
    });
    await expect(
      collectDeniedAutoRoutingModelIds(
        policy({ memberGrant: { mode: 'organization_baseline' }, dataCollection: 'deny' }),
        owner
      )
    ).resolves.toEqual([contributor]);
  });

  it('retains known free and exclusive collection requirements when metadata is missing', async () => {
    jest.mocked(getModelDataPolicies).mockResolvedValue(new Map());
    jest
      .mocked(hasBestEffortGuessDataCollectionRequirement)
      .mockImplementation(async id => id === contributor || id === PRIMARY_DEFAULT_MODEL);
    await expect(
      collectDeniedAutoRoutingModelIds(null, owner, { data_collection: 'deny' })
    ).resolves.toEqual([contributor, PRIMARY_DEFAULT_MODEL]);
  });

  it('combines access-policy and privacy denials', async () => {
    jest.mocked(getEffectiveModelDecision).mockImplementation(async (_policy, id) => ({
      allowed: id !== standard,
    }));
    await expect(
      collectDeniedAutoRoutingModelIds(
        policy({ memberGrant: { mode: 'organization_baseline' }, dataCollection: 'deny' }),
        owner
      )
    ).resolves.toEqual([contributor, standard]);
  });

  it('bounds a stalled candidate lookup', async () => {
    jest.useFakeTimers();
    try {
      jest.mocked(getAutoRoutingSettings).mockReturnValue(new Promise(() => {}));
      const result = expect(
        collectDeniedAutoRoutingModelIds(null, owner, { data_collection: 'deny' })
      ).rejects.toThrow('Auto routing candidate lookup timed out');
      await jest.advanceTimersByTimeAsync(5000);
      await result;
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('deniedModelIdsForCandidates', () => {
  it('does not apply the organization deny list to an unrestricted grant', () => {
    expect(
      deniedModelIdsForCandidates(
        policy({ organizationModelDenyList: ['openai/gpt-4o:free'] }),
        ['anthropic/claude'],
        () => true
      )
    ).toEqual([]);
  });

  it('adds models that fail the effective access policy', () => {
    expect(
      deniedModelIdsForCandidates(
        policy({
          organizationProviderCeiling: ['anthropic'],
          organizationModelDenyList: ['openai/o3'],
          memberGrant: { mode: 'organization_baseline' },
        }),
        ['anthropic/claude', 'google/gemini-2.5-flash', 'kilo-auto/efficient'],
        modelId => modelId !== 'google/gemini-2.5-flash'
      )
    ).toEqual(['openai/o3', 'google/gemini-2.5-flash']);
  });

  it('keeps the exact denied candidate id, including suffixes', () => {
    expect(
      deniedModelIdsForCandidates(
        policy({ organizationProviderCeiling: ['example'] }),
        ['example/model', 'example/model:suffix'],
        modelId => modelId !== 'example/model:suffix'
      )
    ).toEqual(['example/model:suffix']);
  });

  it('expands a normalized deny-list entry to matching suffixed candidates', () => {
    expect(
      deniedModelIdsForCandidates(
        policy({
          organizationModelDenyList: ['example/model'],
          memberGrant: { mode: 'organization_baseline' },
        }),
        ['anthropic/claude', 'example/model:suffix'],
        () => true
      )
    ).toEqual(['example/model', 'example/model:suffix']);
  });

  it('denies a custom-pool-only model excluded by a selected member grant', () => {
    expect(
      deniedModelIdsForCandidates(
        policy({
          memberGrant: {
            mode: 'selected',
            includeOrganizationBaseline: false,
            modelAllowList: ['anthropic/claude'],
            providerAllowList: [],
          },
        }),
        ['pool/only-model', 'anthropic/claude'],
        modelId => modelId === 'anthropic/claude'
      )
    ).toEqual(['pool/only-model']);
  });
});

describe('candidateModelIdsFromSources', () => {
  it('uses the custom pool instead of the platform table when a pool is configured', () => {
    const ids = candidateModelIdsFromSources(
      {
        routes: {
          'implementation/code_generation': [{ model: 'google/gemini-2.5-flash' }],
        },
      },
      ['pool/only-model']
    );
    expect(ids).toEqual(expect.arrayContaining(['pool/only-model', MINIMAX_CURRENT_MODEL_ID]));
    expect(ids).not.toContain('google/gemini-2.5-flash');
  });

  it('includes routing-table models plus coding-plan default ids', () => {
    expect(
      candidateModelIdsFromSources(
        {
          routes: {
            'implementation/code_generation': [
              { model: 'google/gemini-2.5-flash' },
              { model: 'kilo-auto/balanced' },
            ],
          },
        },
        null
      )
    ).toEqual(
      expect.arrayContaining([
        'google/gemini-2.5-flash',
        MINIMAX_CURRENT_MODEL_ID,
        'byteplus-coding/bytedance-seed-code',
      ])
    );
    const ids = candidateModelIdsFromSources(
      {
        routes: {
          'implementation/code_generation': [{ model: 'kilo-auto/balanced' }],
        },
      },
      null
    );
    expect(ids).not.toContain('kilo-auto/balanced');
    expect(ids).not.toContain('moonshotai/kimi-k3');
  });
});
