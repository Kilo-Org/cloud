// P1-A-08c + s6 wiring tests for the discussion mutations.
//
// Replies are NOT optimistic (per the S7b contract): the comment is
// appended only after the server confirms. These tests assert the HOOK
// WIRING — `mutationFn` delegates to the matching
// `trpcClient.<router>.<procedure>.mutate`, the hoisted operation key is
// merged into the input, and the key rotation policy (real
// `isPrMutationRetryable` + `mapPrOperationError`) runs inside
// `mutationFn`. Only `useHoistedOperationKey` is mocked (it holds React
// ref state that needs a mounted renderer, covered by
// `operation-key.mounted.test.tsx`).
//
// s6: the GitHub arms stay byte-identical. The provider arms route the
// same intents through `providerReview.*` with the s1 provider identity
// (GitLab keys fold `instanceHint`, Bitbucket folds `workspace`), reply
// and resolve carry the ledger key, and the optimistic resolve flips the
// provider-shaped cache (`resolved`, not `isResolved`). Reactions stay
// GitHub-only: no provider exposes them through the seam.
/* eslint-disable max-lines -- one file for the reply wiring, the resolve/unresolve/reaction generation guard + chainSave/scope serialization, the real-MutationCache scope.id serialization suite, and the s6 provider arms */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as OperationKeyModule from '@/lib/operation-key';
import type * as ReactQuery from '@tanstack/react-query';
import { prIntentFingerprint } from '@kilocode/app-shared/pr-review';
import type * as ProviderPrRefModule from '@/lib/pr-review/provider-pr-ref';
import { type ProviderPrRef, type ProviderPrTriple } from '@/lib/pr-review/provider-pr-ref';
import {
  applyProviderResolveToggle,
  useAddReactionMutation,
  useRemoveReactionMutation,
  useReplyToCommentMutation,
  useResolveThreadMutation,
  useUnresolveThreadMutation,
} from './use-review-discussion-mutations';

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

// See the review-mutations test: the scope context hook is replaced by a
// settable override so the hooks run without a renderer. No-arg calls
// keep the pre-s6 GitHub fallback.
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
  onMutate?: (vars: unknown) => Promise<unknown> | unknown;
  onError?: (error: unknown, vars?: unknown, context?: unknown) => void;
  onSettled?: (data?: unknown, error?: unknown, vars?: unknown) => Promise<void> | void;
  scope?: { id: string };
};

function captureOptions(run: () => unknown): MutationOptions {
  lastCapturedOptions = null;
  run();
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!lastCapturedOptions) {
    throw new Error('mutation options not captured');
  }
  return lastCapturedOptions;
}

let lastCapturedOptions: MutationOptions | null = null;
const replyMutateMock = vi.fn();
const resolveMutateMock = vi.fn();
const unresolveMutateMock = vi.fn();
const providerReplyMutateMock = vi.fn();
const providerResolveMutateMock = vi.fn();
const providerUnresolveMutateMock = vi.fn();
const invalidateQueriesMock = vi.fn();
const cancelQueriesMock = vi.fn();
const getQueriesDataMock = vi.fn();
const setQueriesDataMock = vi.fn();
const setQueryDataMock = vi.fn();
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
    cancelQueries: (...args: unknown[]) => {
      cancelQueriesMock(...args);
    },
    getQueriesData: (...args: unknown[]) => getQueriesDataMock(...args),
    setQueriesData: (...args: unknown[]) => setQueriesDataMock(...args),
    setQueryData: (...args: unknown[]) => setQueryDataMock(...args),
  }),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    githubPrReview: {
      listReviewThreads: { pathFilter: () => ['githubPrReview', 'listReviewThreads'] },
      addReaction: { mutationOptions: (opts: MutationOptions) => opts },
      removeReaction: { mutationOptions: (opts: MutationOptions) => opts },
    },
    providerReview: {
      listDiscussions: { pathFilter: () => ['providerReview', 'listDiscussions'] },
    },
  }),
  trpcClient: {
    githubPrReview: {
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      replyToComment: { mutate: (vars: unknown) => replyMutateMock(vars) },
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      resolveThread: { mutate: (vars: unknown) => resolveMutateMock(vars) },
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      unresolveThread: { mutate: (vars: unknown) => unresolveMutateMock(vars) },
    },
    providerReview: {
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      replyToComment: { mutate: (vars: unknown) => providerReplyMutateMock(vars) },
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      resolveThread: { mutate: (vars: unknown) => providerResolveMutateMock(vars) },
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      unresolveThread: { mutate: (vars: unknown) => providerUnresolveMutateMock(vars) },
    },
  },
}));

