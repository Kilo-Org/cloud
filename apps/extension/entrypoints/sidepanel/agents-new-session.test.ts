import { describe, expect, it, vi } from 'vitest';

// agents-new-session transitively imports the WXT '#imports' virtual module;
// stub it so the graph loads under vitest.
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

import {
  buildPrepareSessionInput,
  buildSubmitInput,
  isModelPreferencesGetResult,
  MODE,
  PROMPT_MAX_LENGTH,
  PROMPT_MIN_LENGTH,
} from './agents-new-session';

// ---------------------------------------------------------------------------
// isModelPreferencesGetResult
// ---------------------------------------------------------------------------

describe('isModelPreferencesGetResult', () => {
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

  it('returns false for undefined', () => {
    expect(isModelPreferencesGetResult(undefined)).toBe(false);
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
  it('PROMPT_MIN_LENGTH is 3', () => {
    expect(PROMPT_MIN_LENGTH).toBe(3);
  });

  it('PROMPT_MAX_LENGTH is 4000', () => {
    expect(PROMPT_MAX_LENGTH).toBe(4000);
  });

  it('MODE is "code"', () => {
    expect(MODE).toBe('code');
  });
});

// ---------------------------------------------------------------------------
// buildSubmitInput
// ---------------------------------------------------------------------------

describe('buildSubmitInput', () => {
  const baseParams = {
    prompt: 'Hello world',
    selectedModel: 'gpt-4',
    selectedVariant: '',
    selectedRepo: 'owner/repo',
    initialMessageId: 'msg_123',
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
});

// ---------------------------------------------------------------------------
// buildPrepareSessionInput
// ---------------------------------------------------------------------------

describe('buildPrepareSessionInput', () => {
  const baseInput = {
    prompt: 'Hello world',
    model: 'gpt-4',
    githubRepo: 'owner/repo',
  };

  it('uses personal path when organizationId is undefined', () => {
    const action = buildPrepareSessionInput(undefined, baseInput);
    expect(action.path).toBe('cloudAgentNext.prepareSession');
  });

  it('uses personal path when organizationId is null', () => {
    const action = buildPrepareSessionInput(null as unknown as undefined, baseInput);
    expect(action.path).toBe('cloudAgentNext.prepareSession');
  });

  it('uses organization path when organizationId is set', () => {
    const action = buildPrepareSessionInput('org-42', baseInput);
    expect(action.path).toBe('organizations.cloudAgentNext.prepareSession');
  });

  it('adds organizationId to payload for organization dispatch', () => {
    const action = buildPrepareSessionInput('org-99', baseInput);
    expect(action.payload).toEqual({ ...baseInput, organizationId: 'org-99' });
  });

  it('does not add organizationId to payload for personal dispatch', () => {
    const action = buildPrepareSessionInput(undefined, baseInput);
    expect(action.payload).toEqual(baseInput);
    expect(action.payload).not.toHaveProperty('organizationId');
  });

  it('does not mutate the original baseInput', () => {
    const copy = { ...baseInput };
    buildPrepareSessionInput('org-1', baseInput);
    expect(baseInput).toEqual(copy);
  });
});
