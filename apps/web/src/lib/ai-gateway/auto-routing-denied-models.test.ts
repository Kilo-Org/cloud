import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

jest.mock('@/lib/ai-gateway/auto-routing-admin-client', () => ({
  getAutoRoutingSettings: jest.fn(),
}));

jest.mock('@/lib/ai-gateway/auto-routing-table-cache', () => ({
  getCachedRoutingTable: jest.fn(),
}));

import type {
  AutoRoutingModeOwnerQuery,
  AutoRoutingModeResponse,
  AutoRoutingSettingsResponse,
  PoolEntry,
  RoutingTable,
} from '@kilocode/auto-routing-contracts';
import type { EffectiveOrganizationModelPolicy } from '@/lib/organizations/effective-model-access.server';
import { MINIMAX_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/minimax';
import {
  getAutoRoutingSettings,
  type AutoRoutingSettingsWorkerResult,
} from '@/lib/ai-gateway/auto-routing-admin-client';
import { getCachedRoutingTable } from '@/lib/ai-gateway/auto-routing-table-cache';
import {
  candidateModelIdsFromSources,
  collectDeniedAutoRoutingModelIds,
  deniedModelIdsForCandidates,
  loadAutoRoutingCandidateModelIds,
  loadEffectiveAutoRoutingPool,
  policyNeedsCandidateEvaluation,
} from './auto-routing-denied-models';

const mockGetAutoRoutingSettings =
  jest.mocked<
    (
      owner: AutoRoutingModeOwnerQuery,
      signal?: AbortSignal
    ) => Promise<
      AutoRoutingSettingsWorkerResult | { status: number; body: AutoRoutingModeResponse }
    >
  >(getAutoRoutingSettings);
const mockGetCachedRoutingTable = jest.mocked(getCachedRoutingTable);

function settingsResult(
  settingsOwner: AutoRoutingModeOwnerQuery,
  configuredPool: PoolEntry[] | null
): { status: number; body: AutoRoutingSettingsResponse } {
  return {
    status: 200,
    body: {
      ...settingsOwner,
      mode: 'cost_per_accuracy',
      configuredMode: null,
      defaultMode: 'cost_per_accuracy',
      configuredPool,
      poolStatuses: [],
    },
  };
}

beforeEach(() => {
  mockGetAutoRoutingSettings.mockReset();
  mockGetAutoRoutingSettings.mockImplementation(async settingsOwner =>
    settingsResult(settingsOwner, null)
  );
  mockGetCachedRoutingTable.mockReset();
  mockGetCachedRoutingTable.mockResolvedValue(null);
});

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
const orgSettingsOwner = {
  ownerType: 'org',
  ownerId: owner.organizationId,
} satisfies AutoRoutingModeOwnerQuery;
const personalSettingsOwner = {
  ownerType: 'user',
  ownerId: owner.userId,
} satisfies AutoRoutingModeOwnerQuery;
const orgPool = [
  { model: 'openai/o3', variant: 'high' },
  { model: 'anthropic/claude', variant: null },
  { model: 'openai/o3', variant: 'low' },
] satisfies PoolEntry[];
const personalPool = [
  { model: 'google/gemini-2.5-flash', variant: null },
  { model: 'openai/o3', variant: 'medium' },
] satisfies PoolEntry[];

describe('loadEffectiveAutoRoutingPool', () => {
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('returns the organization override in saved order with every variant intact', async () => {
    mockGetAutoRoutingSettings
      .mockResolvedValueOnce(settingsResult(orgSettingsOwner, orgPool))
      .mockResolvedValueOnce(settingsResult(personalSettingsOwner, personalPool));

    await expect(loadEffectiveAutoRoutingPool(owner)).resolves.toEqual([
      { model: 'openai/o3', variant: 'high' },
      { model: 'anthropic/claude', variant: null },
      { model: 'openai/o3', variant: 'low' },
    ]);
    expect(mockGetAutoRoutingSettings.mock.calls).toEqual([
      [orgSettingsOwner, expect.any(AbortSignal)],
      [personalSettingsOwner, expect.any(AbortSignal)],
    ]);
    expect(mockGetAutoRoutingSettings.mock.calls[0][1]).not.toBe(
      mockGetAutoRoutingSettings.mock.calls[1][1]
    );
    expect(mockGetCachedRoutingTable).not.toHaveBeenCalled();
  });

  it.each([{ configuredPool: null }, { configuredPool: [] }])(
    'inherits the personal pool when the organization pool is $configuredPool',
    async ({ configuredPool }) => {
      mockGetAutoRoutingSettings
        .mockResolvedValueOnce(settingsResult(orgSettingsOwner, configuredPool))
        .mockResolvedValueOnce(settingsResult(personalSettingsOwner, personalPool));

      await expect(loadEffectiveAutoRoutingPool(owner)).resolves.toEqual(personalPool);
    }
  );

  it('loads only personal settings for a request without an organization', async () => {
    mockGetAutoRoutingSettings.mockResolvedValueOnce(
      settingsResult(personalSettingsOwner, personalPool)
    );

    await expect(
      loadEffectiveAutoRoutingPool({ userId: owner.userId, organizationId: null })
    ).resolves.toEqual(personalPool);
    expect(mockGetAutoRoutingSettings.mock.calls).toEqual([
      [personalSettingsOwner, expect.any(AbortSignal)],
    ]);
  });

  it.each([{ configuredPool: null }, { configuredPool: [] }])(
    'returns null when both configured pools are $configuredPool',
    async ({ configuredPool }) => {
      mockGetAutoRoutingSettings.mockImplementation(async settingsOwner =>
        settingsResult(settingsOwner, configuredPool)
      );

      await expect(loadEffectiveAutoRoutingPool(owner)).resolves.toBeNull();
    }
  );

  it('inherits the personal pool when the organization settings request rejects', async () => {
    mockGetAutoRoutingSettings
      .mockRejectedValueOnce(new Error('Sensitive upstream failure'))
      .mockResolvedValueOnce(settingsResult(personalSettingsOwner, personalPool));

    await expect(loadEffectiveAutoRoutingPool(owner)).resolves.toEqual(personalPool);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith('Failed to load auto routing settings');
  });

  it('keeps the organization pool when the personal settings request rejects', async () => {
    mockGetAutoRoutingSettings
      .mockResolvedValueOnce(settingsResult(orgSettingsOwner, orgPool))
      .mockRejectedValueOnce(new Error('Sensitive upstream failure'));

    await expect(loadEffectiveAutoRoutingPool(owner)).resolves.toEqual(orgPool);
  });

  it.each([owner, { ...owner, organizationId: null }])(
    'returns null when every settings request rejects for $organizationId',
    async requestOwner => {
      mockGetAutoRoutingSettings.mockRejectedValue(new Error('Sensitive upstream failure'));

      await expect(loadEffectiveAutoRoutingPool(requestOwner)).resolves.toBeNull();
    }
  );

  it.each([
    {
      name: 'inherits the personal pool when the organization request times out',
      requestOwner: owner,
      pendingOwnerType: 'org',
      expectedPool: personalPool,
    },
    {
      name: 'keeps the organization pool when the personal request times out',
      requestOwner: owner,
      pendingOwnerType: 'user',
      expectedPool: orgPool,
    },
    {
      name: 'returns null when the personal-only request times out',
      requestOwner: { ...owner, organizationId: null },
      pendingOwnerType: 'user',
      expectedPool: null,
    },
  ])('$name', async ({ requestOwner, pendingOwnerType, expectedPool }) => {
    jest.useFakeTimers();
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException('Settings request timed out', 'TimeoutError')),
        milliseconds
      );
      return controller.signal;
    });
    mockGetAutoRoutingSettings.mockImplementation(async (settingsOwner, signal) => {
      if (settingsOwner.ownerType !== pendingOwnerType) {
        return settingsResult(
          settingsOwner,
          settingsOwner.ownerType === 'org' ? orgPool : personalPool
        );
      }
      if (!signal) throw new Error('Expected a timeout signal');
      return new Promise<AutoRoutingSettingsWorkerResult>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const onResolved = jest.fn();
    const result = loadEffectiveAutoRoutingPool(requestOwner).then(pool => {
      onResolved(pool);
      return pool;
    });

    expect(timeoutSpy.mock.calls).toEqual(
      requestOwner.organizationId ? [[2000], [2000]] : [[2000]]
    );
    await jest.advanceTimersByTimeAsync(1999);
    expect(onResolved).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toEqual(expectedPool);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith('Failed to load auto routing settings');
  });

  describe.each([
    {
      name: 'an error response',
      result: { status: 503, body: { error: 'Settings unavailable' } },
    },
    {
      name: 'a non-200 response containing a pool',
      result: { ...settingsResult(orgSettingsOwner, orgPool), status: 503 },
    },
    {
      name: 'legacy settings without configuredPool',
      result: {
        status: 200,
        body: {
          ...orgSettingsOwner,
          mode: 'cost_per_accuracy',
          configuredMode: null,
          defaultMode: 'cost_per_accuracy',
        } satisfies AutoRoutingModeResponse,
      },
    },
  ])('with $name', ({ result }) => {
    it('skips the organization response and inherits the personal pool', async () => {
      mockGetAutoRoutingSettings
        .mockResolvedValueOnce(result)
        .mockResolvedValueOnce(settingsResult(personalSettingsOwner, personalPool));

      await expect(loadEffectiveAutoRoutingPool(owner)).resolves.toEqual(personalPool);
    });

    it('returns null when no later owner has a configured pool', async () => {
      mockGetAutoRoutingSettings.mockResolvedValueOnce(result);

      await expect(loadEffectiveAutoRoutingPool(owner)).resolves.toBeNull();
    });
  });
});

