// P1-A-08c wiring tests for `useCreateReviewCommentMutation` and
// `useSubmitReviewMutation`.
//
// The sheet / composer / pending-review surfaces own the inline error
// rendering; these tests assert the HOOK WIRING: each `mutationFn`
// delegates to the matching `trpcClient.githubPrReview.<procedure>.mutate`,
// the hoisted operation key is merged into the input, and the key rotation
// policy (real `isPrMutationRetryable` + `mapPrOperationError`) runs inside
// `mutationFn`. Only `useHoistedOperationKey` is mocked (it holds React ref
// state that needs a mounted renderer, covered by
// `operation-key.mounted.test.tsx`).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as OperationKeyModule from '@/lib/operation-key';
import { prIntentFingerprint } from '@kilocode/app-shared/pr-review';
import { useCreateReviewCommentMutation, useSubmitReviewMutation } from './use-pr-review-mutations';

const hoistedKeys = vi.hoisted(() => ({
  getKey: vi.fn(() => 'hoisted-op-key'),
  rotateKey: vi.fn(),
}));

vi.mock('expo-crypto', () => ({
  randomUUID: () => 'not-used',
}));

vi.mock('@/lib/operation-key', async importOriginal => {
  const actual = await importOriginal<typeof OperationKeyModule>();
  return { ...actual, useHoistedOperationKey: () => hoistedKeys };
});

type MutationOptions = {
  mutationFn?: (vars: unknown) => Promise<unknown>;
  onError?: (error: unknown) => void;
  onSettled?: (data?: unknown, error?: unknown, vars?: unknown) => Promise<void> | void;
};

let lastCapturedOptions: MutationOptions | null = null;
const createCommentMutateMock = vi.fn();
const submitReviewMutateMock = vi.fn();
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
      listReviewThreads: { pathFilter: () => ['githubPrReview', 'listReviewThreads'] },
    },
  }),
  trpcClient: {
    githubPrReview: {
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      createReviewComment: { mutate: (vars: unknown) => createCommentMutateMock(vars) },
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      submitReview: { mutate: (vars: unknown) => submitReviewMutateMock(vars) },
    },
  },
}));

vi.mock('sonner-native', () => ({
  toast: { error: (msg: string) => toastErrorMock(msg) },
}));

// Rolldown (Vitest's bundler) cannot parse React Native's Flow source.
// `use-pr-review-mutations` imports `announcingToast`, which imports
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

const COMMENT_INPUT = {
  owner: 'octocat',
  repo: 'hello',
  number: 1,
  body: 'inline nit',
  path: 'README.md',
  line: 3,
  side: 'RIGHT' as const,
  commitSha: 'a'.repeat(40),
};

const REVIEW_INPUT = {
  owner: 'octocat',
  repo: 'hello',
  number: 1,
  event: 'APPROVE' as const,
  body: 'LGTM',
  commitSha: 'a'.repeat(40),
  comments: [{ path: 'README.md', line: 3, side: 'RIGHT' as const, body: 'nit' }],
};

