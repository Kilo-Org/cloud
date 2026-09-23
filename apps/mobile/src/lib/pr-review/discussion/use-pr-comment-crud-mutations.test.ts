// Wiring suite for the own-comment update / delete mutations, in the style of
// `use-review-discussion-mutations.test.ts`: mock `@/lib/trpc`, capture the
// `useMutation` options, and drive each callback directly. The hooks are
// unledgered, so there is no operation-key assertion here; the tests pin the
// optimistic reducer wiring, the rollback + classified toast, and the settle
// invalidation.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  commentCrudFailure,
  useDeletePrCommentMutation,
  useUpdatePrCommentMutation,
} from './use-pr-comment-crud-mutations';

const THREADS_PATH = ['githubPrReview', 'listReviewThreads'];

const hoistedToast = vi.hoisted(() => ({ error: vi.fn() }));
const hoistedAnnounce = vi.hoisted(() => ({ announceForA11y: vi.fn() }));

vi.mock('@/lib/a11y/announcing-toast', () => ({ announcingToast: hoistedToast }));
vi.mock('@/lib/a11y/announce', () => ({ announceForA11y: hoistedAnnounce.announceForA11y }));

type MutationOptions = {
  mutationFn?: (vars: unknown) => Promise<unknown>;
  onMutate?: (vars: unknown) => Promise<unknown> | unknown;
  onSuccess?: (data?: unknown, vars?: unknown) => void;
  onError?: (error: unknown, vars?: unknown, context?: unknown) => void;
  onSettled?: () => Promise<void> | void;
};

let lastCapturedOptions: MutationOptions | null = null;
const updateCommentMutateMock = vi.fn();
const deleteCommentMutateMock = vi.fn();
const invalidateQueriesMock = vi.fn();
const cancelQueriesMock = vi.fn();
const getQueriesDataMock = vi.fn();
const setQueriesDataMock = vi.fn();
const setQueryDataMock = vi.fn();

vi.mock('@tanstack/react-query', () => ({
  useMutation: (opts: MutationOptions) => {
    lastCapturedOptions = opts;
    return { mutateAsync: vi.fn(), mutate: vi.fn() };
  },
  useQueryClient: () => ({
    invalidateQueries: (...args: unknown[]) => invalidateQueriesMock(...args),
    cancelQueries: (...args: unknown[]) => cancelQueriesMock(...args),
    getQueriesData: (...args: unknown[]) => getQueriesDataMock(...args),
    setQueriesData: (...args: unknown[]) => setQueriesDataMock(...args),
    setQueryData: (...args: unknown[]) => setQueryDataMock(...args),
  }),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    githubPrReview: {
      listReviewThreads: { pathFilter: () => THREADS_PATH },
    },
  }),
  trpcClient: {
    githubPrReview: {
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      updateComment: { mutate: (vars: unknown) => updateCommentMutateMock(vars) },
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      deleteComment: { mutate: (vars: unknown) => deleteCommentMutateMock(vars) },
    },
  },
}));

const UPDATE_INPUT = {
  owner: 'octocat',
  repo: 'hello',
  number: 1,
  commentId: 2,
  kind: 'review' as const,
  body: 'edited body',
};

const DELETE_INPUT = {
  owner: 'octocat',
  repo: 'hello',
  number: 1,
  commentId: 2,
  kind: 'review' as const,
};

type Cache = {
  pages: {
    threads: {
      threadId: string;
      comments: { commentId: number; nodeId: string; bodyMarkdown: string }[];
    }[];
    conversation: { commentId: number; nodeId: string; bodyMarkdown: string }[];
    nextCursor: string | null;
  }[];
  pageParams: (string | null)[];
};

function makeCache(): Cache {
  return {
    pages: [
      {
        threads: [
          {
            threadId: 'T1',
            comments: [
              { commentId: 1, nodeId: 'C1', bodyMarkdown: 'hello' },
              { commentId: 2, nodeId: 'C2', bodyMarkdown: 'reply' },
            ],
          },
        ],
        conversation: [{ commentId: 900, nodeId: 'IC900', bodyMarkdown: 'issue' }],
        nextCursor: null,
      },
    ],
    pageParams: [null],
  };
}

