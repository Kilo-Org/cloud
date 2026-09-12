/* eslint-disable max-lines -- the reply, resolve-toggle, and reaction suites share one mutation harness for the discussion seam */
// Discussion-tab mutations for the PR review surface, s6: provider-aware
// through the `providerReview` seam.
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
//                                thread's resolved flag in the cached
//                                threads infinite query (GitHub's
//                                `listReviewThreads`, a provider's
//                                `listDiscussions`), snapshots the
//                                previous data in `onMutate`, and rolls
//                                it back in `onError`. `onSettled`
//                                invalidates the path so a re-fetch
//                                reconciles with the server's eventual
//                                state.
//
//   - `addReaction` /
//     `removeReaction`        — OPTIMISTIC. Same pattern as resolve,
//                                but the reducer walks into a specific
//                                comment inside a specific thread to
//                                flip `count` + `viewerHasReacted`.
//                                Invalidates on settle. GitHub-only:
//                                no provider exposes reactions through
//                                the seam (the capability flag gates
//                                the affordance in `CommentRow`).
//
// Provider arms (s6): every hook takes an optional `ProviderPrRef`. The
// discussion tree passes none and the hooks read the live provider scope
// from context, so the non-provider surface keeps the exact GitHub-shaped
// calls it made before. The thread id is provider-native on every arm
// (`ProviderPrThread.threadId` is GitLab's discussion id and Bitbucket's
// root-comment id verbatim), so `{threadId}` vars work unchanged; the
// reply vars additionally carry the provider comment id (`nodeId`) for
// Bitbucket, whose replies attach to a parent comment, not a thread.
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
import { type ProviderPrRef } from '@kilocode/app-shared/provider-review';

import {
  isLatestMutationGeneration,
  nextMutationGeneration,
} from '@/lib/hooks/mutation-generations';
import { chainSave } from '@/lib/hooks/save-chain';
import {
  type ProviderPrScope,
  providerPrTriple,
  useProviderPrScope,
} from '@/lib/pr-review/provider-pr-ref';
import {
  providerFingerprintInput,
  providerWriteIdentity,
} from '@/lib/pr-review/use-pr-review-mutations';
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

/** One page of provider threads, at the runtime shape the read layer caches. */
type ProviderThreadsPage = {
  threads: { threadId: string; resolved: boolean }[];
  nextCursor: string | null;
};

/** The infinite container the provider threads query caches the pages in. */
type ProviderThreadsCache = {
  pages: ProviderThreadsPage[];
};

/** Flip one provider thread's resolved flag across the cached pages. */
export function applyProviderResolveToggle<T extends ProviderThreadsPage>(
  pages: { pages: T[] } | undefined,
  threadId: string,
  resolved: boolean
): { pages: T[] } | undefined {
  if (!pages) {
    return pages;
  }
  return {
    ...pages,
    pages: pages.pages.map(page =>
      page.threads.some(thread => thread.threadId === threadId)
        ? {
            ...page,
            threads: page.threads.map(thread =>
              thread.threadId === threadId ? { ...thread, resolved } : thread
            ),
          }
        : page
    ),
  };
}

/**
 * The scope the discussion write runs under. With an explicit ref the
 * caller's organization (from the live provider scope) rides along; with
 * none the GitHub-shaped fallback keeps the pre-s6 behavior byte-for-byte.
 */
function useDiscussionScope(ref?: ProviderPrRef): ProviderPrScope {
  const scope = useProviderPrScope(
    ref ? providerPrTriple(ref) : { owner: '', repo: '', number: 0 }
  );
  return ref ? { ref, organizationId: scope.organizationId } : scope;
}

// Every discussion mutation snapshots the same procedure-wide
// `listReviewThreads` cache through its path filter, so one shared generation
// key guards all rollbacks across resolve/unresolve/reaction writes.
function useGithubDiscussionKeys() {
  const trpc = useTRPC();
  return {
    threadsPath: trpc.githubPrReview.listReviewThreads.pathFilter(),
    generationKey: 'githubPrReview.listReviewThreads',
  };
}