describe('useCreateReviewCommentMutation (P1-A-08c wiring)', () => {
  beforeEach(() => {
    lastCapturedOptions = null;
    createCommentMutateMock.mockReset();
    invalidateQueriesMock.mockReset();
    toastErrorMock.mockReset();
    hoistedKeys.getKey.mockClear();
    hoistedKeys.rotateKey.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('delegates the input to createReviewComment.mutate and resolves the reply', async () => {
    const reply = { id: 42, htmlUrl: 'https://example.com' };
    createCommentMutateMock.mockResolvedValueOnce(reply);
    useCreateReviewCommentMutation(REF);

    await expect(lastCapturedOptions?.mutationFn?.(COMMENT_INPUT)).resolves.toEqual(reply);
    expect(createCommentMutateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'octocat',
        repo: 'hello',
        number: 1,
        body: 'inline nit',
        path: 'README.md',
        line: 3,
        side: 'RIGHT',
        commitSha: 'a'.repeat(40),
      })
    );
  });

  it('merges the hoisted operation key into the comment input (P1-A-08c)', async () => {
    createCommentMutateMock.mockResolvedValueOnce({ id: 42 });
    useCreateReviewCommentMutation(REF);

    await lastCapturedOptions?.mutationFn?.(COMMENT_INPUT);

    // The fingerprint is the dedupe identity the server hashes into
    // `resource_key` for 30 days. Pin the exact bytes: a drift in the shared
    // field list must fail here instead of silently rotating in-flight keys.
    expect(hoistedKeys.getKey).toHaveBeenCalledWith(
      '{"resource":["octocat","hello",1],"body":"inline nit","path":"README.md","line":3,"side":"RIGHT","commitSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
    );
    expect(createCommentMutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ operationKey: 'hoisted-op-key' })
    );
  });

  it('regenerates the key after a successful post (fresh intent next)', async () => {
    createCommentMutateMock.mockResolvedValueOnce({ id: 42 });
    useCreateReviewCommentMutation(REF);

    await lastCapturedOptions?.mutationFn?.(COMMENT_INPUT);

    expect(hoistedKeys.rotateKey).toHaveBeenCalledTimes(1);
  });

  it('keeps the key on an in-progress CONFLICT and maps it onto the comment retryable copy', async () => {
    createCommentMutateMock.mockRejectedValueOnce(new Error('operation_in_progress'));
    useCreateReviewCommentMutation(REF);

    await expect(lastCapturedOptions?.mutationFn?.(COMMENT_INPUT)).rejects.toMatchObject({
      message: 'Could not post comment.',
    });
    expect(hoistedKeys.rotateKey).not.toHaveBeenCalled();
  });

  it('regenerates the key on a non-retryable failure (bad-request ends the intent)', async () => {
    const badRequest = new Error('Cannot approve your own pull request');
    Object.assign(badRequest, { data: { code: 'BAD_REQUEST' } });
    createCommentMutateMock.mockRejectedValueOnce(badRequest);
    useCreateReviewCommentMutation(REF);

    await expect(lastCapturedOptions?.mutationFn?.(COMMENT_INPUT)).rejects.toMatchObject({
      message: 'Cannot approve your own pull request',
    });
    expect(hoistedKeys.rotateKey).toHaveBeenCalledTimes(1);
  });

  it('maps the ambiguous ledger marker onto the verify-before-retrying copy in onError', () => {
    useCreateReviewCommentMutation(REF);
    lastCapturedOptions?.onError?.(new Error("Couldn't confirm — check the PR before retrying."));
    expect(toastErrorMock).toHaveBeenCalledWith("Couldn't confirm — check the PR before retrying.");
  });

  it('onError still toasts the message (so the retryable inline error surfaces)', () => {
    useCreateReviewCommentMutation(REF);
    lastCapturedOptions?.onError?.(new Error('boom'));
    expect(toastErrorMock).toHaveBeenCalledWith('boom');
  });

  it('onSettled invalidates the PR review caches (overview + threads)', async () => {
    useCreateReviewCommentMutation(REF);

    await lastCapturedOptions?.onSettled?.();

    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: ['githubPrReview', 'getPullRequest'],
    });
    expect(invalidateQueriesMock).toHaveBeenCalledWith(['githubPrReview', 'listReviewThreads']);
  });
});