vi.mock('sonner-native', () => ({
  toast: { error: (msg: string) => toastErrorMock(msg) },
}));

// Rolldown (Vitest's bundler) cannot parse React Native's Flow source.
// The s6 provider helpers live in `use-pr-review-mutations`, which imports
// `announcingToast` -> `announce.ts` -> `react-native`. Mock only the
// symbols `announce.ts` imports so the module graph loads under Node.
vi.mock('react-native', () => ({
  AccessibilityInfo: {
    announceForAccessibility: vi.fn(),
    setAccessibilityFocus: vi.fn(),
  },
  findNodeHandle: vi.fn(() => null),
}));

const REPLY_INPUT = {
  owner: 'octocat',
  repo: 'hello',
  number: 1,
  commentId: 42,
  body: 'good point',
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

function resetMocks() {
  lastCapturedOptions = null;
  scopeOverride = null;
  replyMutateMock.mockReset();
  resolveMutateMock.mockReset();
  unresolveMutateMock.mockReset();
  providerReplyMutateMock.mockReset();
  providerResolveMutateMock.mockReset();
  providerUnresolveMutateMock.mockReset();
  invalidateQueriesMock.mockReset();
  cancelQueriesMock.mockReset();
  getQueriesDataMock.mockReset();
  setQueriesDataMock.mockReset();
  setQueryDataMock.mockReset();
  toastErrorMock.mockReset();
  hoistedKeys.getKey.mockClear();
  hoistedKeys.rotateKey.mockClear();
}

describe('useReplyToCommentMutation (P1-A-08c wiring)', () => {
  beforeEach(() => {
    resetMocks();
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

describe('useReplyToCommentMutation (s6 provider arms)', () => {
  beforeEach(() => {
    resetMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('gitlab: replies inside the discussion through providerReview.replyToComment', async () => {
    scopeOverride = { ref: GITLAB_REF, organizationId: 'org-9' };
    providerReplyMutateMock.mockResolvedValueOnce({ done: true, replayed: false });
    useReplyToCommentMutation(GITLAB_REF);

    await expect(
      lastCapturedOptions?.mutationFn?.({ threadId: 'd-1', commentNodeId: 'c-1', body: 'ok' })
    ).resolves.toEqual({ done: true, replayed: false });
    expect(replyMutateMock).not.toHaveBeenCalled();
    expect(providerReplyMutateMock).toHaveBeenCalledWith({
      ...GITLAB_IDENTITY,
      discussionId: 'd-1',
      body: 'ok',
      operationKey: 'hoisted-op-key',
    });
    // GitLab keys fold the instance hint and use the DISCUSSION id as the
    // fingerprint commentId (mirrors the server's reply fingerprint input).
    expect(hoistedKeys.getKey).toHaveBeenCalledWith(
      '{"resource":["gitlab","https://gl.example.com","group/sub/app",12],"commentId":"d-1","body":"ok"}'
    );
  });

  it('bitbucket: replies attach to the parent comment id, keyed by workspace', async () => {
    scopeOverride = { ref: BITBUCKET_REF, organizationId: 'org-9' };
    providerReplyMutateMock.mockResolvedValueOnce({ done: true, replayed: false });
    useReplyToCommentMutation(BITBUCKET_REF);

    await lastCapturedOptions?.mutationFn?.({ threadId: '9', commentNodeId: 'c-1', body: 'ok' });
    expect(providerReplyMutateMock).toHaveBeenCalledWith({
      ...BITBUCKET_IDENTITY,
      commentId: 'c-1',
      body: 'ok',
      operationKey: 'hoisted-op-key',
    });
    expect(hoistedKeys.getKey).toHaveBeenCalledWith(
      '{"resource":["bitbucket","acme","widgets",77],"commentId":"c-1","body":"ok"}'
    );
  });

  it('onSettled invalidates the provider discussions cache', async () => {
    scopeOverride = { ref: GITLAB_REF, organizationId: 'org-9' };
    useReplyToCommentMutation(GITLAB_REF);

    await lastCapturedOptions?.onSettled?.();

    expect(invalidateQueriesMock).toHaveBeenCalledWith(['providerReview', 'listDiscussions']);
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

describe('useResolveThreadMutation (generation guard + chainSave)', () => {
  beforeEach(() => {
    resetMocks();
  });

  it('wraps the tRPC call in chainSave keyed by threadId (rule 3) and adds no scope.id', async () => {
    resolveMutateMock.mockResolvedValue({ threadId: 't1', isResolved: true });
    useResolveThreadMutation();
    const opts = lastCapturedOptions;
    if (!opts) {
      throw new Error('resolve options not captured');
    }

    await opts.mutationFn?.({ threadId: 't1' });
    expect(resolveMutateMock).toHaveBeenCalledWith({ threadId: 't1' });
    expect(opts.scope).toBeUndefined();
  });

  it('serializes two resolves for the same thread (second mutationFn starts after the first settles)', async () => {
    useResolveThreadMutation();
    const opts = lastCapturedOptions;
    if (!opts) {
      throw new Error('resolve options not captured');
    }

    const gate = Promise.withResolvers<{ threadId: string; isResolved: boolean }>();
    resolveMutateMock
      .mockReturnValueOnce(gate.promise)
      .mockResolvedValueOnce({ threadId: 't1', isResolved: true });

    const first = opts.mutationFn?.({ threadId: 't1' });
    const second = opts.mutationFn?.({ threadId: 't1' });

    await Promise.resolve();
    await Promise.resolve();
    expect(resolveMutateMock).toHaveBeenCalledTimes(1);

    gate.resolve({ threadId: 't1', isResolved: true });
    await Promise.all([first, second]);
    expect(resolveMutateMock).toHaveBeenCalledTimes(2);
  });

  it('a failing older resolve does not roll back while a newer reaction owns the threads cache', async () => {
    const resolveOpts = captureOptions(() => useResolveThreadMutation());
    const reactionOpts = captureOptions(() => useAddReactionMutation('t2'));

    getQueriesDataMock
      .mockReturnValueOnce([['k1', { pages: [] }]])
      .mockReturnValueOnce([['k2', { pages: [] }]]);

    const older = await resolveOpts.onMutate?.({ threadId: 't1' });
    const newer = await reactionOpts.onMutate?.({ commentNodeId: 'c1', content: 'THUMBS_UP' });

    setQueryDataMock.mockClear();
    resolveOpts.onError?.(new Error('boom'), { threadId: 't1' }, older);
    // The older resolve's rollback must not restore its snapshot over the
    // newer reaction's optimistic write to the same procedure-wide cache.
    expect(setQueryDataMock).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith('boom');

    reactionOpts.onError?.(new Error('boom'), { commentNodeId: 'c1', content: 'THUMBS_UP' }, newer);
    expect(setQueryDataMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).toHaveBeenCalledWith('boom');
  });

  it('a failing latest resolve rolls back its snapshot and toasts', async () => {
    useResolveThreadMutation();
    const opts = lastCapturedOptions;
    if (!opts) {
      throw new Error('resolve options not captured');
    }

    getQueriesDataMock.mockReturnValueOnce([['k1', { pages: [] }]]);
    const context = await opts.onMutate?.({ threadId: 't1' });

    setQueryDataMock.mockClear();
    opts.onError?.(new Error('boom'), { threadId: 't1' }, context);
    expect(setQueryDataMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).toHaveBeenCalledWith('boom');
  });
});

describe('useResolveThreadMutation / useUnresolveThreadMutation (s6 provider arms)', () => {
  beforeEach(() => {
    resetMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('gitlab: resolves by discussion id with the ledger key and instance-scoped fingerprint', async () => {
    scopeOverride = { ref: GITLAB_REF, organizationId: 'org-9' };
    providerResolveMutateMock.mockResolvedValueOnce({ done: true, replayed: false });
    useResolveThreadMutation(GITLAB_REF);

    await expect(lastCapturedOptions?.mutationFn?.({ threadId: 'd-1' })).resolves.toEqual({
      done: true,
      replayed: false,
    });
    expect(resolveMutateMock).not.toHaveBeenCalled();
    expect(providerResolveMutateMock).toHaveBeenCalledWith({
      ...GITLAB_IDENTITY,
      discussionId: 'd-1',
      operationKey: 'hoisted-op-key',
    });
    expect(hoistedKeys.getKey).toHaveBeenCalledWith(
      '{"resource":["gitlab","https://gl.example.com","group/sub/app",12],"threadId":"d-1"}'
    );
  });

  it('bitbucket: unresolves by thread id with the workspace-scoped fingerprint', async () => {
    scopeOverride = { ref: BITBUCKET_REF, organizationId: 'org-9' };
    providerUnresolveMutateMock.mockResolvedValueOnce({ done: true, replayed: false });
    useUnresolveThreadMutation(BITBUCKET_REF);

    await lastCapturedOptions?.mutationFn?.({ threadId: 'c-9' });
    expect(providerUnresolveMutateMock).toHaveBeenCalledWith({
      ...BITBUCKET_IDENTITY,
      threadId: 'c-9',
      operationKey: 'hoisted-op-key',
    });
    expect(hoistedKeys.getKey).toHaveBeenCalledWith(
      '{"resource":["bitbucket","acme","widgets",77],"threadId":"c-9"}'
    );
  });

  it('optimistically flips the provider-shaped cache (resolved, not isResolved) and rolls back on failure', async () => {
    scopeOverride = { ref: GITLAB_REF, organizationId: 'org-9' };
    providerResolveMutateMock.mockRejectedValueOnce(new Error('boom'));
    useResolveThreadMutation(GITLAB_REF);
    const opts = lastCapturedOptions;
    if (!opts) {
      throw new Error('resolve options not captured');
    }

    const cached = {
      pages: [
        {
          threads: [
            { threadId: 'd-1', resolved: false },
            { threadId: 'd-2', resolved: false },
          ],
          nextCursor: null,
        },
      ],
    };
    getQueriesDataMock.mockReturnValueOnce([['k1', cached]]);
    const context = await opts.onMutate?.({ threadId: 'd-1' });

    const updater = setQueriesDataMock.mock.calls[0]?.[1] as (old: unknown) => typeof cached;
    expect(updater(cached).pages[0]?.threads).toEqual([
      { threadId: 'd-1', resolved: true },
      { threadId: 'd-2', resolved: false },
    ]);

    setQueryDataMock.mockClear();
    await expect(opts.mutationFn?.({ threadId: 'd-1' })).rejects.toBeInstanceOf(Error);
    opts.onError?.(new Error('boom'), { threadId: 'd-1' }, context);
    expect(setQueryDataMock).toHaveBeenCalledWith('k1', cached);
    expect(toastErrorMock).toHaveBeenCalledWith('boom');
  });

  it('onSettled invalidates the provider discussions cache', async () => {
    scopeOverride = { ref: GITLAB_REF, organizationId: 'org-9' };
    useResolveThreadMutation(GITLAB_REF);

    await lastCapturedOptions?.onSettled?.();

    expect(invalidateQueriesMock).toHaveBeenCalledWith(['providerReview', 'listDiscussions']);
  });
});

describe('applyProviderResolveToggle (s6 optimistic reducer)', () => {
  it('flips only the matching thread across every cached page', () => {
    const pages = {
      pages: [
        { threads: [{ threadId: 'a', resolved: false }], nextCursor: 'p2' },
        {
          threads: [
            { threadId: 'b', resolved: false },
            { threadId: 'c', resolved: true },
          ],
          nextCursor: null,
        },
      ],
    };
    const next = applyProviderResolveToggle(pages, 'b', true);
    expect(next?.pages[0]?.threads).toEqual([{ threadId: 'a', resolved: false }]);
    expect(next?.pages[1]?.threads).toEqual([
      { threadId: 'b', resolved: true },
      { threadId: 'c', resolved: true },
    ]);
  });

  it('passes an undefined cache through untouched', () => {
    expect(applyProviderResolveToggle(undefined, 'b', true)).toBeUndefined();
  });
});

describe('useUnresolveThreadMutation (generation guard + chainSave)', () => {
  beforeEach(() => {
    resetMocks();
  });

  it('wraps the tRPC call in chainSave keyed by threadId and adds no scope.id', async () => {
    unresolveMutateMock.mockResolvedValue({ threadId: 't1', isResolved: false });
    useUnresolveThreadMutation();
    const opts = lastCapturedOptions;
    if (!opts) {
      throw new Error('unresolve options not captured');
    }

    await opts.mutationFn?.({ threadId: 't1' });
    expect(unresolveMutateMock).toHaveBeenCalledWith({ threadId: 't1' });
    expect(opts.scope).toBeUndefined();
  });

  it('a failing latest unresolve rolls back its snapshot and toasts', async () => {
    useUnresolveThreadMutation();
    const opts = lastCapturedOptions;
    if (!opts) {
      throw new Error('unresolve options not captured');
    }

    getQueriesDataMock.mockReturnValueOnce([['k1', { pages: [] }]]);
    const context = await opts.onMutate?.({ threadId: 't1' });

    setQueryDataMock.mockClear();
    opts.onError?.(new Error('boom'), { threadId: 't1' }, context);
    expect(setQueryDataMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).toHaveBeenCalledWith('boom');
  });
});

describe('useAddReactionMutation (generation guard + scope.id)', () => {
  beforeEach(() => {
    resetMocks();
  });

  it('scopes the mutation per thread from the hook closure (rule 2)', () => {
    useAddReactionMutation('t1');
    expect(lastCapturedOptions?.scope).toEqual({ id: 'pr-thread:t1' });
  });

  it('a failing latest reaction rolls back its snapshot and toasts', async () => {
    useAddReactionMutation('t1');
    const opts = lastCapturedOptions;
    if (!opts) {
      throw new Error('reaction options not captured');
    }

    getQueriesDataMock.mockReturnValueOnce([['k1', { pages: [] }]]);
    const context = await opts.onMutate?.({ commentNodeId: 'c1', content: 'THUMBS_UP' });

    setQueryDataMock.mockClear();
    opts.onError?.(new Error('boom'), { commentNodeId: 'c1', content: 'THUMBS_UP' }, context);
    expect(setQueryDataMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).toHaveBeenCalledWith('boom');
  });
});

describe('useRemoveReactionMutation (generation guard + scope.id)', () => {
  beforeEach(() => {
    resetMocks();
  });

  it('scopes the mutation per thread from the hook closure (rule 2)', () => {
    useRemoveReactionMutation('t1');
    expect(lastCapturedOptions?.scope).toEqual({ id: 'pr-thread:t1' });
  });

  it('a failing latest reaction removal rolls back its snapshot and toasts', async () => {
    useRemoveReactionMutation('t1');
    const opts = lastCapturedOptions;
    if (!opts) {
      throw new Error('reaction options not captured');
    }

    getQueriesDataMock.mockReturnValueOnce([['k1', { pages: [] }]]);
    const context = await opts.onMutate?.({ commentNodeId: 'c1', content: 'THUMBS_UP' });

    setQueryDataMock.mockClear();
    opts.onError?.(new Error('boom'), { commentNodeId: 'c1', content: 'THUMBS_UP' }, context);
    expect(setQueryDataMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).toHaveBeenCalledWith('boom');
  });
});

describe('scope.id network serialization (real MutationCache)', () => {
  it('starts the second same-scope mutationFn only after the first settles', async () => {
    const { MutationCache, QueryClient } =
      await vi.importActual<typeof ReactQuery>('@tanstack/react-query');
    const cache = new MutationCache();
    const client = new QueryClient({ mutationCache: cache });
    const order: string[] = [];
    const gate = Promise.withResolvers<null>();

    const first = cache.build(client, {
      mutationFn: async () => {
        order.push('first-start');
        await gate.promise;
        order.push('first-end');
        return 'first';
      },
      scope: { id: 'pr-thread:t1' },
    });
    const second = cache.build(client, {
      // eslint-disable-next-line require-await, typescript-eslint/require-await -- MutationFunction requires a Promise return
      mutationFn: async () => {
        order.push('second-start');
        return 'second';
      },
      scope: { id: 'pr-thread:t1' },
    });

    const p1 = first.execute({});
    const p2 = second.execute({});
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['first-start']);

    gate.resolve(null);
    await Promise.all([p1, p2]);
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
  });
});
