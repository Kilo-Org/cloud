// P1-A-08c wiring tests for `useReplyToCommentMutation`.
//
// Replies are NOT optimistic (per the S7b contract): the comment is
// appended only after the server confirms. These tests assert the HOOK
// WIRING — `mutationFn` delegates to
// `trpcClient.githubPrReview.replyToComment.mutate`, the hoisted operation
// key is merged into the input, and the key rotation policy (real
// `isPrMutationRetryable` + `mapPrOperationError`) runs inside
// `mutationFn`. Only `useHoistedOperationKey` is mocked (it holds React
// ref state that needs a mounted renderer, covered by
// `operation-key.mounted.test.tsx`).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as OperationKeyModule from '@/lib/operation-key';
import { prIntentFingerprint } from '@kilocode/app-shared/pr-review';
import { useReplyToCommentMutation } from './use-review-discussion-mutations';

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
const replyMutateMock = vi.fn();
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
      listReviewThreads: { pathFilter: () => ['githubPrReview', 'listReviewThreads'] },
    },
  }),
  trpcClient: {
    githubPrReview: {
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      replyToComment: { mutate: (vars: unknown) => replyMutateMock(vars) },
    },
  },
}));

vi.mock('sonner-native', () => ({
  toast: { error: (msg: string) => toastErrorMock(msg) },
}));

const REPLY_INPUT = {
  owner: 'octocat',
  repo: 'hello',
  number: 1,
  commentId: 42,
  body: 'good point',
};

describe('useReplyToCommentMutation (P1-A-08c wiring)', () => {
  beforeEach(() => {
    lastCapturedOptions = null;
    replyMutateMock.mockReset();
    invalidateQueriesMock.mockReset();
    toastErrorMock.mockReset();
    hoistedKeys.getKey.mockClear();
    hoistedKeys.rotateKey.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('delegates the input to replyToComment.mutate and resolves the reply', async () => {
    const reply = { id: 43, htmlUrl: 'https://example.com' };
    replyMutateMock.mockResolvedValueOnce(reply);
    useReplyToCommentMutation();

    await expect(lastCapturedOptions?.mutationFn?.(REPLY_INPUT)).resolves.toEqual(reply);
    expect(replyMutateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'octocat',
        repo: 'hello',
        number: 1,
        commentId: 42,
        body: 'good point',
      })
    );
  });

  it('merges the hoisted operation key into the reply input (P1-A-08c)', async () => {
    replyMutateMock.mockResolvedValueOnce({ id: 43 });
    useReplyToCommentMutation();

    await lastCapturedOptions?.mutationFn?.(REPLY_INPUT);

    // The fingerprint is the dedupe identity the server hashes into
    // `resource_key` for 30 days. Pin the exact bytes: a drift in the shared
    // field list must fail here instead of silently rotating in-flight keys.
    expect(hoistedKeys.getKey).toHaveBeenCalledWith(
      '{"resource":["octocat","hello",1],"commentId":42,"body":"good point"}'
    );
    expect(replyMutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ operationKey: 'hoisted-op-key' })
    );
  });

  it('regenerates the key after a successful reply (fresh intent next)', async () => {
    replyMutateMock.mockResolvedValueOnce({ id: 43 });
    useReplyToCommentMutation();

    await lastCapturedOptions?.mutationFn?.(REPLY_INPUT);

    expect(hoistedKeys.rotateKey).toHaveBeenCalledTimes(1);
  });

  it('keeps the key on an in-progress CONFLICT and maps it onto the reply retryable copy', async () => {
    replyMutateMock.mockRejectedValueOnce(new Error('operation_in_progress'));
    useReplyToCommentMutation();

    await expect(lastCapturedOptions?.mutationFn?.(REPLY_INPUT)).rejects.toMatchObject({
      message: 'Could not reply.',
    });
    expect(hoistedKeys.rotateKey).not.toHaveBeenCalled();
  });

  it('regenerates the key on a non-retryable failure (bad-request ends the intent)', async () => {
    const badRequest = new Error('Comment is too long');
    Object.assign(badRequest, { data: { code: 'BAD_REQUEST' } });
    replyMutateMock.mockRejectedValueOnce(badRequest);
    useReplyToCommentMutation();

    await expect(lastCapturedOptions?.mutationFn?.(REPLY_INPUT)).rejects.toMatchObject({
      message: 'Comment is too long',
    });
    expect(hoistedKeys.rotateKey).toHaveBeenCalledTimes(1);
  });

  it('maps the ambiguous ledger marker onto the verify-before-retrying copy in onError', () => {
    useReplyToCommentMutation();
    lastCapturedOptions?.onError?.(new Error("Couldn't confirm — check the PR before retrying."));
    expect(toastErrorMock).toHaveBeenCalledWith("Couldn't confirm — check the PR before retrying.");
  });

  it('onError still toasts the message (so the retryable inline error surfaces)', () => {
    useReplyToCommentMutation();
    lastCapturedOptions?.onError?.(new Error('boom'));
    expect(toastErrorMock).toHaveBeenCalledWith('boom');
  });

  it('onSettled invalidates the listReviewThreads cache', async () => {
    useReplyToCommentMutation();

    await lastCapturedOptions?.onSettled?.();

    expect(invalidateQueriesMock).toHaveBeenCalledWith(['githubPrReview', 'listReviewThreads']);
  });
});

describe('reply_comment fingerprint (P1-A-08c changed-input)', () => {
  it('stays stable for a retry of the same reply and rotates when the body or target changes', () => {
    const original = prIntentFingerprint('reply_comment', REPLY_INPUT);
    expect(prIntentFingerprint('reply_comment', REPLY_INPUT)).toBe(original);

    const editedBody = prIntentFingerprint('reply_comment', {
      ...REPLY_INPUT,
      body: 'good point, edited',
    });
    expect(editedBody).not.toBe(original);

    const otherComment = prIntentFingerprint('reply_comment', {
      ...REPLY_INPUT,
      commentId: 43,
    });
    expect(otherComment).not.toBe(original);
  });
});
