/* eslint-disable max-lines -- the merge and auto-merge suites share one mock harness for the merge seam */
// P0-B-08 + s6 wiring tests for `useMergePullRequestMutation` and the
// auto-merge hooks.
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
//
// s6: the provider arms route the same intents through
// `providerReview.*` with the s1 provider identity, normalize the
// `{done, replayed}` answer onto the gate's result shape (a `done:
// false` never celebrates, with provider wording), and fence every
// merge/auto-merge write on `expectedHeadSha`. Auto-merge is
// GitLab-only: the server answers Bitbucket with `{supported: false,
// reason}` and the hook must NOT announce a success for it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as OperationKeyModule from '@/lib/operation-key';
import type * as AnnounceModule from '@/lib/a11y/announce';
import { classifyPrReviewMutationError } from '@/lib/pr-review/classify-pr-review-query-state';
import { prIntentFingerprint } from '@kilocode/app-shared/pr-review';
import type * as ProviderPrRefModule from '@/lib/pr-review/provider-pr-ref';
import { type ProviderPrRef, type ProviderPrTriple } from '@/lib/pr-review/provider-pr-ref';
import { useEnableAutoMergeMutation, useMergePullRequestMutation } from './use-pr-merge-mutations';
import { MergeNotCompletedError } from './merge-result-error';

const hoistedKeys = vi.hoisted(() => ({
  getKey: vi.fn(() => 'hoisted-op-key'),
  rotateKey: vi.fn(),
}));

const announceMock = vi.hoisted(() => ({ announceForA11y: vi.fn() }));

vi.mock('expo-crypto', () => ({
  randomUUID: () => 'not-used',
}));

vi.mock('@/lib/operation-key', async importOriginal => {
  const actual = await importOriginal<typeof OperationKeyModule>();
  return { ...actual, useHoistedOperationKey: () => hoistedKeys };
});

vi.mock('@/lib/a11y/announce', async importOriginal => {
  const actual = await importOriginal<typeof AnnounceModule>();
  return { ...actual, announceForA11y: (message: string) => announceMock.announceForA11y(message) };
});

// See the review-mutations test: the scope context hook is replaced by a
// settable override so the hooks run without a renderer.
let scopeOverride: { ref: ProviderPrRef; organizationId: string | null } | null = null;

vi.mock('@/lib/pr-review/provider-pr-ref', async importOriginal => {
  const actual = await importOriginal<typeof ProviderPrRefModule>();
  return {
    ...actual,
    useProviderPrScope: (fallback: ProviderPrTriple) =>
      scopeOverride ?? { ref: { platform: 'github', ...fallback }, organizationId: null },
  };
});

type MutationOptions = {
  mutationFn?: (vars: unknown) => Promise<unknown>;
  onSuccess?: (data: unknown) => void;
  onError?: (error: unknown) => void;
  onSettled?: (data?: unknown, error?: unknown, vars?: unknown) => Promise<void> | void;
};

