/**
 * GitLab merge-request WRITE layer for the provider review surfaces.
 *
 * Every mutation resolves credentials through gitlab-authorization (the
 * instance URL and token are server-derived), fences against the caller's
 * expected head sha where a revision matters, and returns an idempotent-ready
 * `{ done, replayed }` result: `replayed` is true when the provider already
 * holds the target state, so the s4 router can run the call through the
 * operation ledger (github-pr-review-router.ts:762-779) without a duplicate
 * effect. `operationKey` is accepted for that ledger; this layer performs no
 * ledger writes itself.
 */
import 'server-only';

import type { ProviderReviewCapabilities } from '@kilocode/app-shared/provider-review';
import {
  createMRNote,
  fetchGitLabMergeRequest,
  type GitLabDiscussion,
  type GitLabMergeRequest,
} from '@/lib/integrations/platforms/gitlab/adapter';
import {
  authorizeProject,
  classifyGitLabError,
  GitLabReviewError,
  type GitLabProjectAccess,
  type GitLabReviewOwner,
} from './gitlab-authorization';
import { requestGitLabJson } from './gitlab-read';

/** The MR a write acts on. `instanceHint` is display/matching only. */
export type GitLabMrTarget = {
  owner: GitLabReviewOwner;
  projectPath: string;
  mrIid: number;
  instanceHint?: string;
};

/** Every mutation accepts the router's ledger key and reports its outcome. */
export type GitLabMutationInput = { operationKey?: string };

export type GitLabMutationResult = {
  done: boolean;
  /** True when the provider already held the target state — nothing changed. */
  replayed: boolean;
};

/**
 * The exact reason request-changes is refused: GitLab has no such review
 * event, so callers show this instead of silently falling back to a comment.
 */
export const GITLAB_REQUEST_CHANGES_UNSUPPORTED_REASON =
  'GitLab merge requests do not support request-changes reviews. Post a comment instead.';

/**
 * The stale-head fence reason, shared with classifyGitLabStatus so a locally
 * detected moved head and a provider 409 read identically on mobile.
 */
export const GITLAB_STALE_HEAD_REASON =
  'The merge request changed since it was loaded. Reload the merge request and try again.';

/**
 * The exact reason arming auto-merge is refused on an MR without an active
 * pipeline: GitLab's merge endpoint with `merge_when_pipeline_succeeds` and
 * no waiting pipeline merges immediately, so arming must never take that
 * fall-through path.
 */
export const GITLAB_AUTO_MERGE_NO_PIPELINE_REASON =
  'GitLab arms auto-merge only while a pipeline is running. This merge request has no running pipeline. Start a pipeline, then try again.';

/**
 * The GitLab capability list for review surfaces. It excludes
 * `request_changes` from `reviewEvents` (the provider has no such event);
 * the app-shared GITLAB_REVIEW_CAPABILITIES constant still lists it, so the
 * s4 router must surface this list for GitLab, not the generic one.
 */
export const GITLAB_MR_REVIEW_CAPABILITIES: ProviderReviewCapabilities = {
  canComment: true,
  reviewEvents: ['approve', 'comment'],
  canResolveThreads: true,
  canMerge: true,
  autoMerge: { supported: true, reason: '' },
  reactions: { supported: true, reason: '' },
  reviewStatus: { supported: true, reason: '' },
};

type GitLabMergeRequestDetail = GitLabMergeRequest & {
  merge_when_pipeline_succeeds?: boolean;
  force_remove_source_branch?: boolean;
  head_pipeline?: { status?: string } | null;
};

/**
 * Pipeline states that can still succeed. Any other state (no pipeline, a
 * terminal state, a manual one) means GitLab's merge endpoint would merge
 * immediately instead of waiting, so auto-merge cannot be armed on it.
 */
const GITLAB_ACTIVE_PIPELINE_STATUSES = new Set([
  'created',
  'waiting_for_resources',
  'waiting',
  'pending',
  'running',
  'scheduled',
  'preparing',
  'completing',
]);

function hasActivePipeline(mr: GitLabMergeRequestDetail): boolean {
  return (
    typeof mr.head_pipeline?.status === 'string' &&
    GITLAB_ACTIVE_PIPELINE_STATUSES.has(mr.head_pipeline.status)
  );
}

async function targetAccess(target: GitLabMrTarget): Promise<GitLabProjectAccess> {
  return authorizeProject(target.owner, target.projectPath, target.instanceHint);
}

function mrPath(access: GitLabProjectAccess, mrIid: number): string {
  return `/api/v4/projects/${encodeURIComponent(access.projectPath)}/merge_requests/${mrIid}`;
}

/** Post a top-level comment (project note) on the merge request. */
export async function addComment(
  target: GitLabMrTarget & { body: string } & GitLabMutationInput
): Promise<GitLabMutationResult> {
  const access = await targetAccess(target);
  try {
    await createMRNote(
      access.accessToken,
      access.projectPath,
      target.mrIid,
      target.body,
      access.instanceUrl
    );
    return { done: true, replayed: false };
  } catch (error) {
    throw classifyGitLabError(error);
  }
}

