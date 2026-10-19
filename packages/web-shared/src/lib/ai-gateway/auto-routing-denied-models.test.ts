import { beforeEach, describe, expect, it } from '@jest/globals';
import { getAutoRoutingSettings } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-admin-client';
import { getCachedRoutingTable } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-table-cache';
import { findEffectiveLegacyPoolRouter } from '@kilocode/web-shared/lib/ai-gateway/custom-routers';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import {
  getDataCollectionRequiredModelIds,
  getProviderSlugsForModel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/models-by-provider-index.server';
import {
  resolveOrganizationMemberModelPolicy,
  type EffectiveOrganizationModelPolicy,
} from '@kilocode/web-shared/lib/organizations/effective-model-access.server';
import {
  candidateModelIdsFromSources,
  collectDataCollectionRequiredAutoRoutingModelIds,
  collectDeniedAutoRoutingModelIds,
  deniedAutoRoutingModelIdsForMember,
  deniedModelIdsForCandidates,
  policyNeedsCandidateEvaluation,
  loadEffectivePoolModelIds,
} from './auto-routing-denied-models';

jest.mock('@kilocode/web-shared/lib/ai-gateway/auto-routing-admin-client', () => ({
  getAutoRoutingSettings: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/auto-routing-table-cache', () => ({
  getCachedRoutingTable: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/custom-routers', () => ({
  findEffectiveLegacyPoolRouter: jest.fn().mockResolvedValue(null),
}));
jest.mock(
  '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/models-by-provider-index.server',
  () => ({
    getDataCollectionRequiredModelIds: jest.fn(),
    getProviderSlugsForModel: jest.fn(),
  })
);
jest.mock('@kilocode/web-shared/lib/organizations/effective-model-access.server', () => ({
  ...jest.requireActual<object>(
    '@kilocode/web-shared/lib/organizations/effective-model-access.server'
  ),
  resolveOrganizationMemberModelPolicy: jest.fn(),
}));

function policy(
  overrides: Partial<EffectiveOrganizationModelPolicy> = {}
): EffectiveOrganizationModelPolicy {
  return {
    requireModelInCurrentSnapshot: false,
    organizationModelDenyList: [],
    memberGrant: { mode: 'unrestricted' },
    policyRevision: 1,
    customLlmGrantee: { organizationId: 'org-1', groupIds: [] },
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
  it('returns no denials without loading when the policy cannot deny anything', async () => {
    await expect(collectDeniedAutoRoutingModelIds(policy(), owner, 'efficient')).resolves.toEqual(
      []
    );
  });

  it('ignores the organization deny list for an unrestricted grant without loading candidates', async () => {
    jest.mocked(getCachedRoutingTable).mockClear();
    await expect(
      collectDeniedAutoRoutingModelIds(
        policy({ organizationModelDenyList: ['openai/gpt-4o'] }),
        owner,
        'efficient'
      )
    ).resolves.toEqual([]);
    expect(getCachedRoutingTable).not.toHaveBeenCalled();
  });

  describe('with an organization provider allowlist', () => {
    const providerCeilingPolicy = policy({
      memberGrant: { mode: 'organization_baseline' },
      organizationProviderCeiling: ['anthropic'],
    });

    beforeEach(() => {
      jest.mocked(getCachedRoutingTable).mockReset();
      jest.mocked(getCachedRoutingTable).mockImplementation(
        async router =>
          (router === 'frontier'
            ? { routes: { 'implementation/code_generation': [{ model: 'openai/gpt-5' }] } }
            : {
                routes: { 'implementation/code_generation': [{ model: 'anthropic/claude' }] },
              }) as never
      );
      jest.mocked(getAutoRoutingSettings).mockReset();
      jest.mocked(getAutoRoutingSettings).mockResolvedValue({
        status: 200,
        body: { configuredPool: [{ model: 'anthropic/claude' }] },
      } as never);
      jest
        .mocked(getProviderSlugsForModel)
        .mockImplementation(async modelId =>
          modelId.startsWith('openai/') ? new Set(['openai']) : new Set(['anthropic'])
        );
    });

    it('denies a frontier table model blocked by the provider allowlist and absent from the efficient table', async () => {
      await expect(
        collectDeniedAutoRoutingModelIds(providerCeilingPolicy, owner, 'frontier')
      ).resolves.toEqual(['openai/gpt-5']);
      expect(getCachedRoutingTable).toHaveBeenCalledWith('frontier');
      expect(getCachedRoutingTable).not.toHaveBeenCalledWith('efficient');
    });

    it('ignores the efficient custom pool for frontier', async () => {
      await expect(
        collectDeniedAutoRoutingModelIds(providerCeilingPolicy, owner, 'frontier')
      ).resolves.toEqual(['openai/gpt-5']);
      expect(getAutoRoutingSettings).not.toHaveBeenCalled();
    });

    it('uses the custom pool for efficient instead of the frontier table', async () => {
      await expect(
        collectDeniedAutoRoutingModelIds(providerCeilingPolicy, owner, 'efficient')
      ).resolves.toEqual([]);
      expect(getAutoRoutingSettings).toHaveBeenCalled();
      expect(getCachedRoutingTable).toHaveBeenCalledWith('efficient');
    });
  });
});

describe('migrated pool candidates', () => {
  it('uses the canonical edited gateway entries rather than the legacy snapshot', async () => {
    jest.mocked(findEffectiveLegacyPoolRouter).mockResolvedValueOnce({
      id: '00000000-0000-4000-8000-000000000001',
      ownerType: 'user',
      ownerId: owner.userId,
      slug: 'efficient',
      name: 'Efficient',
      baseRouter: 'efficient',
      mode: 'best_accuracy',
      entries: [{ kind: 'gateway', model: 'openai/edited-model' }],
      defaultEntryKey: 'gateway:openai/edited-model',
      legacyPool: true,
    });
    jest.mocked(getAutoRoutingSettings).mockClear();

    await expect(loadEffectivePoolModelIds(owner)).resolves.toEqual(['openai/edited-model']);
    expect(getAutoRoutingSettings).not.toHaveBeenCalled();
  });

  it('propagates a canonical lookup failure instead of using a stale snapshot', async () => {
    jest
      .mocked(findEffectiveLegacyPoolRouter)
      .mockRejectedValueOnce(new Error('database unavailable'));

    await expect(loadEffectivePoolModelIds(owner)).rejects.toThrow('database unavailable');
  });
});

describe('collectDataCollectionRequiredAutoRoutingModelIds', () => {
  it('returns routing candidates that cannot be served without data collection', async () => {
    jest.mocked(getAutoRoutingSettings).mockResolvedValue({ status: 404, body: {} } as never);
    jest.mocked(getCachedRoutingTable).mockResolvedValue({
      routes: {
        'implementation/code_generation': [
          { model: 'meta/muse-spark-1.3-contributor' },
          { model: 'meta/muse-spark-1.3' },
          { model: 'provider/free-model:free' },
          { model: 'kilo-auto/balanced' },
        ],
      },
    } as never);
    jest
      .mocked(getDataCollectionRequiredModelIds)
      .mockResolvedValue(new Set(['meta/muse-spark-1.3-contributor', 'unrelated/model']));

    await expect(
      collectDataCollectionRequiredAutoRoutingModelIds(owner, 'efficient')
    ).resolves.toEqual(['meta/muse-spark-1.3-contributor', 'provider/free-model:free']);
  });
});

describe('deniedAutoRoutingModelIdsForMember', () => {
  const member = { userId: 'user-1', organizationId: '22222222-2222-4222-8222-222222222222' };

  it('applies the organization deny list to a baseline grant', async () => {
    jest.mocked(resolveOrganizationMemberModelPolicy).mockResolvedValue(
      policy({
        memberGrant: { mode: 'organization_baseline' },
        organizationModelDenyList: ['openai/gpt-4o'],
      })
    );
    await expect(
      deniedAutoRoutingModelIdsForMember({
        ...member,
        modelIds: ['openai/gpt-4o:free', 'anthropic/claude'],
      })
    ).resolves.toEqual(['openai/gpt-4o', 'openai/gpt-4o:free']);
  });

  it('denies candidates outside the member group policy grant', async () => {
    jest.mocked(resolveOrganizationMemberModelPolicy).mockResolvedValue(
      policy({
        memberGrant: {
          mode: 'selected',
          includeOrganizationBaseline: false,
          modelAllowList: ['anthropic/claude-sonnet-4.6'],
          providerAllowList: [],
        },
      })
    );
    await expect(
      deniedAutoRoutingModelIdsForMember({
        ...member,
        modelIds: ['anthropic/claude-sonnet-4.6', 'openai/gpt-5', 'kilo-auto/frontier'],
      })
    ).resolves.toEqual(['openai/gpt-5']);
    const { fromDb, ...policyParams } =
      jest.mocked(resolveOrganizationMemberModelPolicy).mock.lastCall?.[0] ?? {};
    expect(policyParams).toEqual({
      organizationId: member.organizationId,
      kiloUserId: member.userId,
    });
    expect(fromDb).toBe(readDb);
  });

  it('denies data-collection-required candidates when the organization denies data collection', async () => {
    jest
      .mocked(resolveOrganizationMemberModelPolicy)
      .mockResolvedValue(policy({ dataCollection: 'deny' }));
    jest
      .mocked(getDataCollectionRequiredModelIds)
      .mockResolvedValue(new Set(['meta/muse-spark-1.3-contributor']));
    await expect(
      deniedAutoRoutingModelIdsForMember({
        ...member,
        modelIds: [
          'meta/muse-spark-1.3-contributor',
          'provider/free-model:free',
          'anthropic/claude',
        ],
      })
    ).resolves.toEqual(['meta/muse-spark-1.3-contributor', 'provider/free-model:free']);
  });

  it('keeps data-collection-required candidates when the organization allows data collection', async () => {
    jest
      .mocked(resolveOrganizationMemberModelPolicy)
      .mockResolvedValue(policy({ dataCollection: 'allow' }));
    jest.mocked(getDataCollectionRequiredModelIds).mockClear();
    await expect(
      deniedAutoRoutingModelIdsForMember({
        ...member,
        modelIds: ['meta/muse-spark-1.3-contributor', 'provider/free-model:free'],
      })
    ).resolves.toEqual([]);
    expect(getDataCollectionRequiredModelIds).not.toHaveBeenCalled();
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
    expect(ids).toEqual(['pool/only-model']);
    expect(ids).not.toContain('google/gemini-2.5-flash');
  });

  it('includes only concrete routing-table models when no pool is configured', () => {
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
    ).toEqual(['google/gemini-2.5-flash']);
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
