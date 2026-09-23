// Comment update / delete mutations for the PR review Discussion tab.
//
// These are the OWN-comment write path for already-posted comments:
//
//   - `useUpdatePrCommentMutation()` — edit a posted comment's body.
//   - `useDeletePrCommentMutation()` — delete a posted comment.
//
// Both are OPTIMISTIC and UNLEDGERED, unlike the reply / resolve / reaction
// hooks in `use-review-discussion-mutations.ts`:
//
//   - No `operationKey` and no `useHoistedOperationKey`: the two writes are
//     idempotent server-side. An edit that replays produces the same body, and
//     a delete whose first response was lost is treated as success (GitHub
//     404s an already-deleted comment, which the router maps to
//     `{ deleted: true }`). A retry needs no dedupe identity, so no ledger key
//     rides the input and `pr-operation-ledger.ts` is untouched.
//
//   - The reducer runs on `onMutate`, the snapshot is restored on `onError`,
//     and `onSettled` invalidates the list so a re-fetch reconciles with the
//     server's eventual state.
//
// GitHub-only: the two procedures live on `githubPrReview` only (GitLab and
// Bitbucket have no note-edit seam), so the UI slices withhold the affordance
// on the provider arms.

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { i18n } from '@/i18n';
import { announceForA11y } from '@/lib/a11y/announce';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { classifyPrReviewMutationError } from '@/lib/pr-review/classify-pr-review-query-state';
import { trpcClient, useTRPC } from '@/lib/trpc';

import {
  applyCommentBodyUpdate,
  applyCommentRemoval,
  type PrCommentKind,
  type ReviewThreadsInfiniteData,
} from './review-discussion-types';

export type UpdatePrCommentInput = {
  owner: string;
  repo: string;
  number: number;
  commentId: number;
  kind: PrCommentKind;
  body: string;
};

export type DeletePrCommentInput = {
  owner: string;
  repo: string;
  number: number;
  commentId: number;
  kind: PrCommentKind;
};

/** The two surfaces that own a comment write failure. */
export type CommentCrudSurface = 'edit' | 'delete';

/** Terminal failures must not be retried; everything else is retryable. */
export type CommentCrudFailure =
  | { kind: 'terminal'; message: string }
  | { kind: 'retryable'; message: string };

const RETRYABLE_KEYS = {
  edit: 'prReview.discussion.commentEditFailed',
  delete: 'prReview.discussion.commentDeleteFailed',
} as const satisfies Record<CommentCrudSurface, string>;

const TERMINAL_KEYS = {
  edit: 'prReview.discussion.commentEditUnavailable',
  delete: 'prReview.discussion.commentDeleteUnavailable',
} as const satisfies Record<CommentCrudSurface, string>;

// Classifications the user can recover from by trying again (or by fixing the
// connection / accepting the terms first). Everything else — a bad request or
// a permanent permission error — is terminal.
const RETRYABLE_CLASSIFICATIONS: ReadonlySet<string> = new Set([
  'retryable',
  'reconnect',
  'terms-required',
]);

/**
 * Toast copy for a comment update / delete failure. Mirrors
 * `moderationFailure`: a retryable / reconnect / terms-required failure gets
 * the surface's retryable copy, every other classification the surface's
 * terminal copy.
 */
export function commentCrudFailure(
  error: unknown,
  surface: CommentCrudSurface
): CommentCrudFailure {
  const { kind } = classifyPrReviewMutationError(error);
  if (RETRYABLE_CLASSIFICATIONS.has(kind)) {
    return { kind: 'retryable', message: i18n.t(RETRYABLE_KEYS[surface]) };
  }
  return { kind: 'terminal', message: i18n.t(TERMINAL_KEYS[surface]) };
}

// Every comment mutation snapshots the same procedure-wide `listReviewThreads`
// cache through its path filter, exactly like the resolve / reaction hooks.
function useCommentCrudKeys() {
  const trpc = useTRPC();
  return trpc.githubPrReview.listReviewThreads.pathFilter();
}

/**
 * Edit a posted comment the viewer owns. Optimistic: the cached body is
 * replaced on `onMutate`, the snapshot restored on `onError`, and the list
 * invalidated on settle.
 */
export function useUpdatePrCommentMutation() {
  const queryClient = useQueryClient();
  const threadsPath = useCommentCrudKeys();

  return useMutation({
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    mutationFn: (input: UpdatePrCommentInput) =>
      trpcClient.githubPrReview.updateComment.mutate(input),
    onMutate: async (input: UpdatePrCommentInput) => {
      await queryClient.cancelQueries(threadsPath);
      const previous = queryClient.getQueriesData<ReviewThreadsInfiniteData>(threadsPath);
      queryClient.setQueriesData<ReviewThreadsInfiniteData>(threadsPath, old =>
        applyCommentBodyUpdate(old, {
          kind: input.kind,
          commentId: input.commentId,
          body: input.body,
        })
      );
      return { previous };
    },
    onSuccess: () => {
      announceForA11y(i18n.t('prReview.announce.commentUpdated'));
    },
    onError: (error, _input, context) => {
      for (const [key, data] of context?.previous ?? []) {
        queryClient.setQueryData(key, data);
      }
      announcingToast.error(commentCrudFailure(error, 'edit').message);
    },
    onSettled: () => {
      // Fire-and-forget, like the discussion hooks: a blocked/offline network
      // hangs the refetch the invalidation triggers, and an awaited
      // invalidation would pin the settle on that hang.
      void queryClient.invalidateQueries(threadsPath);
    },
  });
}

/**
 * Delete a posted comment the viewer owns. Optimistic: the row (or the whole
 * review thread, when the root comment goes) is removed on `onMutate`, the
 * snapshot restored on `onError`, and the list invalidated on settle.
 */
export function useDeletePrCommentMutation() {
  const queryClient = useQueryClient();
  const threadsPath = useCommentCrudKeys();

  return useMutation({
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    mutationFn: (input: DeletePrCommentInput) =>
      trpcClient.githubPrReview.deleteComment.mutate(input),
    onMutate: async (input: DeletePrCommentInput) => {
      await queryClient.cancelQueries(threadsPath);
      const previous = queryClient.getQueriesData<ReviewThreadsInfiniteData>(threadsPath);
      queryClient.setQueriesData<ReviewThreadsInfiniteData>(threadsPath, old =>
        applyCommentRemoval(old, { kind: input.kind, commentId: input.commentId })
      );
      return { previous };
    },
    onSuccess: () => {
      announceForA11y(i18n.t('prReview.announce.commentDeleted'));
    },
    onError: (error, _input, context) => {
      for (const [key, data] of context?.previous ?? []) {
        queryClient.setQueryData(key, data);
      }
      announcingToast.error(commentCrudFailure(error, 'delete').message);
    },
    onSettled: () => {
      void queryClient.invalidateQueries(threadsPath);
    },
  });
}