/** Reply inside an existing discussion thread. */
export async function replyToDiscussion(
  target: GitLabMrTarget & { discussionId: string; body: string } & GitLabMutationInput
): Promise<GitLabMutationResult> {
  const access = await targetAccess(target);
  try {
    await requestGitLabJson(
      access,
      `${mrPath(access, target.mrIid)}/discussions/${encodeURIComponent(target.discussionId)}/notes`,
      { method: 'POST', body: { body: target.body } }
    );
    return { done: true, replayed: false };
  } catch (error) {
    throw classifyGitLabError(error);
  }
}

/**
 * Submit a review. `approve` → POST /approve plus an optional summary note;
 * `comment` → note; `request_changes` is not a GitLab concept and is refused
 * with the exact reason — never a silent fallback to another event.
 */
export async function submitReview(
  target: GitLabMrTarget & {
    event: 'approve' | 'comment' | 'request_changes';
    body?: string;
  } & GitLabMutationInput
): Promise<GitLabMutationResult> {
  if (target.event === 'request_changes') {
    throw new GitLabReviewError('bad_request', GITLAB_REQUEST_CHANGES_UNSUPPORTED_REASON);
  }
  const access = await targetAccess(target);
  try {
    if (target.event === 'approve') {
      await requestGitLabJson(access, `${mrPath(access, target.mrIid)}/approve`, {
        method: 'POST',
      });
      if (target.body) {
        await createMRNote(
          access.accessToken,
          access.projectPath,
          target.mrIid,
          target.body,
          access.instanceUrl
        );
      }
    } else if (target.body) {
      await createMRNote(
        access.accessToken,
        access.projectPath,
        target.mrIid,
        target.body,
        access.instanceUrl
      );
    } else {
      throw new GitLabReviewError('bad_request', 'A comment review needs a body.');
    }
    return { done: true, replayed: false };
  } catch (error) {
    throw classifyGitLabError(error);
  }
}

/** Fetch one discussion and read whether its resolvable note is resolved. */
async function fetchDiscussionResolvedState(
  access: GitLabProjectAccess,
  mrIid: number,
  discussionId: string
): Promise<{ resolved: boolean; resolvable: boolean }> {
  const discussion = await requestGitLabJson<GitLabDiscussion>(
    access,
    `${mrPath(access, mrIid)}/discussions/${encodeURIComponent(discussionId)}`
  );
  const resolvableNote = discussion?.notes?.find(note => note.resolvable);
  return {
    resolvable: Boolean(resolvableNote),
    resolved: resolvableNote?.resolved === true,
  };
}

async function setThreadResolved(
  target: GitLabMrTarget & { discussionId: string } & GitLabMutationInput,
  resolved: boolean
): Promise<GitLabMutationResult> {
  const access = await targetAccess(target);
  try {
    const state = await fetchDiscussionResolvedState(access, target.mrIid, target.discussionId);
    if (!state.resolvable) {
      throw new GitLabReviewError('bad_request', 'This discussion cannot be resolved on GitLab.');
    }
    if (state.resolved === resolved) {
      return { done: true, replayed: true };
    }
    await requestGitLabJson(
      access,
      `${mrPath(access, target.mrIid)}/discussions/${encodeURIComponent(target.discussionId)}`,
      { method: 'PUT', query: { resolved } }
    );
    return { done: true, replayed: false };
  } catch (error) {
    throw classifyGitLabError(error);
  }
}

/** Resolve a discussion thread (PUT discussions). */
export async function resolveThread(
  target: GitLabMrTarget & { discussionId: string } & GitLabMutationInput
): Promise<GitLabMutationResult> {
  return setThreadResolved(target, true);
}

/** Un-resolve a discussion thread (PUT discussions). */
export async function unresolveThread(
  target: GitLabMrTarget & { discussionId: string } & GitLabMutationInput
): Promise<GitLabMutationResult> {
  return setThreadResolved(target, false);
}

/**
 * Re-fetch the MR and compare the current head against the caller's fence.
 * A moved head is refused BEFORE any merge call, so a stale revision can
 * never merge another commit or be redirected (requirement 16).
 */
function requireHeadShaFence(mr: GitLabMergeRequestDetail, expectedHeadSha: string): void {
  const currentHead = mr.diff_refs?.head_sha || mr.sha;
  if (currentHead !== expectedHeadSha) {
    throw new GitLabReviewError('stale_head', GITLAB_STALE_HEAD_REASON);
  }
}

/**
 * Merge the MR. The caller's `expectedHeadSha` is re-verified against a fresh
 * fetch and passed to GitLab as `sha`, so the merge can only land the exact
 * revision the reviewer saw.
 */
