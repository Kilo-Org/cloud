import { describe, expect, it } from 'vitest';

import {
  type BranchSectionInput,
  resolveBranchSectionState,
} from './new-session-repository-state';

// The branch row renders from this one value, so every state must be reachable
// by exactly one flag combination and the priority must be total: "loading" and
// a message can never be on screen together.
const settled = {
  platform: 'github',
  isEnabled: true,
  isLoading: false,
  isPermanentError: false,
  isRetryableError: false,
  isRetrying: false,
  branches: ['main'],
  defaultBranch: 'main',
  truncated: false,
} satisfies BranchSectionInput;

describe('resolveBranchSectionState', () => {
  it('explains a personal Bitbucket row instead of describing a request it never makes', () => {
    expect(
      resolveBranchSectionState({
        ...settled,
        platform: 'bitbucket',
        isEnabled: false,
        isLoading: true,
      })
    ).toEqual({ kind: 'bitbucket-organizations-only' });
  });

  it('is loading while the request runs, winning over any earlier error', () => {
    expect(
      resolveBranchSectionState({
        ...settled,
        isLoading: true,
        isPermanentError: true,
        isRetryableError: true,
      })
    ).toEqual({ kind: 'loading' });
  });

  it('is loading for a row whose query cannot run yet', () => {
    expect(resolveBranchSectionState({ ...settled, isEnabled: false })).toEqual({ kind: 'loading' });
  });

  it('reports a refusal a retry cannot fix', () => {
    expect(resolveBranchSectionState({ ...settled, isPermanentError: true })).toEqual({
      kind: 'unavailable',
    });
  });

  it('reports a retryable failure with its retry progress', () => {
    expect(
      resolveBranchSectionState({ ...settled, isRetryableError: true, isRetrying: true })
    ).toEqual({ kind: 'retryable', isRetrying: true });
  });

  it('reports an empty provider list after every failure state is excluded', () => {
    expect(resolveBranchSectionState({ ...settled, branches: [], defaultBranch: null })).toEqual({
      kind: 'empty',
    });
  });

  it('lists the branches with the default and the partial-listing flag', () => {
    expect(
      resolveBranchSectionState({
        ...settled,
        branches: ['main', 'release/2.0'],
        truncated: true,
      })
    ).toEqual({
      kind: 'list',
      branches: ['main', 'release/2.0'],
      defaultBranch: 'main',
      truncated: true,
    });
  });

  it.each([
    [{ isLoading: true }, 'loading'],
    [{ isLoading: true, isPermanentError: true, isRetryableError: true }, 'loading'],
    [{ isPermanentError: true, isRetryableError: true }, 'unavailable'],
    [{ isRetryableError: true, branches: [] }, 'retryable'],
    [{ branches: [] }, 'empty'],
    [{}, 'list'],
  ] as const)('resolves %o to the single %s state', (overrides, kind) => {
    expect(resolveBranchSectionState({ ...settled, ...overrides }).kind).toBe(kind);
  });
});