describe('useSubmitReviewMutation (P1-A-08c wiring)', () => {
  beforeEach(() => {
    lastCapturedOptions = null;
    submitReviewMutateMock.mockReset();
    invalidateQueriesMock.mockReset();
    toastErrorMock.mockReset();
    hoistedKeys.getKey.mockClear();
    hoistedKeys.rotateKey.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('delegates the input to submitReview.mutate and resolves the result', async () => {
    const result = { id: 7, reviewDecision: 'APPROVED' };
    submitReviewMutateMock.mockResolvedValueOnce(result);
    useSubmitReviewMutation(REF);

    await expect(lastCapturedOptions?.mutationFn?.(REVIEW_INPUT)).resolves.toEqual(result);
    expect(submitReviewMutateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'octocat',
        repo: 'hello',
        number: 1,
        event: 'APPROVE',
        commitSha: 'a'.repeat(40),
      })
    );
  });

  it('merges the hoisted operation key into the review input (P1-A-08c)', async () => {
    submitReviewMutateMock.mockResolvedValueOnce({ id: 7 });
    useSubmitReviewMutation(REF);

    await lastCapturedOptions?.mutationFn?.(REVIEW_INPUT);

    // The fingerprint is the dedupe identity the server hashes into
    // `resource_key` for 30 days. Pin the exact bytes: a drift in the shared
    // field list must fail here instead of silently rotating in-flight keys.
    expect(hoistedKeys.getKey).toHaveBeenCalledWith(
      '{"resource":["octocat","hello",1],"event":"APPROVE","body":"LGTM","commitSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","comments":[{"path":"README.md","line":3,"side":"RIGHT","body":"nit"}]}'
    );
    expect(submitReviewMutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ operationKey: 'hoisted-op-key' })
    );
  });

  it('regenerates the key after a successful submit (fresh intent next)', async () => {
    submitReviewMutateMock.mockResolvedValueOnce({ id: 7 });
    useSubmitReviewMutation(REF);

    await lastCapturedOptions?.mutationFn?.(REVIEW_INPUT);

    expect(hoistedKeys.rotateKey).toHaveBeenCalledTimes(1);
  });

  it('keeps the key on an in-progress CONFLICT and maps it onto the submit retryable copy', async () => {
    submitReviewMutateMock.mockRejectedValueOnce(new Error('operation_in_progress'));
    useSubmitReviewMutation(REF);

    await expect(lastCapturedOptions?.mutationFn?.(REVIEW_INPUT)).rejects.toMatchObject({
      message: 'Could not submit review. Check your connection and try again.',
    });
    expect(hoistedKeys.rotateKey).not.toHaveBeenCalled();
  });

  it('regenerates the key on a non-retryable failure (bad-request ends the intent)', async () => {
    const badRequest = new Error('Cannot approve your own pull request');
    Object.assign(badRequest, { data: { code: 'BAD_REQUEST' } });
    submitReviewMutateMock.mockRejectedValueOnce(badRequest);
    useSubmitReviewMutation(REF);

    await expect(lastCapturedOptions?.mutationFn?.(REVIEW_INPUT)).rejects.toMatchObject({
      message: 'Cannot approve your own pull request',
    });
    expect(hoistedKeys.rotateKey).toHaveBeenCalledTimes(1);
  });

  it('maps the ambiguous ledger marker onto the verify-before-retrying copy in onError', () => {
    useSubmitReviewMutation(REF);
    lastCapturedOptions?.onError?.(new Error("Couldn't confirm — check the PR before retrying."));
    expect(toastErrorMock).toHaveBeenCalledWith("Couldn't confirm — check the PR before retrying.");
  });

  it('onSettled invalidates the PR review caches (overview + threads)', async () => {
    useSubmitReviewMutation(REF);

    await lastCapturedOptions?.onSettled?.();

    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: ['githubPrReview', 'getPullRequest'],
    });
    expect(invalidateQueriesMock).toHaveBeenCalledWith(['githubPrReview', 'listReviewThreads']);
  });
});

describe('create_review_comment fingerprint (P1-A-08c changed-input)', () => {
  it('stays stable for a retry of the same comment and rotates when any intent input changes', () => {
    const original = prIntentFingerprint('create_review_comment', COMMENT_INPUT);
    expect(prIntentFingerprint('create_review_comment', COMMENT_INPUT)).toBe(original);

    const editedBody = prIntentFingerprint('create_review_comment', {
      ...COMMENT_INPUT,
      body: 'inline nit (edited)',
    });
    expect(editedBody).not.toBe(original);

    const movedLine = prIntentFingerprint('create_review_comment', { ...COMMENT_INPUT, line: 4 });
    expect(movedLine).not.toBe(original);

    const newCommitSha = prIntentFingerprint('create_review_comment', {
      ...COMMENT_INPUT,
      commitSha: 'b'.repeat(40),
    });
    expect(newCommitSha).not.toBe(original);

    const otherRepo = prIntentFingerprint('create_review_comment', {
      ...COMMENT_INPUT,
      repo: 'world',
    });
    expect(otherRepo).not.toBe(original);
  });
});

describe('submit_review fingerprint (P1-A-08c changed-input)', () => {
  it('stays stable for a retry of the same review and rotates when the event or any comment changes', () => {
    const original = prIntentFingerprint('submit_review', REVIEW_INPUT);
    expect(prIntentFingerprint('submit_review', REVIEW_INPUT)).toBe(original);

    const changedEvent = prIntentFingerprint('submit_review', {
      ...REVIEW_INPUT,
      event: 'REQUEST_CHANGES',
    });
    expect(changedEvent).not.toBe(original);

    const changedSummary = prIntentFingerprint('submit_review', {
      ...REVIEW_INPUT,
      body: 'LGTM!!',
    });
    expect(changedSummary).not.toBe(original);

    const changedComment = prIntentFingerprint('submit_review', {
      ...REVIEW_INPUT,
      comments: [{ path: 'README.md', line: 4, side: 'RIGHT' as const, body: 'nit' }],
    });
    expect(changedComment).not.toBe(original);
  });
});