function useDiscussionKeys(scope: ProviderPrScope) {
  const trpc = useTRPC();
  if (scope.ref.platform === 'github') {
    return {
      threadsPath: trpc.githubPrReview.listReviewThreads.pathFilter(),
      generationKey: 'githubPrReview.listReviewThreads',
    };
  }
  return {
    threadsPath: trpc.providerReview.listDiscussions.pathFilter(),
    generationKey: 'providerReview.listDiscussions',
  };
}

async function invalidateDiscussionCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  keys: ReturnType<typeof useDiscussionKeys>
): Promise<void> {
  await queryClient.invalidateQueries(keys.threadsPath);
}

// ── Reply (not optimistic) ────────────────────────────────────────────

type ReplyToCommentInput = {
  owner: string;
  repo: string;
  number: number;
  commentId: number;
  body: string;
};

/**
 * The provider reply vars: `threadId` is the GitLab discussion id (GitLab
 * replies land inside a discussion); `commentNodeId` is the provider
 * comment id Bitbucket attaches a reply to. Both carry the provider-native
 * string ids the read layer keeps in `threadId` / `nodeId`.
 */
type ProviderReplyVars = {
  threadId: string;
  commentNodeId: string;
  body: string;
};
export type ReplyVars = ReplyToCommentInput | ProviderReplyVars;