let lastCapturedOptions: MutationOptions | null = null;
const mutateMock = vi.fn();
const providerMergeMutateMock = vi.fn();
const providerEnableAutoMergeMutateMock = vi.fn();
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
    providerReview: {
      getPullRequest: { queryKey: () => ['providerReview', 'getPullRequest'] },
      listChecks: { pathFilter: () => ['providerReview', 'listChecks'] },
      listFiles: { pathFilter: () => ['providerReview', 'listFiles'] },
    },
  }),
  trpcClient: {
    githubPrReview: {
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      mergePullRequest: { mutate: (vars: unknown) => mutateMock(vars) },
    },
    providerReview: {
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      mergePullRequest: { mutate: (vars: unknown) => providerMergeMutateMock(vars) },
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      enableAutoMerge: { mutate: (vars: unknown) => providerEnableAutoMergeMutateMock(vars) },
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

const GITLAB_REF: ProviderPrRef = {
  platform: 'gitlab',
  projectPath: 'group/sub/app',
  mrIid: 12,
  instanceHint: 'https://gl.example.com',
};

const BITBUCKET_REF: ProviderPrRef = {
  platform: 'bitbucket',
  workspace: 'acme',
  repoSlug: 'widgets',
  prId: 77,
};

const GITLAB_IDENTITY = {
  platform: 'gitlab',
  projectPath: 'group/sub/app',
  mrIid: 12,
  instanceHint: 'https://gl.example.com',
  organizationId: 'org-9',
};

const BITBUCKET_IDENTITY = {
  platform: 'bitbucket',
  workspace: 'acme',
  repoSlug: 'widgets',
  prId: 77,
  organizationId: 'org-9',
};

const PROVIDER_MERGE_VARS = {
  expectedHeadSha: 'a'.repeat(40),
  squash: true,
  deleteBranch: true,
  commitTitle: 'My title',
  commitMessage: 'My message',
};

function resetMocks() {
  lastCapturedOptions = null;
  scopeOverride = null;
  mutateMock.mockReset();
  providerMergeMutateMock.mockReset();
  providerEnableAutoMergeMutateMock.mockReset();
  invalidateQueriesMock.mockReset();
  toastErrorMock.mockReset();
  announceMock.announceForA11y.mockReset();
  hoistedKeys.getKey.mockClear();
  hoistedKeys.rotateKey.mockClear();
}

describe('useMergePullRequestMutation (P0-B-08 wiring)', () => {
  beforeEach(() => {
    resetMocks();
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

    // The fingerprint is the dedupe identity the server hashes into
    // `resource_key` for 30 days. Pin the exact bytes: a drift in the shared
    // field list must fail here instead of silently rotating in-flight keys.
    expect(hoistedKeys.getKey).toHaveBeenCalledWith(
      '{"resource":["octocat","hello",1],"method":"squash","deleteBranch":true,"expectedHeadSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
    );
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

describe('useMergePullRequestMutation (s6 gitlab arm)', () => {
  beforeEach(() => {
    resetMocks();
    scopeOverride = { ref: GITLAB_REF, organizationId: 'org-9' };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('routes the fenced merge through providerReview.mergePullRequest and normalizes the result', async () => {
    providerMergeMutateMock.mockResolvedValueOnce({ done: true, replayed: false });
    useMergePullRequestMutation(GITLAB_REF);

    await expect(lastCapturedOptions?.mutationFn?.(PROVIDER_MERGE_VARS)).resolves.toEqual({
      merged: true,
      sha: 'a'.repeat(40),
      branchDeleted: false,
    });
    expect(mutateMock).not.toHaveBeenCalled();
    expect(providerMergeMutateMock).toHaveBeenCalledWith({
      ...GITLAB_IDENTITY,
      expectedHeadSha: 'a'.repeat(40),
      squash: true,
      deleteBranch: true,
      commitTitle: 'My title',
      commitMessage: 'My message',
      operationKey: 'hoisted-op-key',
    });
    // Pinned bytes mirroring the server's gitlab merge fingerprint input:
    // method folds the squash toggle, and the fence rides the identity.
    expect(hoistedKeys.getKey).toHaveBeenCalledWith(
      '{"resource":["gitlab","https://gl.example.com","group/sub/app",12],"method":"squash","commitTitle":"My title","commitMessage":"My message","deleteBranch":true,"expectedHeadSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
    );
    expect(hoistedKeys.rotateKey).toHaveBeenCalledTimes(1);
  });

  it('never celebrates done:false: throws MergeNotCompletedError with merge-request wording, key kept', async () => {
    providerMergeMutateMock.mockResolvedValueOnce({ done: false, replayed: false });
    useMergePullRequestMutation(GITLAB_REF);

    let thrown: unknown = null;
    try {
      await lastCapturedOptions?.mutationFn?.(PROVIDER_MERGE_VARS);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MergeNotCompletedError);
    expect((thrown as Error).message).toBe(
      'The merge request was not merged. Check its state and try again.'
    );
    expect(classifyPrReviewMutationError(thrown)).toEqual({ kind: 'retryable' });
    expect(hoistedKeys.rotateKey).not.toHaveBeenCalled();
  });

  it('surfaces the server stale-head CONFLICT message unchanged (the sheet keeps it inline)', async () => {
    const staleHead = new Error(
      'The merge request changed since it was loaded. Reload the merge request and try again.'
    );
    Object.assign(staleHead, { data: { code: 'CONFLICT' } });
    providerMergeMutateMock.mockRejectedValueOnce(staleHead);
    useMergePullRequestMutation(GITLAB_REF);

    await expect(lastCapturedOptions?.mutationFn?.(PROVIDER_MERGE_VARS)).rejects.toMatchObject({
      message:
        'The merge request changed since it was loaded. Reload the merge request and try again.',
    });
  });

  it('onSettled invalidates the provider caches (overview + checks + files)', async () => {
    useMergePullRequestMutation(GITLAB_REF);

    await lastCapturedOptions?.onSettled?.();

    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: ['providerReview', 'getPullRequest'],
    });
    expect(invalidateQueriesMock).toHaveBeenCalledWith(['providerReview', 'listChecks']);
    expect(invalidateQueriesMock).toHaveBeenCalledWith(['providerReview', 'listFiles']);
  });
});

describe('useMergePullRequestMutation (s6 bitbucket arm)', () => {
  beforeEach(() => {
    resetMocks();
    scopeOverride = { ref: BITBUCKET_REF, organizationId: 'org-9' };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('sends no squash/commitTitle (Bitbucket has only the merge commit) and pins the merge method', async () => {
    providerMergeMutateMock.mockResolvedValueOnce({ done: true, replayed: false });
    useMergePullRequestMutation(BITBUCKET_REF);

    await lastCapturedOptions?.mutationFn?.(PROVIDER_MERGE_VARS);
    const sent = providerMergeMutateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).toEqual({
      ...BITBUCKET_IDENTITY,
      expectedHeadSha: 'a'.repeat(40),
      deleteBranch: true,
      commitMessage: 'My message',
      operationKey: 'hoisted-op-key',
    });
    expect(hoistedKeys.getKey).toHaveBeenCalledWith(
      '{"resource":["bitbucket","acme","widgets",77],"method":"merge","commitMessage":"My message","deleteBranch":true,"expectedHeadSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
    );
  });

  it('uses pull-request wording when the provider declines the merge', async () => {
    providerMergeMutateMock.mockResolvedValueOnce({ done: false, replayed: false });
    useMergePullRequestMutation(BITBUCKET_REF);

    await expect(lastCapturedOptions?.mutationFn?.(PROVIDER_MERGE_VARS)).rejects.toMatchObject({
      message: 'The pull request was not merged. Check its state and try again.',
    });
  });
});

describe('useEnableAutoMergeMutation (s6 provider arms)', () => {
  beforeEach(() => {
    resetMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('gitlab: arms merge-when-pipeline-succeeds fenced on the head and announces success', async () => {
    scopeOverride = { ref: GITLAB_REF, organizationId: 'org-9' };
    providerEnableAutoMergeMutateMock.mockResolvedValueOnce({
      supported: true,
      reason: '',
      done: true,
      replayed: false,
    });
    useEnableAutoMergeMutation(GITLAB_REF);

    await expect(
      lastCapturedOptions?.mutationFn?.({ expectedHeadSha: 'a'.repeat(40) })
    ).resolves.toMatchObject({ supported: true });
    expect(providerEnableAutoMergeMutateMock).toHaveBeenCalledWith({
      ...GITLAB_IDENTITY,
      expectedHeadSha: 'a'.repeat(40),
      operationKey: 'hoisted-op-key',
    });
    expect(hoistedKeys.getKey).toHaveBeenCalledWith(
      '{"resource":["gitlab","https://gl.example.com","group/sub/app",12],"expectedHeadSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
    );
    lastCapturedOptions?.onSuccess?.({ supported: true, reason: '', done: true, replayed: false });
    expect(announceMock.announceForA11y).toHaveBeenCalledWith('Auto-merge enabled');
  });

  it('bitbucket: the supported:false answer resolves as a reason, not a success — no announcement', async () => {
    scopeOverride = { ref: BITBUCKET_REF, organizationId: 'org-9' };
    const refusal = {
      supported: false,
      reason: 'Bitbucket Cloud does not expose auto-merge in its API',
      done: false,
      replayed: false,
    };
    providerEnableAutoMergeMutateMock.mockResolvedValueOnce(refusal);
    useEnableAutoMergeMutation(BITBUCKET_REF);

    await expect(
      lastCapturedOptions?.mutationFn?.({ expectedHeadSha: 'a'.repeat(40) })
    ).resolves.toEqual(refusal);
    lastCapturedOptions?.onSuccess?.(refusal);
    expect(announceMock.announceForA11y).not.toHaveBeenCalled();
  });
});

describe('merge fingerprint (P1-A-08c changed-input)', () => {
  it('stays stable for a retry of the same merge and rotates when the method or message changes', () => {
    const original = prIntentFingerprint('merge', INPUT);
    expect(prIntentFingerprint('merge', INPUT)).toBe(original);

    const changedMethod = prIntentFingerprint('merge', { ...INPUT, method: 'rebase' });
    expect(changedMethod).not.toBe(original);

    const changedMessage = prIntentFingerprint('merge', {
      ...INPUT,
      commitMessage: 'merge it now',
    });
    expect(changedMessage).not.toBe(original);

    const changedFence = prIntentFingerprint('merge', {
      ...INPUT,
      expectedHeadSha: 'b'.repeat(40),
    });
    expect(changedFence).not.toBe(original);

    const changedDeleteBranch = prIntentFingerprint('merge', {
      ...INPUT,
      deleteBranch: false,
    });
    expect(changedDeleteBranch).not.toBe(original);
  });
});
