// P0-B-08 wiring tests for `useMergePullRequestMutation`.
//
// The pure gate / store / error class are covered by their own unit
// tests. These tests assert the WIRING: the hook's `mutationFn`
// delegates to `trpcClient.githubPrReview.mergePullRequest.mutate`
// and then routes the result through `assertMergeResult`, so a
// `merged: false` reply throws `MergeNotCompletedError` and lands in
// React Query's `onError` (NOT `onSuccess`).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useMergePullRequestMutation } from './use-pr-merge-mutations';
import { MergeNotCompletedError } from './merge-result-error';
import { classifyPrReviewMutationError } from '@/lib/pr-review/classify-pr-review-query-state';

type MutationOptions = {
  mutationFn?: (vars: unknown) => Promise<unknown>;
  onError?: (error: unknown) => void;
  onSettled?: (data: unknown, error: unknown, vars: unknown) => Promise<void> | void;
};

let lastCapturedOptions: MutationOptions | null = null;
const mutateMock = vi.fn();
const invalidateQueriesMock = vi.fn();
const toastErrorMock = vi.fn();

vi.mock('@tanstack/react-query', () => ({
  useMutation: (opts: MutationOptions) => {
    lastCapturedOptions = opts;
    return { mutateAsync: vi.fn(), mutate: vi.fn() };
  },
  useQueryClient: () => ({
    invalidateQueries: (...args: unknown[]) => {
      invalidateQueriesMock(...args);
    },
  }),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    githubPrReview: {
      getPullRequest: { queryKey: () => ['githubPrReview', 'getPullRequest'] },
      listChecks: { pathFilter: () => ['githubPrReview', 'listChecks'] },
      listFiles: { pathFilter: () => ['githubPrReview', 'listFiles'] },
    },
  }),
  trpcClient: {
    githubPrReview: {
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      mergePullRequest: { mutate: (vars: unknown) => mutateMock(vars) },
    },
  },
}));

vi.mock('sonner-native', () => ({
  toast: { error: (msg: string) => toastErrorMock(msg) },
}));

// Rolldown (Vitest's bundler) cannot parse React Native's Flow source.
// `use-pr-merge-mutations` imports `announcingToast`, which imports
// `announce.ts`, which imports `react-native`. Mock only the symbols
// `announce.ts` imports so the module graph loads under Node.
vi.mock('react-native', () => ({
  AccessibilityInfo: {
    announceForAccessibility: vi.fn(),
    setAccessibilityFocus: vi.fn(),
  },
  findNodeHandle: vi.fn(() => null),
}));

const REF = { owner: 'octocat', repo: 'hello', number: 1 };
const INPUT = {
  owner: 'octocat',
  repo: 'hello',
  number: 1,
  method: 'squash' as const,
  deleteBranch: true,
  expectedHeadSha: 'a'.repeat(40),
};

describe('useMergePullRequestMutation (P0-B-08 wiring)', () => {
  beforeEach(() => {
    lastCapturedOptions = null;
    mutateMock.mockReset();
    invalidateQueriesMock.mockReset();
    toastErrorMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('mounts a useMutation with a custom mutationFn (so the gate can throw on merged:false)', () => {
    useMergePullRequestMutation(REF);
    expect(lastCapturedOptions?.mutationFn).toBeDefined();
  });

  it('throws MergeNotCompletedError on a merged:false result, classifying as RETRYABLE (not bad-request)', async () => {
    // The whole point of the slice: when GitHub returns `merged: false`
    // (e.g. 405 "not mergeable"), the hook must reject so React Query
    // routes it to `onError` (toast) and the sheet's effect treats it
    // as RETRYABLE — the submit button stays enabled. If the mutation
    // resolved instead, the sheet would fire a success haptic and
    // dismiss even though GitHub did not perform the merge.
    mutateMock.mockResolvedValueOnce({ merged: false, sha: 's1', branchDeleted: false });
    useMergePullRequestMutation(REF);

    let thrown: unknown = null;
    try {
      await lastCapturedOptions?.mutationFn?.(INPUT);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(MergeNotCompletedError);
    expect((thrown as MergeNotCompletedError).sha).toBe('s1');
    // Default message is the user-visible "GitHub did not complete the merge."
    expect((thrown as Error).message).toBe('GitHub did not complete the merge.');
    // classifyPrReviewMutationError is what the sheet uses; the typed
    // error must fall through to RETRYABLE so the submit button stays
    // enabled. Routing it through BAD_REQUEST would lock the user out.
    expect(classifyPrReviewMutationError(thrown)).toEqual({ kind: 'retryable' });
  });

  it('RESOLVES on a clean merged:true (does not celebrate nothing, does not throw)', async () => {
    mutateMock.mockResolvedValueOnce({ merged: true, sha: 's1', branchDeleted: true });
    useMergePullRequestMutation(REF);

    await expect(lastCapturedOptions?.mutationFn?.(INPUT)).resolves.toEqual({
      merged: true,
      sha: 's1',
      branchDeleted: true,
    });
  });

  it('RESOLVES on a partial merged:true + branchDeleteError (so performSubmit can write the banner)', async () => {
    // The partial case MUST resolve (not throw) so the sheet can read
    // the result, run `gateMergeResult`, and write the banner store
    // before dismissing.
    mutateMock.mockResolvedValueOnce({
      merged: true,
      sha: 's1',
      branchDeleted: false,
      branchDeleteError: 'Reference does not exist',
    });
    useMergePullRequestMutation(REF);

    await expect(lastCapturedOptions?.mutationFn?.(INPUT)).resolves.toEqual({
      merged: true,
      sha: 's1',
      branchDeleted: false,
      branchDeleteError: 'Reference does not exist',
    });
  });

  it('onError still toasts the message (so the retryable inline error surfaces)', () => {
    useMergePullRequestMutation(REF);
    lastCapturedOptions?.onError?.(new Error('boom'));
    expect(toastErrorMock).toHaveBeenCalledWith('boom');
  });
});