export function useReplyToCommentMutation(ref?: ProviderPrRef) {
  const queryClient = useQueryClient();
  const scope = useDiscussionScope(ref);
  const keys = useDiscussionKeys(scope);
  const { getKey, rotateKey } = useHoistedOperationKey();

  return useMutation({
    mutationFn: async (input: ReplyVars) => {
      try {
        if (scope.ref.platform === 'github') {
          const vars = input as ReplyToCommentInput;
          const result = await trpcClient.githubPrReview.replyToComment.mutate({
            ...vars,
            operationKey: getKey(prIntentFingerprint('reply_comment', vars)),
          });
          rotateKey();
          return result;
        }
        const vars = input as ProviderReplyVars;
        const commentId = scope.ref.platform === 'gitlab' ? vars.threadId : vars.commentNodeId;
        const operationKey = getKey(
          prIntentFingerprint(
            'reply_comment',
            providerFingerprintInput(scope.ref, { commentId, body: vars.body })
          )
        );
        // One call per platform arm: a conditional spread inside a single
        // literal would cross-multiply the identity union with the id
        // union and hand the server gitlab+commentId shapes.
        const identity = providerWriteIdentity(scope);
        const result =
          identity.platform === 'gitlab'
            ? await trpcClient.providerReview.replyToComment.mutate({
                ...identity,
                discussionId: vars.threadId,
                body: vars.body,
                operationKey,
              })
            : await trpcClient.providerReview.replyToComment.mutate({
                ...identity,
                commentId: vars.commentNodeId,
                body: vars.body,
                operationKey,
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

/**
 * The optimistic resolve/unresolve write. The GitHub arm keeps the exact
 * pre-s6 call (no operation key — the GitHub thread procedures are not
 * ledgered); the provider arms ledger the write with the s1 provider
 * fingerprint and flip the provider-shaped cache (`resolved`, not
 * `isResolved`).
 */
function useResolveToggleMutation(
  ref: ProviderPrRef | undefined,
  resolved: boolean,
  mutateGithub: (vars: { threadId: string }) => Promise<void>
) {
  const queryClient = useQueryClient();
  const scope = useDiscussionScope(ref);
  const keys = useDiscussionKeys(scope);
  const { getKey, rotateKey } = useHoistedOperationKey();

  // onError policy: roll back the onMutate snapshot (latest generation only)
  // and toast error.message.
  return useMutation({
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    mutationFn: (vars: { threadId: string }) =>
      // The GitHub arm keeps the pre-s6 chainSave key so its serialization is
      // unchanged; provider keys fold the platform to stay disjoint.
      chainSave(
        scope.ref.platform === 'github'
          ? `pr-thread:${vars.threadId}`
          : `pr-thread:${scope.ref.platform}:${vars.threadId}`,
        async () => {
          if (scope.ref.platform === 'github') {
            return mutateGithub(vars);
          }
          try {
            const input = providerResolveInput(scope, {
              threadId: vars.threadId,
              resolve: resolved,
              getKey,
            });
            const result = resolved
              ? await trpcClient.providerReview.resolveThread.mutate(input)
              : await trpcClient.providerReview.unresolveThread.mutate(input);
            rotateKey();
            return result;
          } catch (error) {
            if (!isPrMutationRetryable(error)) {
              rotateKey();
            }
            throw mapPrOperationError(error, 'reply');
          }
        }
      ),
    onMutate: async ({ threadId }) => {
      await queryClient.cancelQueries(keys.threadsPath);
      const generation = nextMutationGeneration(keys.generationKey);
      if (scope.ref.platform === 'github') {
        const previous = queryClient.getQueriesData<ReviewThreadsInfiniteData>(keys.threadsPath);
        queryClient.setQueriesData<ReviewThreadsInfiniteData>(keys.threadsPath, old =>
          applyResolveToggle(old, threadId, resolved)
        );
        return { previous, generation };
      }
      const previous = queryClient.getQueriesData<ProviderThreadsCache>(keys.threadsPath);
      queryClient.setQueriesData<ProviderThreadsCache>(keys.threadsPath, old =>
        applyProviderResolveToggle(old, threadId, resolved)
      );
      return { previous, generation };
    },
    onError: (error, _input, context) => {
      if (context?.previous && isLatestMutationGeneration(keys.generationKey, context.generation)) {
        for (const [key, data] of context.previous) {
          queryClient.setQueryData(key, data);
        }
      }
      toast.error(error.message);
    },
    onSettled: async () => {
      await invalidateDiscussionCaches(queryClient, keys);
    },
  });
}

/** The provider `resolveThread` / `unresolveThread` input for one thread. */
function providerResolveInput(
  scope: ProviderPrScope,
  args: {
    threadId: string;
    resolve: boolean;
    getKey: (fingerprint: string) => string;
  }
) {
  const { threadId, resolve, getKey } = args;
  const identity = providerWriteIdentity(scope);
  const intent = resolve ? 'resolve_thread' : 'unresolve_thread';
  // The fingerprint rides the platform-narrowed identity: its gitlab/
  // bitbucket arms carry exactly the s1 ref fields the server hashes.
  const fingerprint = providerFingerprintInput(identity, { threadId });
  if (identity.platform === 'gitlab') {
    return {
      ...identity,
      discussionId: threadId,
      operationKey: getKey(prIntentFingerprint(intent, fingerprint)),
    };
  }
  return {
    ...identity,
    threadId,
    operationKey: getKey(prIntentFingerprint(intent, fingerprint)),
  };
}

export function useResolveThreadMutation(ref?: ProviderPrRef) {
  return useResolveToggleMutation(ref, true, async vars => {
    await trpcClient.githubPrReview.resolveThread.mutate(vars);
  });
}

export function useUnresolveThreadMutation(ref?: ProviderPrRef) {
  return useResolveToggleMutation(ref, false, async vars => {
    await trpcClient.githubPrReview.unresolveThread.mutate(vars);
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
  const keys = useGithubDiscussionKeys();

  // onError policy: roll back the onMutate snapshot (latest generation only)
  // and toast error.message.
  return useMutation(
    trpc.githubPrReview.addReaction.mutationOptions({
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      onMutate: async ({ commentNodeId, content }) => {
        await queryClient.cancelQueries(keys.threadsPath);
        const generation = nextMutationGeneration(keys.generationKey);
        const previous = queryClient.getQueriesData<ReviewThreadsInfiniteData>(keys.threadsPath);
        queryClient.setQueriesData<ReviewThreadsInfiniteData>(keys.threadsPath, old =>
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
          isLatestMutationGeneration(keys.generationKey, context.generation)
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
  const keys = useGithubDiscussionKeys();

  // onError policy: roll back the onMutate snapshot (latest generation only)
  // and toast error.message.
  return useMutation(
    trpc.githubPrReview.removeReaction.mutationOptions({
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      onMutate: async ({ commentNodeId, content }) => {
        await queryClient.cancelQueries(keys.threadsPath);
        const generation = nextMutationGeneration(keys.generationKey);
        const previous = queryClient.getQueriesData<ReviewThreadsInfiniteData>(keys.threadsPath);
        queryClient.setQueriesData<ReviewThreadsInfiniteData>(keys.threadsPath, old =>
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
          isLatestMutationGeneration(keys.generationKey, context.generation)
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
