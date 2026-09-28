// S7a mutation hooks for inline PR review comments and the pending-
// review batch submit, s6: provider-aware through the `providerReview` seam.
// The pattern mirrors the existing S8 merge mutations:
//   - `onError` toasts the message
//   - `onSettled` invalidates the PR review queries that the
//     mutation could have invalidated (overview `getPullRequest` for
//     `submitReview` because reviewDecision may flip; the thread list
//     for both because a new thread lands immediately)
//   - the sheet / composer ALSO renders inline errors because toasts
//     paint behind formSheets on iOS
//
// `createReviewComment` posts ONE comment immediately (no pending
// review). `submitReview` posts a BATCH — the composer enqueues
// comments into the `PendingReviewProvider` and the submit sheet
// drains that queue into one `submitReview` call. The submission
// uses the LATEST head SHA (per the S3 contract) regardless of what
// SHA each item was queued under; a per-item 422 surfaces inline.
//
// Provider arms (s6, anchored by c3): a GitLab MR or Bitbucket PR posts
// through `providerReview.addComment` / `providerReview.submitReview` with
// the REAL diff position (`anchor: { path, side, line, startLine? }`) and a
// real `comments` batch, so an inline comment lands on the line the user
// tapped. `formatPendingCommentBody` stays as the no-anchor fallback: a
// position-less body keeps the `path:L10–L20` text anchor. The GitHub arms
// stay byte-identical: same procedures, same inputs, same fingerprints.
//
// P1-A-08c: both hooks hoist one operation key per intent, so retries of the
// same intent dedupe on the server instead of re-executing the write. The
// ledger markers map onto the existing per-surface copy. The provider key
// fingerprint folds the s1 provider identity (platform + instance hint /
// workspace), so a GitLab comment and a same-named GitHub comment can never
// share a ledger key — the same bytes the server hashes into `resource_key`.

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { prIntentFingerprint } from '@kilocode/app-shared/pr-review';
import {
  type BitbucketPrRef,
  type GitLabMrRef,
  type ProviderPrRef,
} from '@kilocode/app-shared/provider-review';
import { type inferRouterInputs, type MobileRouter } from '@kilocode/trpc/mobile';

import { i18n } from '@/i18n';
import { announceForA11y } from '@/lib/a11y/announce';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { trpcClient, useTRPC } from '@/lib/trpc';
import { useHoistedOperationKey } from '@/lib/operation-key';
import {
  type ProviderPrScope,
  providerPrTriple,
  type ProviderPrTriple,
  useProviderPrScope,
} from '@/lib/pr-review/provider-pr-ref';
import {
  isPrMutationRetryable,
  mapPrOperationError,
  prOperationToastMessage,
} from '@/lib/pr-review/merge/pr-operation-ledger';

type PrRef = { owner: string; repo: string; number: number };

/** Any ref the review write hooks accept: the legacy triple or a provider ref. */
export type ReviewWriteRef = ProviderPrRef | PrRef;

/** The legacy triple behind any accepted ref. */
function reviewWriteTriple(ref: ReviewWriteRef): ProviderPrTriple {
  return 'platform' in ref ? providerPrTriple(ref) : ref;
}

/**
 * The provider write identity every `providerReview` mutation input carries.
 * Mirrors `providerIdentity()` in `provider-pr-queries.ts` exactly, so the
 * invalidation keys below hit the same cache entries the reads populate.
 */
export type ProviderWriteIdentity =
  | {
      platform: 'gitlab';
      projectPath: string;
      mrIid: number;
      instanceHint?: string;
      organizationId?: string;
    }
  | {
      platform: 'bitbucket';
      workspace: string;
      repoSlug: string;
      prId: number;
      organizationId: string;
    };

/** The mutation-side identity of one scope — the read-side twin, unchanged. */
export function providerWriteIdentity(scope: ProviderPrScope): ProviderWriteIdentity {
  const { ref, organizationId } = scope;
  if (ref.platform === 'gitlab') {
    return {
      platform: 'gitlab',
      projectPath: ref.projectPath,
      mrIid: ref.mrIid,
      ...(ref.instanceHint ? { instanceHint: ref.instanceHint } : {}),
      ...(organizationId ? { organizationId } : {}),
    };
  }
  return {
    platform: 'bitbucket',
    workspace: ref.platform === 'bitbucket' ? ref.workspace : '',
    repoSlug: ref.platform === 'bitbucket' ? ref.repoSlug : '',
    prId: ref.platform === 'bitbucket' ? ref.prId : 0,
    organizationId: organizationId ?? '',
  };
}

/**
 * The fingerprint input the server hashes into `resource_key`: the s1
 * provider identity fields (`gitlabFingerprintInput` /
 * `bitbucketFingerprintInput` in provider-review-router.ts) plus the
 * intent-defining fields. Field VALUES must match the server's — the
 * fingerprint is the dedupe identity, and a drift makes every same-key
 * retry fail with `operation_key_reuse_mismatch`.
 */
