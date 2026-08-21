// Discussion-tab mutations for the PR review surface.
//
//   - `replyToComment`        — NOT optimistic (per S7b contract):
//                                the comment is appended only after the
//                                server confirms, and the list is
//                                invalidated on settle so the next
//                                render includes the new comment.
//                                The mutation hook toasts `onError` and
//                                the inline reply input keeps its own
//                                error state so the user can retry.
//
//   - `resolveThread` /
//     `unresolveThread`       — OPTIMISTIC. The reducer flips the
//                                thread's `isResolved` in the cached
//                                `listReviewThreads` infinite query,
//                                snapshots the previous data in
//                                `onMutate`, and rolls it back in
//                                `onError`. `onSettled` invalidates the
//                                path so a re-fetch reconciles with
//                                the server's eventual state.
//
//   - `addReaction` /
//     `removeReaction`        — OPTIMISTIC. Same pattern as resolve,
//                                but the reducer walks into a specific
//                                comment inside a specific thread to
//                                flip `count` + `viewerHasReacted`.
//                                Invalidates on settle.
//
// Why we do NOT coalesce these into the existing
// `useCreateReviewCommentMutation` / `useSubmitReviewMutation` hooks:
// those are the inline / pending-review path; discussion replies and
// reactions are independent mutations on already-posted comments, so
// they belong in their own hook (and their own file) to keep the
// queryKey surface area narrow.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import { prIntentFingerprint } from '@kilocode/app-shared/pr-review';

import {
  isLatestMutationGeneration,
  nextMutationGeneration,
} from '@/lib/hooks/mutation-generations';
import { chainSave } from '@/lib/hooks/save-chain';
import { trpcClient, useTRPC } from '@/lib/trpc';
import { useHoistedOperationKey } from '@/lib/operation-key';
import {
  isPrMutationRetryable,
  mapPrOperationError,
  prOperationToastMessage,
} from '@/lib/pr-review/merge/pr-operation-ledger';

import {
  applyReactionToggle,
  applyResolveToggle,
  type ReviewReactionContent,
  type ReviewThreadsInfiniteData,
} from './review-discussion-types';

function useDiscussionKeys() {
  const trpc = useTRPC();
  return {
    listReviewThreadsPath: trpc.githubPrReview.listReviewThreads.pathFilter(),
  };
}

// Every discussion mutation snapshots the same procedure-wide
// `listReviewThreads` cache through its path filter, so one shared generation
// key guards all rollbacks across resolve/unresolve/reaction writes.
const LIST_REVIEW_THREADS_GENERATION_KEY = 'githubPrReview.listReviewThreads';

async function invalidateDiscussionCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  keys: ReturnType<typeof useDiscussionKeys>
): Promise<void> {
  await queryClient.invalidateQueries(keys.listReviewThreadsPath);
}

// ── Reply (not optimistic) ────────────────────────────────────────────

export type ReplyToCommentInput = {
  owner: string;
  repo: string;
  number: number;
  commentId: number;
  body: string;
};

export function useReplyToCommentMutation() {
  const queryClient = useQueryClient();
  const keys = useDiscussionKeys();
  const { getKey, rotateKey } = useHoistedOperationKey();

  return useMutation({
    mutationFn: async (input: ReplyToCommentInput) => {
      try {
        const result = await trpcClient.githubPrReview.replyToComment.mutate({
          ...input,
          operationKey: getKey(prIntentFingerprint('reply_comment', input)),
        });
        rotateKey();
        return result;
      } catch (error) {
        if (!isPrMutationRetryable(error)) {
          rotateKey();
        }
        throw mapPrOperationError(error, 'reply');
      }
    },
    onError: (error: { message: string }) => {
      toast.error(prOperationToastMessage(error, 'reply'));
    },
    onSettled: async () => {
      await invalidateDiscussionCaches(queryClient, keys);
    },
  });
}

// ── Resolve / unresolve (optimistic) ──────────────────────────────────

export function useResolveThreadMutation() {
  const queryClient = useQueryClient();
  const keys = useDiscussionKeys();

  // onError policy: roll back the onMutate snapshot (latest generation only)
  // and toast error.message.
  return useMutation({
    mutationFn: (vars: { threadId: string }) =>
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      chainSave(`pr-thread:${vars.threadId}`, () =>
        trpcClient.githubPrReview.resolveThread.mutate(vars)
      ),
    onMutate: async ({ threadId }) => {
      await queryClient.cancelQueries(keys.listReviewThreadsPath);
      const generation = nextMutationGeneration(LIST_REVIEW_THREADS_GENERATION_KEY);
      const previous = queryClient.getQueriesData<ReviewThreadsInfiniteData>(
        keys.listReviewThreadsPath
      );
      queryClient.setQueriesData<ReviewThreadsInfiniteData>(keys.listReviewThreadsPath, old =>
        applyResolveToggle(old, threadId, true)
      );
      return { previous, generation };
    },
    onError: (error, _input, context) => {
      if (
        context?.previous &&
        isLatestMutationGeneration(LIST_REVIEW_THREADS_GENERATION_KEY, context.generation)
      ) {
        for (const [key, data] of context.previous) {
          queryClient.setQueryData<ReviewThreadsInfiniteData>(key, data);
        }
      }
      toast.error(error.message);
    },
    onSettled: async () => {
      await invalidateDiscussionCaches(queryClient, keys);
    },
  });
}

