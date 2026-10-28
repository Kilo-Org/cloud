import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { getCachedRoutingTable } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-table-cache';
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
  getOrganizationByokProviderIds,
  hasInferenceProviderByokForModel,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import { getDirectByokCatalogModelIds } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import {
  candidateModelIdsFromTable,
  collectDataCollectionRequiredAutoRoutingModelIds,
  collectDeniedAutoRoutingModelIds,
  deniedAutoRoutingCandidates,
  deniedAutoRoutingModelIdsForMember,
  deniedModelIdsForCandidates,
  policyNeedsCandidateEvaluation,
} from './auto-routing-denied-models';

jest.mock('@kilocode/web-shared/lib/ai-gateway/auto-routing-table-cache', () => ({
  getCachedRoutingTable: jest.fn(),
}));
jest.mock(
  '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/models-by-provider-index.server',
  () => ({
    getDataCollectionRequiredModelIds: jest.fn(),
    getProviderSlugsForModel: jest.fn(),
  })
);
jest.mock('@kilocode/web-shared/lib/ai-gateway/byok', () => ({
  ...jest.requireActual<object>('@kilocode/web-shared/lib/ai-gateway/byok'),
  getOrganizationByokProviderIds: jest.fn(async () => []),
  hasInferenceProviderByokForModel: jest.fn(async () => false),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/direct-byok', () => ({
  ...jest.requireActual<object>('@kilocode/web-shared/lib/ai-gateway/providers/direct-byok'),
  getDirectByokCatalogModelIds: jest.fn(async () => new Set()),
}));
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
    await expect(collectDeniedAutoRoutingModelIds(policy(), 'efficient')).resolves.toEqual([]);
    expect(getCachedRoutingTable).not.toHaveBeenCalled();
  });

  it('denies platform routing-table candidates outside the member grant', async () => {
    jest.mocked(getCachedRoutingTable).mockResolvedValue({
      routes: {
        'implementation/code_generation': [
          { model: 'anthropic/claude-sonnet-4.6' },
          { model: 'openai/gpt-5' },
          { model: 'kilo-auto/balanced' },
        ],
      },
    } as never);

    await expect(
      collectDeniedAutoRoutingModelIds(
        policy({
          memberGrant: {
            mode: 'selected',
            includeOrganizationBaseline: false,
            modelAllowList: ['anthropic/claude-sonnet-4.6'],
            providerAllowList: [],
          },
        }),
        'efficient'
      )
    ).resolves.toEqual(['openai/gpt-5']);
  });

  it('ignores the organization deny list for an unrestricted grant without loading candidates', async () => {
    jest.mocked(getCachedRoutingTable).mockClear();
    await expect(
      collectDeniedAutoRoutingModelIds(
        policy({ organizationModelDenyList: ['openai/gpt-4o'] }),
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
      jest
        .mocked(getProviderSlugsForModel)
        .mockImplementation(async modelId =>
          modelId.startsWith('openai/') ? new Set(['openai']) : new Set(['anthropic'])
        );
    });

    it('denies a frontier table model blocked by the provider allowlist and absent from the efficient table', async () => {
      await expect(
        collectDeniedAutoRoutingModelIds(providerCeilingPolicy, 'frontier')
      ).resolves.toEqual(['openai/gpt-5']);
      expect(getCachedRoutingTable).toHaveBeenCalledWith('frontier');
      expect(getCachedRoutingTable).not.toHaveBeenCalledWith('efficient');
    });

    it('uses the efficient platform table instead of the frontier table', async () => {
      await expect(
        collectDeniedAutoRoutingModelIds(providerCeilingPolicy, 'efficient')
      ).resolves.toEqual([]);
      expect(getCachedRoutingTable).toHaveBeenCalledWith('efficient');
    });
  });
});