function resetMocks() {
  lastCapturedOptions = null;
  updateCommentMutateMock.mockReset();
  deleteCommentMutateMock.mockReset();
  invalidateQueriesMock.mockReset();
  cancelQueriesMock.mockReset();
  getQueriesDataMock.mockReset();
  setQueriesDataMock.mockReset();
  setQueryDataMock.mockReset();
  hoistedToast.error.mockReset();
  hoistedAnnounce.announceForA11y.mockReset();
}

describe('useUpdatePrCommentMutation', () => {
  beforeEach(() => {
    resetMocks();
  });

  it('delegates the exact input to updateComment.mutate', async () => {
    const result = { commentId: 2, nodeId: 'C2', body: 'edited body' };
    updateCommentMutateMock.mockResolvedValueOnce(result);
    useUpdatePrCommentMutation();

    await expect(lastCapturedOptions?.mutationFn?.(UPDATE_INPUT)).resolves.toEqual(result);
    expect(updateCommentMutateMock).toHaveBeenCalledWith(UPDATE_INPUT);
  });

  it('writes the new body into the cached comment optimistically', async () => {
    useUpdatePrCommentMutation();
    const cache = makeCache();
    getQueriesDataMock.mockReturnValueOnce([['k1', cache]]);

    await lastCapturedOptions?.onMutate?.(UPDATE_INPUT);

    expect(cancelQueriesMock).toHaveBeenCalledWith(THREADS_PATH);
    const updater = setQueriesDataMock.mock.calls[0]?.[1] as (old: Cache) => Cache;
    const next = updater(cache);
    expect(next.pages[0]?.threads[0]?.comments[1]?.bodyMarkdown).toBe('edited body');
    expect(next.pages[0]?.threads[0]?.comments[0]?.bodyMarkdown).toBe('hello');
    expect(cache.pages[0]?.threads[0]?.comments[1]?.bodyMarkdown).toBe('reply');
  });

  it('rolls back the snapshot and toasts the retryable edit copy on failure', async () => {
    useUpdatePrCommentMutation();
    const cache = makeCache();
    getQueriesDataMock.mockReturnValueOnce([['k1', cache]]);
    const context = await lastCapturedOptions?.onMutate?.(UPDATE_INPUT);

    lastCapturedOptions?.onError?.(new Error('boom'), UPDATE_INPUT, context);

    expect(setQueryDataMock).toHaveBeenCalledWith('k1', cache);
    expect(hoistedToast.error).toHaveBeenCalledWith(
      "Couldn't save your comment. Check your connection and try again."
    );
  });

  it('toasts the terminal edit copy for a bad-request failure', () => {
    useUpdatePrCommentMutation();
    const badRequest = new Error('Comment is too long');
    Object.assign(badRequest, { data: { code: 'BAD_REQUEST' } });

    lastCapturedOptions?.onError?.(badRequest, UPDATE_INPUT, undefined);

    expect(hoistedToast.error).toHaveBeenCalledWith(
      "This comment can't be edited. It may have been deleted."
    );
    expect(setQueryDataMock).not.toHaveBeenCalled();
  });

  it('onSuccess announces the updated copy for a11y', () => {
    useUpdatePrCommentMutation();
    lastCapturedOptions?.onSuccess?.();
    expect(hoistedAnnounce.announceForA11y).toHaveBeenCalledWith('Comment updated');
  });

  it('onSettled invalidates the listReviewThreads cache', async () => {
    useUpdatePrCommentMutation();
    await lastCapturedOptions?.onSettled?.();
    expect(invalidateQueriesMock).toHaveBeenCalledWith(THREADS_PATH);
  });
});

