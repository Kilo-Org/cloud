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

import { useTRPC } from '@/lib/trpc';

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

async function invalidateDiscussionCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  keys: ReturnType<typeof useDiscussionKeys>
): Promise<void> {
  await queryClient.invalidateQueries(keys.listReviewThreadsPath);
}

// ── Reply (not optimistic) ────────────────────────────────────────────

export function useReplyToCommentMutation() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const keys = useDiscussionKeys();

  return useMutation(
    trpc.githubPrReview.replyToComment.mutationOptions({
      onError: (error: { message: string }) => {
        toast.error(error.message);
      },
      onSettled: async () => {
        await invalidateDiscussionCaches(queryClient, keys);
      },
    })
  );
}

// ── Resolve / unresolve (optimistic) ──────────────────────────────────

export function useResolveThreadMutation() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const keys = useDiscussionKeys();

  return useMutation(
    trpc.githubPrReview.resolveThread.mutationOptions({
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      onMutate: async ({ threadId }) => {
        await queryClient.cancelQueries(keys.listReviewThreadsPath);
        const previous = queryClient.getQueriesData<ReviewThreadsInfiniteData>(
          keys.listReviewThreadsPath
        );
        queryClient.setQueriesData<ReviewThreadsInfiniteData>(keys.listReviewThreadsPath, old =>
          applyResolveToggle(old, threadId, true)
        );
        return { previous };
      },
      onError: (error, _input, context) => {
        const previous = context?.previous;
        if (previous) {
          for (const [key, data] of previous) {
            queryClient.setQueryData<ReviewThreadsInfiniteData>(key, data);
          }
        }
        toast.error(error.message);
      },
      onSettled: async () => {
        await invalidateDiscussionCaches(queryClient, keys);
      },
    })
  );
}

export function useUnresolveThreadMutation() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const keys = useDiscussionKeys();

  return useMutation(
    trpc.githubPrReview.unresolveThread.mutationOptions({
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      onMutate: async ({ threadId }) => {
        await queryClient.cancelQueries(keys.listReviewThreadsPath);
        const previous = queryClient.getQueriesData<ReviewThreadsInfiniteData>(
          keys.listReviewThreadsPath
        );
        queryClient.setQueriesData<ReviewThreadsInfiniteData>(keys.listReviewThreadsPath, old =>
          applyResolveToggle(old, threadId, false)
        );
        return { previous };
      },
      onError: (error, _input, context) => {
        const previous = context?.previous;
        if (previous) {
          for (const [key, data] of previous) {
            queryClient.setQueryData<ReviewThreadsInfiniteData>(key, data);
          }
        }
        toast.error(error.message);
      },
      onSettled: async () => {
        await invalidateDiscussionCaches(queryClient, keys);
      },
    })
  );
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

  return useMutation(
    trpc.githubPrReview.addReaction.mutationOptions({
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      onMutate: async ({ commentNodeId, content }) => {
        await queryClient.cancelQueries(keys.listReviewThreadsPath);
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
        return { previous };
      },
      onError: (error, _input, context) => {
        const previous = context?.previous;
        if (previous) {
          for (const [key, data] of previous) {
            queryClient.setQueryData<ReviewThreadsInfiniteData>(key, data);
          }
        }
        toast.error(error.message);
      },
      onSettled: async () => {
        await invalidateDiscussionCaches(queryClient, keys);
      },
    })
  );
}

export function useRemoveReactionMutation(threadId: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const keys = useDiscussionKeys();

  return useMutation(
    trpc.githubPrReview.removeReaction.mutationOptions({
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      onMutate: async ({ commentNodeId, content }) => {
        await queryClient.cancelQueries(keys.listReviewThreadsPath);
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
        return { previous };
      },
      onError: (error, _input, context) => {
        const previous = context?.previous;
        if (previous) {
          for (const [key, data] of previous) {
            queryClient.setQueryData<ReviewThreadsInfiniteData>(key, data);
          }
        }
        toast.error(error.message);
      },
      onSettled: async () => {
        await invalidateDiscussionCaches(queryClient, keys);
      },
    })
  );
}
