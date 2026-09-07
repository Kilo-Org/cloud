/**
 * Bitbucket Cloud pull-request WRITE layer for the provider review surfaces.
 *
 * Every mutation resolves credentials through bitbucket-authorization (the
 * workspace identity and token are server-derived), fences against the
 * caller's expected head sha where a revision matters, and returns an
 * idempotent-ready `{ done, replayed }` result: `replayed` is true when the
 * provider already holds the target state, so the s4 router can run the call
 * through the operation ledger without a duplicate effect. `operationKey` is
 * accepted for that ledger; this layer performs no ledger writes itself.
 */
import 'server-only';

import { z } from 'zod';
import type { ProviderReviewCapabilities } from '@kilocode/app-shared/provider-review';
import { BITBUCKET_REVIEW_CAPABILITIES } from '@kilocode/app-shared/provider-review';
import {
  authorizeRepository,
  classifyBitbucketError,
  BitbucketReviewError,
  type BitbucketRepositoryAccess,
  type BitbucketReviewOwner,
} from './bitbucket-authorization';
import { fetchPage, requestBitbucketJson, repositoryPathGuard } from './bitbucket-read';

/**
 * The Bitbucket capability list for review surfaces. It reuses the shared
 * s1 constant: auto-merge and reactions are explicit provider limitations,
 * never missing code, and request-changes IS a Bitbucket review event.
 */
export const BITBUCKET_PR_REVIEW_CAPABILITIES: ProviderReviewCapabilities =
  BITBUCKET_REVIEW_CAPABILITIES;

/**
 * The exact reason auto-merge is refused: Bitbucket Cloud has no merge-when-
 * ready API, so callers show this instead of a fake scheduling affordance.
 */
export const BITBUCKET_AUTO_MERGE_UNSUPPORTED_REASON =
  BITBUCKET_REVIEW_CAPABILITIES.autoMerge.reason;

/** The exact reason reactions are refused on Bitbucket Cloud. */
export const BITBUCKET_REACTIONS_UNSUPPORTED_REASON =
  BITBUCKET_REVIEW_CAPABILITIES.reactions.reason;

/**
 * The exact reason thread resolution is refused when the thread has no task:
 * Bitbucket Cloud only exposes resolution through comment tasks.
 */
export const BITBUCKET_THREAD_RESOLUTION_UNSUPPORTED_REASON =
  'Bitbucket Cloud does not expose thread resolution for inline threads without tasks';

/**
 * The stale-head fence reason, shared with classifyBitbucketStatus so a
 * locally detected moved head and a provider 409 read identically on mobile.
 */
export const BITBUCKET_STALE_HEAD_REASON =
  'The pull request changed since it was loaded. Reload the pull request and try again.';

/** The PR a write acts on. */
export type BitbucketPrTarget = {
  owner: BitbucketReviewOwner;
  workspace: string;
  repoSlug: string;
  prId: number;
};

/** Every mutation accepts the router's ledger key and reports its outcome. */
export type BitbucketMutationInput = { operationKey?: string };

export type BitbucketMutationResult = {
  done: boolean;
  /** True when the provider already held the target state — nothing changed. */
  replayed: boolean;
};

const BitbucketCurrentUserSchema = z.object({ uuid: z.string().min(1) });

