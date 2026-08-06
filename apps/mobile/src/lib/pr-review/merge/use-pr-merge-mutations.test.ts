// P0-B-08 wiring tests for `useMergePullRequestMutation`.
//
// The pure gate / store / error class are covered by their own unit
// tests. These tests assert the WIRING: the hook's `mutationFn`
// delegates to `trpcClient.githubPrReview.mergePullRequest.mutate`
// and then routes the result through `assertMergeResult`, so a
// `merged: false` reply throws `MergeNotCompletedError` and lands in
// React Query's `onError` (NOT `onSuccess`).
//
// P1-A-08c wiring: the hoisted operation key is merged into the mutate
// input and the key rotation policy (real `isPrMutationRetryable`) runs
// inside `mutationFn`; only `useHoistedOperationKey` is mocked (it holds
// React ref state that needs a mounted renderer).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as PrOperationLedgerModule from '@/lib/pr-review/merge/pr-operation-ledger';
import { classifyPrReviewMutationError } from '@/lib/pr-review/classify-pr-review-query-state';
import {
  mergePullRequestIntentFingerprint,
  useMergePullRequestMutation,
} from './use-pr-merge-mutations';
import { MergeNotCompletedError } from './merge-result-error';

const hoistedKeys = vi.hoisted(() => ({
  getKey: vi.fn(() => 'hoisted-op-key'),
  rotateKey: vi.fn(),
}));

vi.mock('expo-crypto', () => ({
  randomUUID: () => 'not-used',
}));

vi.mock('@/lib/pr-review/merge/pr-operation-ledger', async importOriginal => {
  const actual = await importOriginal<typeof PrOperationLedgerModule>();
  return { ...actual, useHoistedOperationKey: () => hoistedKeys };
});

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
    hoistedKeys.getKey.mockClear();
    hoistedKeys.rotateKey.mockClear();
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

  it('merges the hoisted operation key into the merge input (P1-A-08c)', async () => {
    mutateMock.mockResolvedValueOnce({ merged: true, sha: 's1', branchDeleted: true });
    useMergePullRequestMutation(REF);

    await lastCapturedOptions?.mutationFn?.(INPUT);

    expect(hoistedKeys.getKey).toHaveBeenCalled();
    expect(mutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ operationKey: 'hoisted-op-key' })
    );
    expect(mutateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'octocat',
        repo: 'hello',
        number: 1,
        method: 'squash',
        expectedHeadSha: 'a'.repeat(40),
      })
    );
  });

  it('regenerates the key after a successful merge (fresh intent next)', async () => {
    mutateMock.mockResolvedValueOnce({ merged: true, sha: 's1', branchDeleted: true });
    useMergePullRequestMutation(REF);

    await lastCapturedOptions?.mutationFn?.(INPUT);

    expect(hoistedKeys.rotateKey).toHaveBeenCalledTimes(1);
  });

  it('keeps the key when GitHub declines the merge (merged:false is retryable)', async () => {
    mutateMock.mockResolvedValueOnce({ merged: false, sha: 's1', branchDeleted: false });
    useMergePullRequestMutation(REF);

    await expect(lastCapturedOptions?.mutationFn?.(INPUT)).rejects.toBeInstanceOf(
      MergeNotCompletedError
    );

    // The key stays stable so the next same-intent retry reconciles on the
    // server instead of admitting a brand-new operation.
    expect(hoistedKeys.rotateKey).not.toHaveBeenCalled();
  });

  it('regenerates the key on a non-retryable failure (bad-request ends the intent)', async () => {
    const badRequest = new Error('Cannot approve your own pull request');
    Object.assign(badRequest, { data: { code: 'BAD_REQUEST' } });
    mutateMock.mockRejectedValueOnce(badRequest);
    useMergePullRequestMutation(REF);

    await expect(lastCapturedOptions?.mutationFn?.(INPUT)).rejects.toMatchObject({
      message: 'Cannot approve your own pull request',
    });
    expect(hoistedKeys.rotateKey).toHaveBeenCalledTimes(1);
  });

  it('keeps the key on an in-progress CONFLICT and maps it onto the merge retryable copy', async () => {
    mutateMock.mockRejectedValueOnce(new Error('operation_in_progress'));
    useMergePullRequestMutation(REF);

    await expect(lastCapturedOptions?.mutationFn?.(INPUT)).rejects.toMatchObject({
      message: 'Could not merge pull request.',
    });
    expect(hoistedKeys.rotateKey).not.toHaveBeenCalled();
  });

  it('maps the ambiguous ledger marker onto the verify-before-retrying copy in onError', () => {
    useMergePullRequestMutation(REF);
    lastCapturedOptions?.onError?.(new Error("Couldn't confirm — check the PR before retrying."));
    expect(toastErrorMock).toHaveBeenCalledWith("Couldn't confirm — check the PR before retrying.");
  });
});

describe('mergePullRequestIntentFingerprint (P1-A-08c changed-input)', () => {
  it('stays stable for a retry of the same merge and rotates when the method or message changes', () => {
    const original = mergePullRequestIntentFingerprint(INPUT);
    expect(mergePullRequestIntentFingerprint(INPUT)).toBe(original);

    const changedMethod = mergePullRequestIntentFingerprint({ ...INPUT, method: 'rebase' });
    expect(changedMethod).not.toBe(original);

    const changedMessage = mergePullRequestIntentFingerprint({
      ...INPUT,
      commitMessage: 'merge it now',
    });
    expect(changedMessage).not.toBe(original);

    const changedFence = mergePullRequestIntentFingerprint({
      ...INPUT,
      expectedHeadSha: 'b'.repeat(40),
    });
    expect(changedFence).not.toBe(original);

    const changedDeleteBranch = mergePullRequestIntentFingerprint({
      ...INPUT,
      deleteBranch: false,
    });
    expect(changedDeleteBranch).not.toBe(original);
  });
});
