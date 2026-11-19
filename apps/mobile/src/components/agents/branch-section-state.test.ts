import { describe, expect, it } from 'vitest';

import { type BranchSectionInput, resolveBranchSectionState } from './new-session-repository-state';

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
  it('explains a personal Bitbucket row even with a request in flight', () => {
    expect(
      resolveBranchSectionState({
        ...settled,
        platform: 'bitbucket',
        isEnabled: false,
        isLoading: true,
      })
    ).toEqual({ kind: 'bitbucket-organizations-only' });
  });

  it('is loading only while the request runs, winning over any earlier error', () => {
    expect(
      resolveBranchSectionState({
        ...settled,
        isLoading: true,
        isPermanentError: true,
        isRetryableError: true,
      })
    ).toEqual({ kind: 'loading' });
  });

  it('stays quiet for a disabled row without running a request', () => {
    // The regression the finding demands: a disabled row must never read as
    // 'loading' — it renders the quiet 'inactive' note instead.
    expect(
      resolveBranchSectionState({
        ...settled,
        isEnabled: false,
        isPermanentError: true,
        isRetryableError: true,
        branches: [],
        defaultBranch: null,
      })
    ).toEqual({ kind: 'inactive' });
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
    [{ isEnabled: false }, 'inactive'],
    [{ isEnabled: false, isLoading: true }, 'inactive'],
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