export function providerFingerprintInput(
  ref: GitLabMrRef | BitbucketPrRef,
  fields: Record<string, unknown>
) {
  if (ref.platform === 'gitlab') {
    return {
      platform: 'gitlab',
      projectPath: ref.projectPath,
      instanceHint: ref.instanceHint,
      number: ref.mrIid,
      ...fields,
    };
  }
  return {
    platform: 'bitbucket',
    workspace: ref.workspace,
    repoSlug: ref.repoSlug,
    number: ref.prId,
    ...fields,
  };
}

/**
 * The write scope: the caller's ref paired with the organization the live
 * provider scope publishes. On the GitHub route the context is absent and
 * the organization is null — exactly what the GitHub arms already sent.
 */
export function useReviewWriteScope(ref: ReviewWriteRef): ProviderPrScope {
  const scope = useProviderPrScope(reviewWriteTriple(ref));
  return 'platform' in ref ? { ref, organizationId: scope.organizationId } : scope;
}

function usePrRefKeys(scope: ProviderPrScope) {
  const trpc = useTRPC();
  if (scope.ref.platform === 'github') {
    const triple = providerPrTriple(scope.ref);
    return {
      getPullRequest: trpc.githubPrReview.getPullRequest.queryKey(triple),
      threadsPath: trpc.githubPrReview.listReviewThreads.pathFilter(),
    };
  }
  return {
    getPullRequest: trpc.providerReview.getPullRequest.queryKey(providerWriteIdentity(scope)),
    threadsPath: trpc.providerReview.listDiscussions.pathFilter(),
  };
}

async function invalidateReviewCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  keys: ReturnType<typeof usePrRefKeys>
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: keys.getPullRequest }),
    queryClient.invalidateQueries(keys.threadsPath),
  ]);
}

type RouterInputs = inferRouterInputs<MobileRouter>;

type CreateReviewCommentInput = RouterInputs['githubPrReview']['createReviewComment'];
export type SubmitReviewInput = RouterInputs['githubPrReview']['submitReview'];
export type SubmitReviewComment = NonNullable<SubmitReviewInput['comments']>[number];

/**
 * The real diff position a provider comment anchors to (c3): the line the
 * user tapped, with `startLine` marking the first line of a multi-line
 * range ending at `line`. Absent, the comment is a top-level note.
 */
type ProviderCommentAnchor = {
  path: string;
  side: 'LEFT' | 'RIGHT';
  line: number;
  startLine?: number;
};

/** The provider arms accept a body plus the optional real diff anchor. */
type ProviderCommentBody = { body: string; anchor?: ProviderCommentAnchor };
export type CreateReviewCommentVars = CreateReviewCommentInput | ProviderCommentBody;

/**
 * The no-anchor fallback body: when the composer has no real diff position,
 * the location rides in the text itself, in the same `path:L10–L20` format
 * the pending list shows.
 */
export function formatPendingCommentBody(item: {
  path: string;
  line: number;
  startLine?: number;
  body: string;
}): string {
  const location =
    item.startLine !== undefined && item.startLine !== item.line
      ? `${item.path}:L${item.startLine}–L${item.line}`
      : `${item.path}:L${item.line}`;
  return `${location}\n\n${item.body}`;
}

/** One anchored item in a provider `submitReview` batch (c3). */
type ProviderSubmitReviewComment = ProviderCommentAnchor & { body: string };

/**
 * The provider `submitReview` intent the submit sheet builds: every pending
 * item with a side rides the real `comments` batch; an item without one
 * keeps the text-anchored body (the no-anchor fallback). Empty body parts
 * are dropped, so an approve with a summary alone posts exactly the summary
 * and an approve with neither posts nothing. Comment items keep the router's
 * field order (path, side, line, startLine, body): the server hashes the
 * parsed batch into the `submit_review` fingerprint, and a key drift rotates
 * the dedupe identity.
 */
export function buildProviderSubmitInput(
  summary: string,
  items: readonly {
    path: string;
    side?: 'LEFT' | 'RIGHT';
    line: number;
    startLine?: number;
    body: string;
  }[]
) {
  const comments: ProviderSubmitReviewComment[] = [];
  const folded: string[] = [];
  for (const item of items) {
    if (item.side === undefined) {
      folded.push(formatPendingCommentBody(item));
    } else {
      const { path, side, line, startLine, body } = item;
      comments.push({ path, side, line, ...(startLine !== undefined ? { startLine } : {}), body });
    }
  }
  const body = [summary.trim(), ...folded].filter(part => part.length > 0).join('\n\n');
  return { body, comments };
}

