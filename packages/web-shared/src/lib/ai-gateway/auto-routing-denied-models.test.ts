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
} from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';
import {
  getOrganizationByokProviderIds,
  getStoredByokKeys,
  hasInferenceProviderUserByokForModel,
  type StoredByokKeys,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import { getEffectiveProviderPrivacy } from '@kilocode/web-shared/lib/ai-gateway/provider-privacy';
import { isNonTrialEnterpriseOrganization } from '@kilocode/web-shared/lib/organizations/non-trial-enterprise';
import { getDirectByokCatalogModelIds } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import { inferenceRegionIneligibleCandidates } from '@kilocode/web-shared/lib/ai-gateway/inference-region-candidates';
import { getRuntimeOrganizationFeatures } from '@kilocode/web-shared/lib/ai-gateway/organization-features';
import { DEFAULT_ORGANIZATION_FEATURES } from '@kilocode/web-shared/lib/ai-gateway/gateway-config';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import {
  customLlmDefinition,
  deleteCustomLlmForTest,
  insertCustomLlmForTest,
} from '@kilocode/web-shared/tests/helpers/custom-llm.helper';
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
  getStoredByokKeys: jest.fn(),
  hasInferenceProviderUserByokForModel: jest.fn(async () => false),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/direct-byok', () => ({
  ...jest.requireActual<object>('@kilocode/web-shared/lib/ai-gateway/providers/direct-byok'),
  getDirectByokCatalogModelIds: jest.fn(async () => new Set()),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/inference-region-candidates', () => ({
  inferenceRegionIneligibleCandidates: jest.fn(async () => []),
}));
jest.mock('@kilocode/web-shared/lib/organizations/non-trial-enterprise', () => ({
  isNonTrialEnterpriseOrganization: jest.fn(async () => false),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/organization-features', () => ({
  ...jest.requireActual<object>('@kilocode/web-shared/lib/ai-gateway/organization-features'),
  getRuntimeOrganizationFeatures: jest.fn(),
}));
jest.mock(
  '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server',
  () => ({
    ...jest.requireActual<object>(
      '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server'
    ),
    resolveOrganizationMemberModelPolicy: jest.fn(),
  })
);

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
            modelAllowList: new Set(['anthropic/claude']),
            providerAllowList: new Set<string>(),
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
            modelAllowList: new Set(['anthropic/claude-sonnet-4.6']),
            providerAllowList: new Set<string>(),
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
  // Catalog-mode keys serving Kimi through Moonshot AI and GLM through Z.AI.
  const catalogServingProviders = [
    ['moonshotai/kimi-k2.6', 'moonshotai'],
    ['z-ai/glm-5.2', 'z-ai'],
  ] as const;

  beforeEach(() => {
    jest.mocked(getOrganizationByokProviderIds).mockClear().mockResolvedValue(['openai']);
    jest
      .mocked(getDirectByokCatalogModelIds)
      .mockClear()
      .mockImplementation(async (_owner, isServingAllowed) => {
        const served = new Set<string>();
        for (const [modelId, providerId] of catalogServingProviders) {
          if (await isServingAllowed?.(modelId, providerId)) served.add(modelId);
        }
        return served;
      });
    jest
      .mocked(hasInferenceProviderUserByokForModel)
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
    jest.mocked(getDirectByokCatalogModelIds).mockReset().mockResolvedValue(new Set());
    jest.mocked(hasInferenceProviderUserByokForModel).mockResolvedValue(false);
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
    expect(getDirectByokCatalogModelIds).toHaveBeenCalledWith(
      { type: 'organization', id: 'org-1' },
      expect.any(Function)
    );
    expect(
      jest
        .mocked(hasInferenceProviderUserByokForModel)
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
          modelAllowList: new Set(['anthropic/claude']),
          providerAllowList: new Set<string>(),
        },
        organizationProviderCeiling: ['anthropic'],
      }),
      ['anthropic/claude', 'openai/gpt-5']
    );

    expect(denied).toEqual(['openai/gpt-5']);
    expect(getOrganizationByokProviderIds).not.toHaveBeenCalled();
  });

  it('admits a catalog model only when the provider allow-list names its key provider', async () => {
    jest.mocked(hasInferenceProviderUserByokForModel).mockResolvedValue(false);

    const denied = await deniedAutoRoutingCandidates(
      policy({
        memberGrant: { mode: 'organization_baseline' },
        organizationProviderCeiling: ['anthropic', 'z-ai'],
      }),
      ['moonshotai/kimi-k2.6', 'z-ai/glm-5.2']
    );

    expect(denied).toEqual(['moonshotai/kimi-k2.6']);
  });

  it('admits a catalog model whose key provider a selected grant names', async () => {
    const denied = await deniedAutoRoutingCandidates(
      policy({
        memberGrant: {
          mode: 'selected',
          includeOrganizationBaseline: false,
          modelAllowList: new Set<string>(),
          providerAllowList: new Set(['z-ai']),
        },
      }),
      ['moonshotai/kimi-k2.6', 'z-ai/glm-5.2']
    );

    expect(denied).toEqual(['moonshotai/kimi-k2.6']);
    expect(hasInferenceProviderUserByokForModel).not.toHaveBeenCalled();
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

  it('also denies custom LLMs that do not train on prompts under zero data retention', async () => {
    const customModel = 'acme/zdr-custom-model';
    await insertCustomLlmForTest(
      customModel,
      customLlmDefinition({
        pricing: [
          {
            start_context_length: 0,
            pricing: {
              prompt_per_million: 1,
              completion_per_million: 2,
              input_cache_read_per_million: null,
              input_cache_write_per_million: null,
            },
          },
        ],
        may_train_on_prompts: false,
      })
    );
    try {
      jest.mocked(getCachedRoutingTable).mockResolvedValue({
        routes: {
          'implementation/code_generation': [{ model: customModel }, { model: 'openai/gpt-4o' }],
        },
      } as never);
      jest.mocked(getDataCollectionRequiredModelIds).mockResolvedValue(new Set());

      await expect(collectDataCollectionRequiredAutoRoutingModelIds('efficient')).resolves.toEqual(
        []
      );
      await expect(
        collectDataCollectionRequiredAutoRoutingModelIds('efficient', { zdr: true })
      ).resolves.toEqual([customModel]);
    } finally {
      await deleteCustomLlmForTest(customModel);
    }
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
          modelAllowList: new Set(['anthropic/claude-sonnet-4.6']),
          providerAllowList: new Set<string>(),
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

describe('deniedAutoRoutingModelIdsForMember with an inference region', () => {
  const regionDenied = ['openai/gpt-5'];
  const modelIds = ['anthropic/claude', 'openai/gpt-5', 'kilo-auto/frontier'];

  async function setUp({
    settings,
    teams = false,
    featureEnabled = true,
  }: {
    settings: object;
    teams?: boolean;
    featureEnabled?: boolean;
  }) {
    const user = await insertTestUser();
    const organization = await createTestOrganization(
      `inference-region-${user.id}`,
      user.id,
      0,
      settings,
      teams
    );
    jest.mocked(getRuntimeOrganizationFeatures).mockResolvedValue({
      ...DEFAULT_ORGANIZATION_FEATURES,
      gateway_settings: featureEnabled ? [organization.id] : [],
    });
    return { userId: user.id, organizationId: organization.id };
  }

  beforeEach(() => {
    jest.mocked(resolveOrganizationMemberModelPolicy).mockResolvedValue(policy());
    jest.mocked(getStoredByokKeys).mockReset();
    jest.mocked(isNonTrialEnterpriseOrganization).mockClear();
    jest.mocked(inferenceRegionIneligibleCandidates).mockReset();
    jest
      .mocked(inferenceRegionIneligibleCandidates)
      .mockImplementation(async (_routing, candidateIds) =>
        candidateIds.filter(id => regionDenied.includes(id))
      );
  });

  function lastRouting() {
    const routing = jest.mocked(inferenceRegionIneligibleCandidates).mock.lastCall?.[0];
    if (!routing) throw new Error('the region check did not run');
    return routing;
  }

  it('denies candidates outside the region of an enterprise organization with the feature', async () => {
    const member = await setUp({ settings: { data_region: 'eu' } });
    const memberPolicy = policy({ policyRevision: 7 });
    jest.mocked(resolveOrganizationMemberModelPolicy).mockResolvedValue(memberPolicy);

    await expect(deniedAutoRoutingModelIdsForMember({ ...member, modelIds })).resolves.toEqual(
      regionDenied
    );
    expect(inferenceRegionIneligibleCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'eu' }),
      ['anthropic/claude', 'openai/gpt-5']
    );
    expect(lastRouting().policy).toBe(memberPolicy);
    expect(lastRouting().caller).toEqual({
      userId: member.userId,
      organizationId: member.organizationId,
    });
  });

  it('routes the candidates under the member’s policy and the organization’s settings, with no request', async () => {
    const settings = { data_region: 'eu', data_collection: 'deny' } as const;
    const member = await setUp({ settings });
    jest
      .mocked(resolveOrganizationMemberModelPolicy)
      .mockResolvedValue(policy({ dataCollection: 'deny' }));

    await deniedAutoRoutingModelIdsForMember({ ...member, modelIds });

    expect(lastRouting()).toMatchObject({
      region: 'eu',
      // The CLI names its candidates before the request exists.
      apiKind: null,
      requestProvider: undefined,
      settings,
      effectivePrivacy: getEffectiveProviderPrivacy(undefined, 'deny'),
    });
  });

  it('reads the member’s organization keys once, and only when the region check asks', async () => {
    const member = await setUp({ settings: { data_region: 'eu' } });
    const stored = { keys: [], decrypt: jest.fn() } as unknown as StoredByokKeys;
    jest
      .mocked(getStoredByokKeys as unknown as () => Promise<StoredByokKeys>)
      .mockResolvedValue(stored);

    await deniedAutoRoutingModelIdsForMember({ ...member, modelIds });
    const { loadStoredByokKeys } = lastRouting();

    expect(getStoredByokKeys).not.toHaveBeenCalled();
    expect(await loadStoredByokKeys?.()).toBe(stored);
    expect(await loadStoredByokKeys?.()).toBe(stored);
    expect(jest.mocked(getStoredByokKeys).mock.calls).toEqual([
      [readDb, { type: 'organization', id: member.organizationId }],
    ]);
  });

  it('checks the non-trial enterprise status once, only when the region check asks', async () => {
    const member = await setUp({ settings: { data_region: 'eu' } });
    jest.mocked(isNonTrialEnterpriseOrganization).mockResolvedValue(true);

    await deniedAutoRoutingModelIdsForMember({ ...member, modelIds });
    const { isNonTrialEnterprise } = lastRouting();

    expect(isNonTrialEnterpriseOrganization).not.toHaveBeenCalled();
    await expect(isNonTrialEnterprise()).resolves.toBe(true);
    await expect(isNonTrialEnterprise()).resolves.toBe(true);
    expect(jest.mocked(isNonTrialEnterpriseOrganization).mock.calls).toEqual([
      [member.organizationId, readDb],
    ]);
  });

  it('does not region-deny a latest alias, whose pin is in the region and live target is not', async () => {
    const member = await setUp({ settings: { data_region: 'eu' } });
    jest
      .mocked(inferenceRegionIneligibleCandidates)
      .mockImplementation(async (_routing, candidateIds) =>
        candidateIds.filter(id => id !== 'vendor/pin')
      );

    await expect(
      deniedAutoRoutingModelIdsForMember({
        ...member,
        modelIds: ['~vendor/latest', 'vendor/pin', 'vendor/live'],
      })
    ).resolves.toEqual(['vendor/live']);
    expect(inferenceRegionIneligibleCandidates).toHaveBeenCalledWith(expect.anything(), [
      'vendor/pin',
      'vendor/live',
    ]);
  });

  it('merges region denials with the group policy denials without duplicates', async () => {
    const member = await setUp({ settings: { data_region: 'eu' } });
    jest.mocked(resolveOrganizationMemberModelPolicy).mockResolvedValue(
      policy({
        memberGrant: {
          mode: 'selected',
          includeOrganizationBaseline: false,
          modelAllowList: new Set(['anthropic/claude']),
          providerAllowList: new Set<string>(),
        },
      })
    );

    await expect(deniedAutoRoutingModelIdsForMember({ ...member, modelIds })).resolves.toEqual(
      regionDenied
    );
  });

  it.each([
    ['the organization has no data region', { settings: {} }],
    [
      'the gateway settings feature is off',
      { settings: { data_region: 'eu' }, featureEnabled: false },
    ],
    [
      'the organization is not on the enterprise plan',
      { settings: { data_region: 'eu' }, teams: true },
    ],
  ])('adds no region denial when %s', async (_name, options) => {
    const member = await setUp(options);

    await expect(deniedAutoRoutingModelIdsForMember({ ...member, modelIds })).resolves.toEqual([]);
    expect(inferenceRegionIneligibleCandidates).not.toHaveBeenCalled();
  });

  it('adds no region denial for an unknown organization', async () => {
    await expect(
      deniedAutoRoutingModelIdsForMember({
        userId: 'user-1',
        organizationId: '33333333-3333-4333-8333-333333333333',
        modelIds,
      })
    ).resolves.toEqual([]);
    expect(inferenceRegionIneligibleCandidates).not.toHaveBeenCalled();
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
            modelAllowList: new Set(['anthropic/claude']),
            providerAllowList: new Set<string>(),
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
