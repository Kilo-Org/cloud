import { describe, expect, it } from '@jest/globals';
import type { EffectiveOrganizationModelPolicy } from '@/lib/organizations/effective-model-access.server';
import { MINIMAX_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/minimax';
import {
  candidateModelIdsFromSources,
  collectDeniedAutoRoutingModelIds,
  deniedModelIdsForCandidates,
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

const owner = { userId: 'user-1', organizationId: 'org-1' };

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
  it('returns no denials without loading when the policy cannot deny anything', async () => {
    await expect(collectDeniedAutoRoutingModelIds(policy(), owner)).resolves.toEqual([]);
  });
});

describe('deniedModelIdsForCandidates', () => {
  it('returns the normalized organization deny list and matching candidates', () => {
    expect(
      deniedModelIdsForCandidates(
        policy({ organizationModelDenyList: ['openai/gpt-4o:free'] }),
        ['anthropic/claude'],
        () => true
      )
    ).toEqual(['openai/gpt-4o']);
  });

  it('adds models that fail the effective access policy', () => {
    expect(
      deniedModelIdsForCandidates(
        policy({
          organizationProviderCeiling: ['anthropic'],
          organizationModelDenyList: ['openai/o3'],
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
        policy({ organizationModelDenyList: ['example/model'] }),
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