/** The events the `providerReview.submitReview` input accepts. */
export type ProviderReviewEventOption = 'approve' | 'request_changes' | 'comment';
type ProviderSubmitReviewVars = {
  event: ProviderReviewEventOption;
  body?: string;
  comments?: ProviderSubmitReviewComment[];
};
export type SubmitReviewVars = SubmitReviewInput | ProviderSubmitReviewVars;

export function useCreateReviewCommentMutation(ref: ReviewWriteRef) {
  const queryClient = useQueryClient();
  const scope = useReviewWriteScope(ref);
  const keys = usePrRefKeys(scope);
  const { getKey, rotateKey } = useHoistedOperationKey();

  return useMutation({
    mutationFn: async (input: CreateReviewCommentVars) => {
      try {
        if (scope.ref.platform === 'github') {
          const vars = input as CreateReviewCommentInput;
          const result = await trpcClient.githubPrReview.createReviewComment.mutate({
            ...vars,
            operationKey: getKey(prIntentFingerprint('create_review_comment', vars)),
          });
          rotateKey();
          return result;
        }
        const vars = input as ProviderCommentBody;
        // The anchor rides the input AND the fingerprint: path/line/side/
        // startLine are s1 create_review_comment fields, so a retried
        // anchored comment dedupes and a moved position starts a fresh
        // intent. The anchor keys are exactly the fingerprint field names,
        // so the spread folds them FLAT the way the server's
        // gitlabFingerprintInput / bitbucketFingerprintInput does. Hoisted
        // off the call so the extra fields compile against the router input
        // type the client is typed against (provider-review-router.ts).
        const addCommentInput = {
          ...providerWriteIdentity(scope),
          body: vars.body,
          ...(vars.anchor ? { anchor: vars.anchor } : {}),
          operationKey: getKey(
            prIntentFingerprint(
              'create_review_comment',
              providerFingerprintInput(scope.ref, { body: vars.body, ...vars.anchor })
            )
          ),
        };
        const result = await trpcClient.providerReview.addComment.mutate(addCommentInput);
        rotateKey();
        return result;
      } catch (error) {
        if (!isPrMutationRetryable(error)) {
          rotateKey();
        }
        throw mapPrOperationError(error, 'create-comment');
      }
    },
    onSuccess: () => {
      // Bare success announcement beside the composer's existing success
      // effect (haptic + dismiss). The inline composer error box owns the
      // persistent inline error; the toast owns the failure announcement.
      announceForA11y(i18n.t('prReview.announce.commentPosted'));
    },
    onError: (error: { message: string }) => {
      announcingToast.error(prOperationToastMessage(error, 'create-comment'));
    },
    onSettled: async () => {
      await invalidateReviewCaches(queryClient, keys);
    },
  });
}

export function useSubmitReviewMutation(ref: ReviewWriteRef) {
  const queryClient = useQueryClient();
  const scope = useReviewWriteScope(ref);
  const keys = usePrRefKeys(scope);
  const { getKey, rotateKey } = useHoistedOperationKey();

  return useMutation({
    mutationFn: async (input: SubmitReviewVars) => {
      try {
        if (scope.ref.platform === 'github') {
          const vars = input as SubmitReviewInput;
          const result = await trpcClient.githubPrReview.submitReview.mutate({
            ...vars,
            operationKey: getKey(prIntentFingerprint('submit_review', vars)),
          });
          rotateKey();
          return result;
        }
        const vars = input as ProviderSubmitReviewVars;
        // An empty batch is no batch: the key and the input omit `comments`
        // together, so an event-only review keeps its pre-c3 bytes. The
        // batch rides the fingerprint exactly as the server folds the parsed
        // `comments` into the submit_review fingerprint. Hoisted off the
        // call so the batch compiles against the router input type the
        // client is typed against (provider-review-router.ts).
        const comments = vars.comments?.length ? vars.comments : undefined;
        const submitReviewInput = {
          ...providerWriteIdentity(scope),
          event: vars.event,
          ...(vars.body !== undefined && vars.body.length > 0 ? { body: vars.body } : {}),
          ...(comments ? { comments } : {}),
          operationKey: getKey(
            prIntentFingerprint(
              'submit_review',
              providerFingerprintInput(scope.ref, { event: vars.event, body: vars.body, comments })
            )
          ),
        };
        const result = await trpcClient.providerReview.submitReview.mutate(submitReviewInput);
        rotateKey();
        return result;
      } catch (error) {
        if (!isPrMutationRetryable(error)) {
          rotateKey();
        }
        throw mapPrOperationError(error, 'submit-review');
      }
    },
    onSuccess: () => {
      // Bare success announcement beside the submit sheet's existing
      // success effect (queue clear + haptic + dismiss).
      announceForA11y(i18n.t('prReview.announce.reviewSubmitted'));
    },
    onError: (error: { message: string }) => {
      announcingToast.error(prOperationToastMessage(error, 'submit-review'));
    },
    onSettled: async () => {
      await invalidateReviewCaches(queryClient, keys);
    },
  });
}