describe('deniedAutoRoutingCandidates with organization inference provider keys', () => {
  const catalogModelIds: ReadonlySet<string> = new Set(['moonshotai/kimi-k2.6']);

  beforeEach(() => {
    jest.mocked(getOrganizationByokProviderIds).mockClear().mockResolvedValue(['openai']);
    jest.mocked(getDirectByokCatalogModelIds).mockClear().mockResolvedValue(catalogModelIds);
    jest
      .mocked(hasInferenceProviderByokForModel)
      .mockClear()
      .mockImplementation(async modelId => modelId !== 'deepseek/deepseek-v4');
    jest
      .mocked(getProviderSlugsForModel)
      .mockImplementation(async modelId =>
        modelId.startsWith('anthropic/') ? new Set(['anthropic']) : new Set(['other'])
      );
  });

  afterEach(() => {
    jest.mocked(getOrganizationByokProviderIds).mockResolvedValue([]);
    jest.mocked(getDirectByokCatalogModelIds).mockResolvedValue(new Set());
    jest.mocked(hasInferenceProviderByokForModel).mockResolvedValue(false);
  });

  it('admits models outside the provider allow-list that an inference provider key serves', async () => {
    const denied = await deniedAutoRoutingCandidates(
      policy({
        memberGrant: { mode: 'organization_baseline' },
        organizationProviderCeiling: ['anthropic'],
        organizationModelDenyList: ['openai/o3'],
      }),
      ['anthropic/claude', 'openai/gpt-5', 'openai/o3', 'deepseek/deepseek-v4']
    );

    expect(denied.sort()).toEqual(['deepseek/deepseek-v4', 'openai/o3']);
    expect(jest.mocked(getOrganizationByokProviderIds).mock.calls).toEqual([[readDb, 'org-1']]);
    expect(getDirectByokCatalogModelIds).toHaveBeenCalledWith({
      type: 'organization',
      id: 'org-1',
    });
    expect(
      jest
        .mocked(hasInferenceProviderByokForModel)
        .mock.calls.map(([id]) => id)
        .sort()
    ).toEqual(['deepseek/deepseek-v4', 'openai/gpt-5']);
  });

  it('keeps denying models outside the member grant', async () => {
    const denied = await deniedAutoRoutingCandidates(
      policy({
        memberGrant: {
          mode: 'selected',
          includeOrganizationBaseline: false,
          modelAllowList: ['anthropic/claude'],
          providerAllowList: [],
        },
        organizationProviderCeiling: ['anthropic'],
      }),
      ['anthropic/claude', 'openai/gpt-5']
    );

    expect(denied).toEqual(['openai/gpt-5']);
    expect(getOrganizationByokProviderIds).not.toHaveBeenCalled();
  });
});

describe('collectDataCollectionRequiredAutoRoutingModelIds', () => {
  it('returns routing candidates that cannot be served without data collection', async () => {
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

    await expect(collectDataCollectionRequiredAutoRoutingModelIds('efficient')).resolves.toEqual([
      'meta/muse-spark-1.3-contributor',
      'provider/free-model:free',
    ]);
  });

  it('uses frontier candidates for privacy denials rather than the efficient table', async () => {
    jest.mocked(getCachedRoutingTable).mockReset();
    jest.mocked(getCachedRoutingTable).mockImplementation(
      async router =>
        (router === 'frontier'
          ? {
              routes: {
                'implementation/code_generation': [
                  { model: 'frontier/private-model' },
                  { model: 'frontier/ordinary-model' },
                ],
              },
            }
          : {
              routes: { 'implementation/code_generation': [{ model: 'efficient/private-model' }] },
            }) as never
    );
    jest
      .mocked(getDataCollectionRequiredModelIds)
      .mockResolvedValue(new Set(['frontier/private-model', 'efficient/private-model']));

    await expect(collectDataCollectionRequiredAutoRoutingModelIds('frontier')).resolves.toEqual([
      'frontier/private-model',
    ]);
    expect(getCachedRoutingTable).toHaveBeenCalledWith('frontier');
    expect(getCachedRoutingTable).not.toHaveBeenCalledWith('efficient');
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

  it('denies a candidate excluded by a selected member grant', () => {
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
        ['other/model', 'anthropic/claude'],
        modelId => modelId === 'anthropic/claude'
      )
    ).toEqual(['other/model']);
  });
});

describe('candidateModelIdsFromTable', () => {
  it('includes each concrete routing-table model once', () => {
    expect(
      candidateModelIdsFromTable({
        routes: {
          'implementation/code_generation': [
            { model: 'google/gemini-2.5-flash' },
            { model: 'kilo-auto/balanced' },
          ],
          'implementation/debugging': [{ model: 'google/gemini-2.5-flash' }],
        },
      })
    ).toEqual(['google/gemini-2.5-flash']);
  });

  it('returns no candidates without a routing table', () => {
    expect(candidateModelIdsFromTable(null)).toEqual([]);
  });
});