export function useUnresolveThreadMutation() {
  const queryClient = useQueryClient();
  const keys = useDiscussionKeys();

  // onError policy: roll back the onMutate snapshot (latest generation only)
  // and toast error.message.
  return useMutation({
    mutationFn: (vars: { threadId: string }) =>
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      chainSave(`pr-thread:${vars.threadId}`, () =>
        trpcClient.githubPrReview.unresolveThread.mutate(vars)
      ),
    onMutate: async ({ threadId }) => {
      await queryClient.cancelQueries(keys.listReviewThreadsPath);
      const generation = nextMutationGeneration(LIST_REVIEW_THREADS_GENERATION_KEY);
      const previous = queryClient.getQueriesData<ReviewThreadsInfiniteData>(
        keys.listReviewThreadsPath
      );
      queryClient.setQueriesData<ReviewThreadsInfiniteData>(keys.listReviewThreadsPath, old =>
        applyResolveToggle(old, threadId, false)
      );
      return { previous, generation };
    },
    onError: (error, _input, context) => {
      if (
        context?.previous &&
        isLatestMutationGeneration(LIST_REVIEW_THREADS_GENERATION_KEY, context.generation)
      ) {
        for (const [key, data] of context.previous) {
          queryClient.setQueryData<ReviewThreadsInfiniteData>(key, data);
        }
      }
      toast.error(error.message);
    },
    onSettled: async () => {
      await invalidateDiscussionCaches(queryClient, keys);
    },
  });
}

// ── Reactions (optimistic) ────────────────────────────────────────────

// The reaction mutation DTO only carries `{commentNodeId, content}`. The
// optimistic cache walk also needs the owning `threadId`, which is NOT a DTO
// field — so the hook is constructed PER THREAD and closes over `threadId`
// (the caller passes only the DTO fields to `.mutate`).
export function useAddReactionMutation(threadId: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const keys = useDiscussionKeys();

  // onError policy: roll back the onMutate snapshot (latest generation only)
  // and toast error.message.
  return useMutation(
    trpc.githubPrReview.addReaction.mutationOptions({
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      onMutate: async ({ commentNodeId, content }) => {
        await queryClient.cancelQueries(keys.listReviewThreadsPath);
        const generation = nextMutationGeneration(LIST_REVIEW_THREADS_GENERATION_KEY);
        const previous = queryClient.getQueriesData<ReviewThreadsInfiniteData>(
          keys.listReviewThreadsPath
        );
        queryClient.setQueriesData<ReviewThreadsInfiniteData>(keys.listReviewThreadsPath, old =>
          applyReactionToggle({
            data: old,
            threadId,
            commentNodeId,
            content: content as ReviewReactionContent,
          })
        );
        return { previous, generation };
      },
      onError: (error, _input, context) => {
        if (
          context?.previous &&
          isLatestMutationGeneration(LIST_REVIEW_THREADS_GENERATION_KEY, context.generation)
        ) {
          for (const [key, data] of context.previous) {
            queryClient.setQueryData<ReviewThreadsInfiniteData>(key, data);
          }
        }
        toast.error(error.message);
      },
      onSettled: async () => {
        await invalidateDiscussionCaches(queryClient, keys);
      },
      // The reaction DTO carries only {commentNodeId, content}; the owning
      // threadId comes from the hook closure, so scope.id serializes network
      // calls per thread (rule 2).
      scope: { id: `pr-thread:${threadId}` },
    })
  );
}

export function useRemoveReactionMutation(threadId: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const keys = useDiscussionKeys();

  // onError policy: roll back the onMutate snapshot (latest generation only)
  // and toast error.message.
  return useMutation(
    trpc.githubPrReview.removeReaction.mutationOptions({
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      onMutate: async ({ commentNodeId, content }) => {
        await queryClient.cancelQueries(keys.listReviewThreadsPath);
        const generation = nextMutationGeneration(LIST_REVIEW_THREADS_GENERATION_KEY);
        const previous = queryClient.getQueriesData<ReviewThreadsInfiniteData>(
          keys.listReviewThreadsPath
        );
        queryClient.setQueriesData<ReviewThreadsInfiniteData>(keys.listReviewThreadsPath, old =>
          applyReactionToggle({
            data: old,
            threadId,
            commentNodeId,
            content: content as ReviewReactionContent,
          })
        );
        return { previous, generation };
      },
      onError: (error, _input, context) => {
        if (
          context?.previous &&
          isLatestMutationGeneration(LIST_REVIEW_THREADS_GENERATION_KEY, context.generation)
        ) {
          for (const [key, data] of context.previous) {
            queryClient.setQueryData<ReviewThreadsInfiniteData>(key, data);
          }
        }
        toast.error(error.message);
      },
      onSettled: async () => {
        await invalidateDiscussionCaches(queryClient, keys);
      },
      // The reaction DTO carries only {commentNodeId, content}; the owning
      // threadId comes from the hook closure, so scope.id serializes network
      // calls per thread (rule 2).
      scope: { id: `pr-thread:${threadId}` },
    })
  );
}