describe('loadAutoRoutingCandidateModelIds', () => {
  beforeEach(() => {
    mockGetCachedRoutingTable.mockResolvedValue({
      version: 'benchmark-1',
      generatedAt: '2026-08-31T00:00:00.000Z',
      minAccuracy: 0.8,
      switchCostFactor: 1.2,
      bestAccuracySwitchThreshold: 0.05,
      source: 'benchmark',
      routes: {
        'implementation/code_generation': [
          {
            model: 'table/only-model',
            variant: null,
            accuracy: 0.9,
            avgCostUsd: 0.01,
            meetsThreshold: true,
          },
        ],
      },
    } satisfies RoutingTable);
  });

  it('projects the effective pool to distinct model IDs instead of using the routing table', async () => {
    mockGetAutoRoutingSettings
      .mockResolvedValueOnce(settingsResult(orgSettingsOwner, orgPool))
      .mockResolvedValueOnce(settingsResult(personalSettingsOwner, personalPool));

    await expect(loadAutoRoutingCandidateModelIds(owner)).resolves.toEqual([
      'openai/o3',
      'anthropic/claude',
      MINIMAX_CURRENT_MODEL_ID,
      'byteplus-coding/bytedance-seed-code',
    ]);
    expect(mockGetCachedRoutingTable).toHaveBeenCalledTimes(1);
  });

  it('falls back to routing-table model IDs when no pool is configured', async () => {
    await expect(loadAutoRoutingCandidateModelIds(owner)).resolves.toEqual([
      'table/only-model',
      MINIMAX_CURRENT_MODEL_ID,
      'byteplus-coding/bytedance-seed-code',
    ]);
  });
});

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
    await expect(collectDeniedAutoRoutingModelIds(policy(), owner)).resolves.toEqual([]);
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
    expect(ids).not.toContain('qwen/qwen3.7-plus');
  });
});