const BitbucketPullRequestWriteSchema = z.object({
  id: z.number(),
  state: z.enum(['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED']),
  source: z
    .object({
      commit: z
        .object({ hash: z.string().min(1) })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});

/**
 * The comment fetch is an existence check only: Bitbucket comment payloads
 * carry no task count, so thread resolution never reads one.
 */
const BitbucketCommentWriteSchema = z.object({
  id: z.number(),
});

const BitbucketTaskWriteSchema = z.object({
  id: z.number(),
  resolved_on: z.string().nullable().optional(),
  comment: z.object({ id: z.number() }).nullable().optional(),
});

/** The task collection walk when resolving a thread: bound the page follow. */
const MAX_TASK_COLLECTION_PAGES = 10;

function prPath(access: BitbucketRepositoryAccess, prId: number): string {
  return `/2.0/repositories/${encodeURIComponent(access.workspace.slug)}/${encodeURIComponent(access.repository.slug)}/pullrequests/${prId}`;
}

async function targetAccess(target: BitbucketPrTarget): Promise<BitbucketRepositoryAccess> {
  return authorizeRepository(target.owner, target.workspace, target.repoSlug);
}

/**
 * The connected identity's account id — the participant id Bitbucket matches
 * review states against. Resolved from the workspace access token itself, so
 * it is always the identity the provider will act as.
 */
async function ownAccountId(access: BitbucketRepositoryAccess): Promise<string> {
  const user = BitbucketCurrentUserSchema.parse(
    await requestBitbucketJson<unknown>(access, '/2.0/user')
  );
  return user.uuid;
}

/** Post a top-level comment on the pull request. */
export async function addComment(
  target: BitbucketPrTarget & { body: string } & BitbucketMutationInput
): Promise<BitbucketMutationResult> {
  const access = await targetAccess(target);
  try {
    await requestBitbucketJson(access, `${prPath(access, target.prId)}/comments`, {
      method: 'POST',
      body: { content: { raw: target.body } },
    });
    return { done: true, replayed: false };
  } catch (error) {
    throw classifyBitbucketError(error);
  }
}

/** Reply inside an existing comment thread. */
export async function replyToComment(
  target: BitbucketPrTarget & { commentId: string; body: string } & BitbucketMutationInput
): Promise<BitbucketMutationResult> {
  const parentId = Number(target.commentId);
  if (!Number.isInteger(parentId) || parentId <= 0) {
    throw new BitbucketReviewError('bad_request', 'The comment to reply to could not be found.');
  }
  const access = await targetAccess(target);
  try {
    await requestBitbucketJson(access, `${prPath(access, target.prId)}/comments`, {
      method: 'POST',
      body: { content: { raw: target.body }, parent: { id: parentId } },
    });
    return { done: true, replayed: false };
  } catch (error) {
    throw classifyBitbucketError(error);
  }
}

/**
 * Submit a review. `approve` → PUT participants/{account_id} with
 * `state: 'approved'`; `request_changes` → `state: 'changes_requested'`;
 * `comment` → clear the caller's own approval state. An optional body is
 * posted as a comment alongside the review state.
 */
export async function submitReview(
  target: BitbucketPrTarget & {
    event: 'approve' | 'request_changes' | 'comment';
    body?: string;
  } & BitbucketMutationInput
): Promise<BitbucketMutationResult> {
  if (target.event === 'comment' && !target.body) {
    throw new BitbucketReviewError('bad_request', 'A comment review needs a body.');
  }
  const access = await targetAccess(target);
  try {
    const accountId = await ownAccountId(access);
    const state =
      target.event === 'approve'
        ? 'approved'
        : target.event === 'request_changes'
          ? 'changes_requested'
          : null;
    await requestBitbucketJson(
      access,
      `${prPath(access, target.prId)}/participants/${encodeURIComponent(accountId)}`,
      { method: 'PUT', body: { state } }
    );
    if (target.body) {
      await requestBitbucketJson(access, `${prPath(access, target.prId)}/comments`, {
        method: 'POST',
        body: { content: { raw: target.body } },
      });
    }
    return { done: true, replayed: false };
  } catch (error) {
    throw classifyBitbucketError(error);
  }
}

/**
 * Walk the PR's task collection for the comment's first task matching
 * `predicate`. The collection is paginated with opaque `next` URLs: follow
 * every page (the same guarded, identity-bound page fetch the read layer
 * uses) and remember whether any task belongs to the comment, because the
 * decision needs all three outcomes: matching task found → mutate it; tasks
 * seen but none matching → the target state already holds; no task for the
 * comment at all → the capability reason.
 */
async function findCommentTask(
  access: BitbucketRepositoryAccess,
  prId: number,
  commentId: number,
  predicate: (task: z.infer<typeof BitbucketTaskWriteSchema>) => boolean
): Promise<{
  task: z.infer<typeof BitbucketTaskWriteSchema> | null;
  sawTaskForComment: boolean;
  exhausted: boolean;
}> {
  let task: z.infer<typeof BitbucketTaskWriteSchema> | null = null;
  let sawTaskForComment = false;
  let cursor: string | undefined = undefined;
  let exhausted = true;
  try {
    for (let pageIndex = 0; pageIndex < MAX_TASK_COLLECTION_PAGES; pageIndex++) {
      const page = await fetchPage(
        access,
        `${prPath(access, prId)}/tasks`,
        `bitbucket-tasks:${access.repository.fullName}#${prId}`,
        cursor,
        repositoryPathGuard(access),
        { pagelen: 100 }
      );
      for (const value of page.values) {
        const parsed = BitbucketTaskWriteSchema.safeParse(value);
        if (!parsed.success) continue;
        if (parsed.data.comment?.id !== commentId) continue;
        sawTaskForComment = true;
        if (predicate(parsed.data)) {
          task = parsed.data;
          break;
        }
      }
      if (task) break;
      if (!page.nextCursor) {
        exhausted = true;
        break;
      }
      exhausted = false;
      cursor = page.nextCursor;
    }
  } catch (error) {
    if (error instanceof BitbucketReviewError && error.kind === 'not_found') {
      throw new BitbucketReviewError('bad_request', BITBUCKET_THREAD_RESOLUTION_UNSUPPORTED_REASON);
    }
    throw error;
  }
  return { task, sawTaskForComment, exhausted };
}

/**
 * Resolve a thread by resolving the root comment's task. Bitbucket comments
 * carry no task count, so the decision comes from the task-collection walk
 * alone: an unresolved task on the comment is resolved, a fully resolved set
 * of tasks reports the replay, and a thread without any task is refused with
 * the explicit capability reason — never a silent fallback.
 */
export async function resolveThread(
  target: BitbucketPrTarget & { threadId: string } & BitbucketMutationInput
): Promise<BitbucketMutationResult> {
  const commentId = Number(target.threadId);
  if (!Number.isInteger(commentId) || commentId <= 0) {
    throw new BitbucketReviewError('not_found', 'This discussion thread could not be found.');
  }
  const access = await targetAccess(target);
  try {
    // The comment fetch is an existence check only: a missing comment 404s
    // into a non-retryable not_found before the task walk runs.
    BitbucketCommentWriteSchema.parse(
      await requestBitbucketJson<unknown>(
        access,
        `${prPath(access, target.prId)}/comments/${commentId}`
      )
    );

    const { task, sawTaskForComment, exhausted } = await findCommentTask(
      access,
      target.prId,
      commentId,
      candidate => candidate.resolved_on == null
    );
    if (!task) {
      if (!exhausted) {
        // The collection paginated past the walk bound without ever showing
        // the comment's unresolved task: report a retryable failure instead
        // of claiming an unverified state.
        throw new BitbucketReviewError(
          'retryable',
          'The Bitbucket task list is too large to resolve this thread. Try again.'
        );
      }
      if (sawTaskForComment) {
        // Every one of the comment's tasks is already resolved: the target
        // state already holds.
        return { done: true, replayed: true };
      }
      // No task exists for this comment, so the provider exposes no
      // resolution affordance at all.
      throw new BitbucketReviewError('bad_request', BITBUCKET_THREAD_RESOLUTION_UNSUPPORTED_REASON);
    }
    await requestBitbucketJson(access, `${prPath(access, target.prId)}/tasks/${task.id}`, {
      method: 'PUT',
      body: { resolved: true },
    });
    return { done: true, replayed: false };
  } catch (error) {
    throw classifyBitbucketError(error);
  }
}

/**
 * Un-resolve a thread by reopening the root comment's resolved task — the
 * mirror of resolveThread: a resolved task on the comment is reopened, a
 * fully unresolved set reports the replay, and a thread without any task is
 * refused with the explicit capability reason.
 */
export async function unresolveThread(
  target: BitbucketPrTarget & { threadId: string } & BitbucketMutationInput
): Promise<BitbucketMutationResult> {
  const commentId = Number(target.threadId);
  if (!Number.isInteger(commentId) || commentId <= 0) {
    throw new BitbucketReviewError('not_found', 'This discussion thread could not be found.');
  }
  const access = await targetAccess(target);
  try {
    BitbucketCommentWriteSchema.parse(
      await requestBitbucketJson<unknown>(
        access,
        `${prPath(access, target.prId)}/comments/${commentId}`
      )
    );

    const { task, sawTaskForComment, exhausted } = await findCommentTask(
      access,
      target.prId,
      commentId,
      candidate => candidate.resolved_on != null
    );
    if (!task) {
      if (!exhausted) {
        throw new BitbucketReviewError(
          'retryable',
          'The Bitbucket task list is too large to reopen this thread. Try again.'
        );
      }
      if (sawTaskForComment) {
        // No task of the comment is resolved: the target state already holds.
        return { done: true, replayed: true };
      }
      throw new BitbucketReviewError('bad_request', BITBUCKET_THREAD_RESOLUTION_UNSUPPORTED_REASON);
    }
    await requestBitbucketJson(access, `${prPath(access, target.prId)}/tasks/${task.id}`, {
      method: 'PUT',
      body: { resolved: false },
    });
    return { done: true, replayed: false };
  } catch (error) {
    throw classifyBitbucketError(error);
  }
}

/**
 * Re-fetch the PR and compare the current head against the caller's fence.
 * A moved head is refused BEFORE any merge call, so a stale revision can
 * never merge another commit or be redirected.
 */
function requireHeadShaFence(
  pr: z.infer<typeof BitbucketPullRequestWriteSchema>,
  expectedHeadSha: string
): void {
  const currentHead = pr.source?.commit?.hash ?? '';
  if (currentHead !== expectedHeadSha) {
    throw new BitbucketReviewError('stale_head', BITBUCKET_STALE_HEAD_REASON);
  }
}

/**
 * Merge the pull request. The caller's `expectedHeadSha` is re-verified
 * against a fresh fetch BEFORE any merge call, so the merge can only land the
 * exact revision the reviewer saw. `closeSourceBranch` is honored.
 */
export async function mergePullRequest(
  target: BitbucketPrTarget & {
    expectedHeadSha: string;
    closeSourceBranch?: boolean;
    commitMessage?: string;
  } & BitbucketMutationInput
): Promise<BitbucketMutationResult> {
  const access = await targetAccess(target);
  try {
    const pr = BitbucketPullRequestWriteSchema.parse(
      await requestBitbucketJson<unknown>(access, prPath(access, target.prId))
    );
    if (pr.state === 'MERGED') {
      // The target state already holds: report the replay, run no effect.
      return { done: true, replayed: true };
    }
    requireHeadShaFence(pr, target.expectedHeadSha);
    if (pr.state !== 'OPEN') {
      throw new BitbucketReviewError('bad_request', 'The pull request is closed.');
    }
    await requestBitbucketJson(access, `${prPath(access, target.prId)}/merge`, {
      method: 'POST',
      body: {
        close_source_branch: target.closeSourceBranch ?? false,
        ...(target.commitMessage ? { commit_message: target.commitMessage } : {}),
      },
    });
    return { done: true, replayed: false };
  } catch (error) {
    throw classifyBitbucketError(error);
  }
}
