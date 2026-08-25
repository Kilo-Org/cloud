import { describe, expect, it, vi } from 'vitest';

import {
  buildPrepareSessionInput,
  buildSubmitInput,
  getRepoOptionKey,
  isModelPreferencesGetResult,
  MODE,
  PROMPT_MAX_LENGTH,
  PROMPT_MIN_LENGTH,
  submitBlockedReason,
} from './agents-new-session';

/* eslint-disable jest/no-untyped-mock-factory, vitest/prefer-import-in-mock -- WXT virtual module has no importable runtime type in Vitest. */
// Agents-new-session transitively imports the WXT '#imports' virtual module.
// Stub it so the graph loads under Vitest.
vi.mock('#imports', () => ({
  browser: { runtime: { sendMessage: vi.fn() }, tabs: { query: vi.fn() } },
  storage: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    watch: vi.fn(() => () => {
      /* No-op unwatch */
    }),
  },
}));

// ---------------------------------------------------------------------------
// IsModelPreferencesGetResult
// ---------------------------------------------------------------------------

describe('isModelPreferencesGetResult helper', () => {
  it('returns true for a valid model preferences object with lastSelected', () => {
    const value = { favorites: ['model-a', 'model-b'], lastSelected: { model: 'model-a' } };
    expect(isModelPreferencesGetResult(value)).toBe(true);
  });

  it('returns true when lastSelected is null', () => {
    const value = { favorites: ['model-a'], lastSelected: null };
    expect(isModelPreferencesGetResult(value)).toBe(true);
  });

  it('returns false when favorites is missing', () => {
    const value = { lastSelected: { model: 'model-a' } };
    expect(isModelPreferencesGetResult(value)).toBe(false);
  });

  it('returns false when favorites is not an array', () => {
    const value = { favorites: 'not-an-array' };
    expect(isModelPreferencesGetResult(value)).toBe(false);
  });

  it('returns false for null', () => {
    expect(isModelPreferencesGetResult(null)).toBe(false);
  });

  it('returns false for a primitive', () => {
    expect(isModelPreferencesGetResult(42)).toBe(false);
    expect(isModelPreferencesGetResult('string')).toBe(false);
  });

  it('returns true for an empty favorites array', () => {
    const value = { favorites: [], lastSelected: null };
    expect(isModelPreferencesGetResult(value)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('constants', () => {
  it('promptMinLength is 3', () => {
    expect(PROMPT_MIN_LENGTH).toBe(3);
  });

  it('promptMaxLength is 4000', () => {
    expect(PROMPT_MAX_LENGTH).toBe(4000);
  });

  it('mode is "code"', () => {
    expect(MODE).toBe('code');
  });
});

// ---------------------------------------------------------------------------
// BuildSubmitInput
// ---------------------------------------------------------------------------

describe('buildSubmitInput helper', () => {
  const baseParams = {
    initialMessageId: 'msg_123',
    prompt: 'Hello world',
    selectedModel: 'gpt-4',
    selectedRepo: 'owner/repo',
    selectedVariant: '',
  };

  it('returns mode "code"', () => {
    const result = buildSubmitInput(baseParams);
    expect(result['mode']).toBe('code');
  });

  it('includes prompt, model, githubRepo', () => {
    const result = buildSubmitInput(baseParams);
    expect(result['prompt']).toBe('Hello world');
    expect(result['model']).toBe('gpt-4');
    expect(result['githubRepo']).toBe('owner/repo');
  });

  it('sets autoCommit and autoInitiate to true', () => {
    const result = buildSubmitInput(baseParams);
    expect(result['autoCommit']).toBe(true);
    expect(result['autoInitiate']).toBe(true);
  });

  it('includes initialMessageId', () => {
    const result = buildSubmitInput(baseParams);
    expect(result['initialMessageId']).toBe('msg_123');
  });

  it('omits variant when empty string', () => {
    const result = buildSubmitInput({ ...baseParams, selectedVariant: '' });
    expect(result).not.toHaveProperty('variant');
  });

  it('includes variant when non-empty', () => {
    const result = buildSubmitInput({ ...baseParams, selectedVariant: 'xhigh' });
    expect(result['variant']).toBe('xhigh');
  });

  it('does not include organizationId (handled by caller)', () => {
    const result = buildSubmitInput(baseParams);
    expect(result).not.toHaveProperty('organizationId');
  });

  it('includes repository integration provenance when available', () => {
    const result = buildSubmitInput({ ...baseParams, githubIntegrationId: 'integration-1' });
    expect(result['githubIntegrationId']).toBe('integration-1');
  });

  it('omits repository integration provenance for legacy responses', () => {
    expect(buildSubmitInput(baseParams)).not.toHaveProperty('githubIntegrationId');
  });
});

describe('getRepoOptionKey helper', () => {
  const repository = { fullName: 'owner/repo', id: 1, name: 'repo', private: false };

  it('distinguishes duplicate repositories across integrations', () => {
    expect(getRepoOptionKey({ ...repository, platformIntegrationId: 'integration-1' })).not.toBe(
      getRepoOptionKey({ ...repository, platformIntegrationId: 'integration-2' })
    );
  });

  it('uses the legacy full name when provenance is absent', () => {
    expect(getRepoOptionKey(repository)).toBe('owner/repo');
  });
});

// ---------------------------------------------------------------------------
// BuildPrepareSessionInput
// ---------------------------------------------------------------------------

describe('buildPrepareSessionInput helper', () => {
  const baseInput = {
    githubRepo: 'owner/repo',
    model: 'gpt-4',
    prompt: 'Hello world',
  };

  it('uses personal path when organizationId is undefined', () => {
    const action = buildPrepareSessionInput(undefined, baseInput);
    expect(action.path).toBe('cloudAgentNext.prepareSession');
  });

  it('uses personal path when organizationId is null', () => {
    const action = buildPrepareSessionInput(null, baseInput);
    expect(action.path).toBe('cloudAgentNext.prepareSession');
  });

  it('uses organization path when organizationId is set', () => {
    const action = buildPrepareSessionInput('org-42', baseInput);
    expect(action.path).toBe('organizations.cloudAgentNext.prepareSession');
  });

  it('adds organizationId to payload for organization dispatch', () => {
    const action = buildPrepareSessionInput('org-99', baseInput);
    expect(action.payload).toStrictEqual({ ...baseInput, organizationId: 'org-99' });
  });

  it('does not add organizationId to payload for personal dispatch', () => {
    const action = buildPrepareSessionInput(undefined, baseInput);
    expect(action.payload).toStrictEqual(baseInput);
    expect(action.payload).not.toHaveProperty('organizationId');
  });

  it('does not mutate the original baseInput', () => {
    const copy = { ...baseInput };
    buildPrepareSessionInput('org-1', baseInput);
    expect(baseInput).toStrictEqual(copy);
  });
});

describe('submitBlockedReason helper', () => {
  const base = {
    hasModels: true,
    integrationInstalled: true,
    isCloudTarget: true,
    isLoading: false,
    isPromptValid: true,
    repoCount: 1,
    selectedRepo: 'org/repo',
  };

  it('returns null when the cloud form is submittable', () => {
    expect(submitBlockedReason(base)).toBeNull();
  });

  it('stays silent while the prompt is still too short', () => {
    // The textarea already reports the length requirement.
    expect(submitBlockedReason({ ...base, isPromptValid: false, selectedRepo: '' })).toBeNull();
  });

  it('stays silent for a CLI target, which needs no repo or model', () => {
    expect(
      submitBlockedReason({
        ...base,
        hasModels: false,
        integrationInstalled: false,
        isCloudTarget: false,
        repoCount: 0,
        selectedRepo: '',
      })
    ).toBeNull();
  });

  it('names no blocker while the repo and model lists are still loading', () => {
    // An empty list mid-load means "not yet", not "none available".
    expect(
      submitBlockedReason({
        ...base,
        hasModels: false,
        isLoading: true,
        repoCount: 0,
        selectedRepo: '',
      })
    ).toBeNull();
  });

  it('reports connect-github before anything else', () => {
    expect(
      submitBlockedReason({ ...base, integrationInstalled: false, repoCount: 0, selectedRepo: '' })
    ).toBe('connect-github');
  });

  it('reports no-repos when the integration is installed but empty', () => {
    expect(submitBlockedReason({ ...base, repoCount: 0, selectedRepo: '' })).toBe('no-repos');
  });

  it('reports no-models when models failed to load', () => {
    expect(submitBlockedReason({ ...base, hasModels: false })).toBe('no-models');
  });

  it('reports pick-repo when repositories exist but none is chosen', () => {
    expect(submitBlockedReason({ ...base, selectedRepo: '' })).toBe('pick-repo');
  });
});