describe('useDeletePrCommentMutation', () => {
  beforeEach(() => {
    resetMocks();
  });

  it('delegates the exact input to deleteComment.mutate', async () => {
    const result = { commentId: 2, deleted: true };
    deleteCommentMutateMock.mockResolvedValueOnce(result);
    useDeletePrCommentMutation();

    await expect(lastCapturedOptions?.mutationFn?.(DELETE_INPUT)).resolves.toEqual(result);
    expect(deleteCommentMutateMock).toHaveBeenCalledWith(DELETE_INPUT);
  });

  it('removes the comment from the cache optimistically', async () => {
    useDeletePrCommentMutation();
    const cache = makeCache();
    getQueriesDataMock.mockReturnValueOnce([['k1', cache]]);

    await lastCapturedOptions?.onMutate?.(DELETE_INPUT);

    const updater = setQueriesDataMock.mock.calls[0]?.[1] as (old: Cache) => Cache;
    const next = updater(cache);
    expect(next.pages[0]?.threads[0]?.comments.map(comment => comment.commentId)).toEqual([1]);
    expect(cache.pages[0]?.threads[0]?.comments).toHaveLength(2);
  });

  it('rolls back the snapshot and toasts the retryable delete copy on failure', async () => {
    useDeletePrCommentMutation();
    const cache = makeCache();
    getQueriesDataMock.mockReturnValueOnce([['k1', cache]]);
    const context = await lastCapturedOptions?.onMutate?.(DELETE_INPUT);

    lastCapturedOptions?.onError?.(new Error('boom'), DELETE_INPUT, context);

    expect(setQueryDataMock).toHaveBeenCalledWith('k1', cache);
    expect(hoistedToast.error).toHaveBeenCalledWith(
      "Couldn't delete your comment. Check your connection and try again."
    );
  });

  it('toasts the terminal delete copy for a forbidden failure', () => {
    useDeletePrCommentMutation();
    const forbidden = new Error('nope');
    Object.assign(forbidden, { data: { code: 'FORBIDDEN' } });

    lastCapturedOptions?.onError?.(forbidden, DELETE_INPUT, undefined);

    expect(hoistedToast.error).toHaveBeenCalledWith("This comment can't be deleted.");
  });

  it('onSuccess announces the deleted copy for a11y', () => {
    useDeletePrCommentMutation();
    lastCapturedOptions?.onSuccess?.();
    expect(hoistedAnnounce.announceForA11y).toHaveBeenCalledWith('Comment deleted');
  });

  it('onSettled invalidates the listReviewThreads cache', async () => {
    useDeletePrCommentMutation();
    await lastCapturedOptions?.onSettled?.();
    expect(invalidateQueriesMock).toHaveBeenCalledWith(THREADS_PATH);
  });
});

describe('commentCrudFailure', () => {
  it('classifies a generic failure as retryable on the edit surface', () => {
    expect(commentCrudFailure(new Error('boom'), 'edit')).toEqual({
      kind: 'retryable',
      message: "Couldn't save your comment. Check your connection and try again.",
    });
  });

  it('classifies a bad request as terminal on the edit surface', () => {
    const badRequest = new Error('bad');
    Object.assign(badRequest, { data: { code: 'BAD_REQUEST' } });
    expect(commentCrudFailure(badRequest, 'edit')).toEqual({
      kind: 'terminal',
      message: "This comment can't be edited. It may have been deleted.",
    });
  });

  it('classifies a reconnect failure as retryable on the delete surface', () => {
    const expired = new Error('expired');
    Object.assign(expired, { data: { code: 'UNAUTHORIZED' } });
    expect(commentCrudFailure(expired, 'delete')).toEqual({
      kind: 'retryable',
      message: "Couldn't delete your comment. Check your connection and try again.",
    });
  });

  it('classifies a terms-required failure as retryable on the delete surface', () => {
    const terms = new Error('terms');
    Object.assign(terms, { data: { code: 'PRECONDITION_FAILED', message: 'terms_required' } });
    expect(commentCrudFailure(terms, 'delete')).toEqual({
      kind: 'retryable',
      message: "Couldn't delete your comment. Check your connection and try again.",
    });
  });

  it('classifies a forbidden failure as terminal on the delete surface', () => {
    const forbidden = new Error('forbidden');
    Object.assign(forbidden, { data: { code: 'FORBIDDEN' } });
    expect(commentCrudFailure(forbidden, 'delete')).toEqual({
      kind: 'terminal',
      message: "This comment can't be deleted.",
    });
  });
});