export async function mergePullRequest(
  target: GitLabMrTarget & {
    expectedHeadSha: string;
    squash?: boolean;
    shouldRemoveSourceBranch?: boolean;
    commitTitle?: string;
    commitMessage?: string;
  } & GitLabMutationInput
): Promise<GitLabMutationResult> {
  const access = await targetAccess(target);
  try {
    const mr = (await fetchGitLabMergeRequest({
      accessToken: access.accessToken,
      projectId: access.projectPath,
      mrIid: target.mrIid,
      instanceUrl: access.instanceUrl,
    })) as GitLabMergeRequestDetail;
    if (mr.state === 'merged') {
      // The target state already holds: report the replay, run no effect.
      return { done: true, replayed: true };
    }
    requireHeadShaFence(mr, target.expectedHeadSha);
    if (mr.state === 'closed' || mr.state === 'locked') {
      throw new GitLabReviewError('bad_request', 'The merge request is closed.');
    }
    await requestGitLabJson(access, `${mrPath(access, target.mrIid)}/merge`, {
      method: 'PUT',
      body: {
        sha: target.expectedHeadSha,
        ...(target.squash !== undefined ? { squash: target.squash } : {}),
        ...(target.shouldRemoveSourceBranch !== undefined
          ? { should_remove_source_branch: target.shouldRemoveSourceBranch }
          : {}),
        ...(target.commitTitle ? { merge_commit_title: target.commitTitle } : {}),
        ...(target.commitMessage ? { merge_commit_message: target.commitMessage } : {}),
      },
    });
    return { done: true, replayed: false };
  } catch (error) {
    throw classifyGitLabError(error);
  }
}

/**
 * Enable merge-when-pipeline-succeeds (GitLab's auto-merge) through the merge
 * endpoint: the plain merge-request update endpoint does not accept the
 * attribute, so a PUT there would succeed without arming auto-merge.
 * `expectedHeadSha` is REQUIRED and is sent as `sha` on the merge call, so a
 * moved head can never arm auto-merge on another revision, and arming is
 * refused while the MR has no active pipeline — GitLab would merge
 * immediately in that state. Already-armed reports `replayed`.
 */
export async function enableAutoMerge(
  target: GitLabMrTarget & { expectedHeadSha: string } & GitLabMutationInput
): Promise<GitLabMutationResult> {
  const access = await targetAccess(target);
  try {
    const mr = (await fetchGitLabMergeRequest({
      accessToken: access.accessToken,
      projectId: access.projectPath,
      mrIid: target.mrIid,
      instanceUrl: access.instanceUrl,
    })) as GitLabMergeRequestDetail;
    if (mr.merge_when_pipeline_succeeds === true) {
      return { done: true, replayed: true };
    }
    requireHeadShaFence(mr, target.expectedHeadSha);
    if (!hasActivePipeline(mr)) {
      throw new GitLabReviewError('bad_request', GITLAB_AUTO_MERGE_NO_PIPELINE_REASON);
    }
    await requestGitLabJson(access, `${mrPath(access, target.mrIid)}/merge`, {
      method: 'PUT',
      body: { merge_when_pipeline_succeeds: true, sha: target.expectedHeadSha },
    });
    return { done: true, replayed: false };
  } catch (error) {
    throw classifyGitLabError(error);
  }
}

/**
 * Disable merge-when-pipeline-succeeds through the dedicated cancel endpoint:
 * the plain merge-request update endpoint does not accept the attribute, so
 * a PUT with `false` there would succeed without disarming auto-merge.
 * Already-disabled reports `replayed`; an optional head fence refuses a stale
 * revision. Cancelling arms nothing, so unlike enableAutoMerge the fence is
 * not required here.
 */
export async function disableAutoMerge(
  target: GitLabMrTarget & { expectedHeadSha?: string } & GitLabMutationInput
): Promise<GitLabMutationResult> {
  const access = await targetAccess(target);
  try {
    const mr = (await fetchGitLabMergeRequest({
      accessToken: access.accessToken,
      projectId: access.projectPath,
      mrIid: target.mrIid,
      instanceUrl: access.instanceUrl,
    })) as GitLabMergeRequestDetail;
    if (target.expectedHeadSha) {
      requireHeadShaFence(mr, target.expectedHeadSha);
    }
    if (mr.merge_when_pipeline_succeeds !== true) {
      return { done: true, replayed: true };
    }
    await requestGitLabJson(
      access,
      `${mrPath(access, target.mrIid)}/cancel_merge_when_pipeline_succeeds`,
      { method: 'POST' }
    );
    return { done: true, replayed: false };
  } catch (error) {
    throw classifyGitLabError(error);
  }
}

/**
 * Delete a project branch. A branch GitLab no longer reports is the target
 * state already, so it reports `replayed` rather than an error.
 */
export async function deleteBranch(
  target: GitLabMrTarget & { branchName: string } & GitLabMutationInput
): Promise<GitLabMutationResult> {
  const access = await targetAccess(target);
  try {
    await requestGitLabJson(
      access,
      `/api/v4/projects/${encodeURIComponent(access.projectPath)}/repository/branches/${encodeURIComponent(target.branchName)}`,
      { method: 'DELETE' }
    );
    return { done: true, replayed: false };
  } catch (error) {
    if (error instanceof GitLabReviewError && error.kind === 'not_found') {
      return { done: true, replayed: true };
    }
    throw error;
  }
}
