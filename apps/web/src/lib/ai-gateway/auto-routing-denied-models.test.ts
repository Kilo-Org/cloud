import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { EffectiveOrganizationModelPolicy } from '@/lib/organizations/effective-model-access.server';

jest.mock('@/lib/ai-gateway/auto-routing-table-cache', () => ({
  getCachedRoutingTable: jest.fn(),
}));
jest.mock('@/lib/organizations/effective-model-access.server', () => ({
  getEffectiveModelDecision: jest.fn(),
}));

import { getCachedRoutingTable } from '@/lib/ai-gateway/auto-routing-table-cache';
import { getEffectiveModelDecision } from '@/lib/organizations/effective-model-access.server';
import { BALANCED_QWEN_MODEL } from '@/lib/ai-gateway/auto-model';
import { MINIMAX_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/minimax';
import {
  collectDeniedAutoRoutingModelIds,
  loadAutoRoutingCandidateModelIds,
  policyNeedsCandidateEvaluation,
} from './auto-routing-denied-models';

const mockedGetCachedRoutingTable = jest.mocked(getCachedRoutingTable);
const mockedGetEffectiveModelDecision = jest.mocked(getEffectiveModelDecision);

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
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the organization deny list without loading candidates', async () => {
    await expect(
      collectDeniedAutoRoutingModelIds(
        policy({ organizationModelDenyList: ['openai/gpt-4o:free'] })
      )
    ).resolves.toEqual(['openai/gpt-4o']);
    expect(mockedGetCachedRoutingTable).not.toHaveBeenCalled();
    expect(mockedGetEffectiveModelDecision).not.toHaveBeenCalled();
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
    mockedGetCachedRoutingTable.mockResolvedValue({
      routes: {
        'implementation/code_generation': [
          { model: 'google/gemini-2.5-flash' },
          { model: 'anthropic/claude' },
        ],
      },
    } as never);
    mockedGetEffectiveModelDecision.mockImplementation(async (_policy, modelId) => ({
      allowed: modelId !== 'google/gemini-2.5-flash',
    }));

    const denied = await collectDeniedAutoRoutingModelIds(
      policy({ organizationProviderCeiling: ['anthropic'] })
    );

    expect(denied).toContain('google/gemini-2.5-flash');
    expect(denied).not.toContain('anthropic/claude');
    expect(mockedGetEffectiveModelDecision).toHaveBeenCalledWith(
      expect.anything(),
      'google/gemini-2.5-flash'
    );
  });
});

describe('loadAutoRoutingCandidateModelIds', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('includes routing-table models plus coding-plan and balanced fallback ids', async () => {
    mockedGetCachedRoutingTable.mockResolvedValue({
      routes: {
        'implementation/code_generation': [
          { model: 'google/gemini-2.5-flash' },
          { model: 'kilo-auto/balanced' },
        ],
      },
    } as never);

    await expect(loadAutoRoutingCandidateModelIds()).resolves.toEqual(
      expect.arrayContaining([
        'google/gemini-2.5-flash',
        BALANCED_QWEN_MODEL.model,
        MINIMAX_CURRENT_MODEL_ID,
        'byteplus-coding/bytedance-seed-code',
      ])
    );
    await expect(loadAutoRoutingCandidateModelIds()).resolves.not.toContain('kilo-auto/balanced');
  });
});
