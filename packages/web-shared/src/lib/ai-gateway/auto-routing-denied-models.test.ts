import { describe, expect, it } from '@jest/globals';
import { getCachedRoutingTable } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-table-cache';
import { getDataCollectionRequiredModelIds } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/models-by-provider-index.server';
import {
  resolveOrganizationMemberModelPolicy,
  type EffectiveOrganizationModelPolicy,
} from '@kilocode/web-shared/lib/organizations/effective-model-access.server';
import {
  candidateModelIdsFromTable,
  collectDataCollectionRequiredAutoRoutingModelIds,
  collectDeniedAutoRoutingModelIds,
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
    await expect(collectDeniedAutoRoutingModelIds(policy())).resolves.toEqual([]);
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
        })
      )
    ).resolves.toEqual(['openai/gpt-5']);
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

    await expect(collectDataCollectionRequiredAutoRoutingModelIds()).resolves.toEqual([
      'meta/muse-spark-1.3-contributor',
      'provider/free-model:free',
    ]);
  });
});

describe('deniedAutoRoutingModelIdsForMember', () => {
  const member = { userId: 'user-1', organizationId: '22222222-2222-4222-8222-222222222222' };

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
    expect(resolveOrganizationMemberModelPolicy).toHaveBeenCalledWith({
      organizationId: member.organizationId,
      kiloUserId: member.userId,
    });
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
