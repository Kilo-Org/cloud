import 'server-only';

import { Octokit } from '@octokit/rest';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { GitHubRuntimeAuthorizationError } from '@/lib/integrations/github/runtime-authorization';
import type { CloudAgentPrWatch } from '@kilocode/db/schema';
import {
  generateGitHubInstallationToken,
  toGitHubRateLimitError,
} from '@/lib/integrations/platforms/github/adapter';
import {
  fetchPullRequestObservations,
  type PullRequestObservationMetadata,
} from '@/lib/integrations/platforms/github/pr-status';
import {
  claimPrRefresh,
  claimPrMaintenanceCall,
  deferPrRefresh,
  PrMaintenanceDeferredError,
  recordPrMaintenanceApiCall,
} from '@/lib/integrations/platforms/github/pr-refresh-budget';
import {
  createEmptyPrObservations,
  type PrObservations,
} from '@/lib/integrations/platforms/github/pr-observations';
import {
  emptyWatchPrProjection,
  normalizeWatchPrEvent,
  projectWatchPrEvent,
  watchPrProjectionSchema,
  truncateWatchPrBody,
  boundWatchPrPending,
  type WatchPrObservationState,
} from './watch-pr-events';
import { collectWatchPrProblems } from './watch-pr-observation';

export { collectWatchPrProblems } from './watch-pr-observation';

export type WatchPrAssessmentDeferred = {
  status: 'deferred';
  reason: 'throttled' | 'rate_limited' | 'unavailable' | 'low_budget' | 'write_pacing';
  retryAt: Date;
};
export type WatchPrAssessment =
  | WatchPrAssessmentDeferred
  | {
      status: 'assessed';
      state: WatchPrObservationState;
      observations: PrObservations;
      problems: ReturnType<typeof collectWatchPrProblems>;
      pullRequest: PullRequestObservationMetadata;
    };

export function watchPrRepository(watch: { repo_url: string }) {
  const parsed = z
    .string()
    .regex(/^https:\/\/github\.com\/[a-z0-9-]+\/[a-z0-9._-]+$/)
    .parse(watch.repo_url);
  const [owner, repo] = parsed.slice('https://github.com/'.length).split('/');
  if (!owner || !repo) throw new Error('Invalid PR repository');
  return { owner, repo };
}

export async function assessWatchPr(
  watch: CloudAgentPrWatch,
  reason: 'enable' | 'recheck' = 'enable'
): Promise<WatchPrAssessment> {
  const scope = { appType: watch.github_app_type, installationId: watch.installation_id };
  const installationBudget = await claimPrMaintenanceCall(scope);
  if (!installationBudget.allowed)
    return {
      status: 'deferred',
      reason: installationBudget.reason,
      retryAt: installationBudget.retryAt,
    };
  const { owner, repo } = watchPrRepository(watch);
  const budget = await claimPrRefresh({
    ...scope,
    owner: watch.organization_id
      ? { type: 'org', id: watch.organization_id }
      : { type: 'user', id: watch.kilo_user_id },
    repo: `${owner}/${repo}`,
    number: watch.pr_number,
  });
  if (!budget.allowed)
    return { status: 'deferred', reason: budget.reason, retryAt: budget.retryAt };
  const signal = AbortSignal.timeout(45_000);
  try {
    const token = await generateGitHubInstallationToken(
      watch.installation_id,
      watch.github_app_type,
      watch.integration_id,
      'agent',
      signal
    );
    const octokit = new Octokit({ auth: token.token, request: { signal } });
    await recordPrMaintenanceApiCall({ ...scope, endpoint: 'pr_refresh', reason });
    const response = await octokit.pulls.get({ owner, repo, pull_number: watch.pr_number });
    await recordPrMaintenanceApiCall({
      ...scope,
      endpoint: 'pr_refresh',
      reason,
      headers: response.headers,
      calls: 0,
    });
    const pr = response.data;
    if (
      String(pr.base.repo.id) !== watch.repository_id ||
      String(pr.head.repo?.id) !== watch.repository_id ||
      pr.head.ref !== watch.head_ref
    ) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message:
          'The PR branch or repository no longer matches the watch. Relink the PR before resuming.',
      });
    }
    const pullRequest: PullRequestObservationMetadata = {
      number: pr.number,
      htmlUrl: pr.html_url,
      state: pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : pr.draft ? 'draft' : 'open',
      title: pr.title,
      headSha: pr.head.sha,
      headRef: pr.head.ref,
      baseRef: pr.base.ref,
      baseSha: pr.base.sha,
      updatedAt: pr.updated_at,
      mergeable: pr.mergeable,
      mergeableState: pr.mergeable_state,
    };
    const refreshed = await fetchPullRequestObservations({
      ...scope,
      integrationId: watch.integration_id,
      owner,
      repo,
      number: watch.pr_number,
      pullRequest,
      existing: createEmptyPrObservations(),
      signal,
      maintenanceReason: reason,
    });
    let state: WatchPrObservationState = {
      ...watch,
      head_sha: pr.head.sha,
      base_sha: pr.base.sha,
      base_ref: pr.base.ref,
      projection: emptyWatchPrProjection(pr.updated_at),
    };
    if (pr.state === 'closed') {
      return {
        status: 'assessed',
        state: {
          ...state,
          status: 'finished',
          generation: watch.generation + 1,
          lifecycle_reason: pr.merged ? 'pr_merged' : 'pr_closed',
        },
        observations: refreshed.observations,
        problems: [],
        pullRequest,
      };
    }
    const identity = { installationId: watch.installation_id, repositoryId: watch.repository_id };
    for (const run of refreshed.maintenanceCheckRuns ?? []) {
      const event = normalizeWatchPrEvent('check_run', {
        installation: { id: watch.installation_id },
        repository: { id: watch.repository_id },
        action: 'completed',
        check_run: run,
      });
      if (event && event.kind === 'check' && event.sha === pr.head.sha)
        state = projectWatchPrEvent(state, event, state.generation);
    }
    let unknownFeedback = false;
    for (const feedback of refreshed.maintenance?.feedback ?? []) {
      const id = feedback.fullDatabaseId ?? feedback.databaseId;
      if (!id || !feedback.author?.databaseId) {
        unknownFeedback = true;
        continue;
      }
      const event = normalizeWatchPrEvent(
        feedback.source === 'conversation_comment'
          ? 'issue_comment'
          : feedback.source === 'review'
            ? 'pull_request_review'
            : 'pull_request_review_comment',
        {
          installation: { id: watch.installation_id },
          repository: { id: watch.repository_id },
          action: feedback.source === 'review' ? 'submitted' : 'created',
          pull_request: { number: watch.pr_number },
          issue: { number: watch.pr_number, pull_request: { url: pr.url } },
          [feedback.source === 'review' ? 'review' : 'comment']: {
            id,
            body: feedback.body,
            user: {
              id: feedback.author.databaseId,
              login: feedback.author.login,
              type: feedback.author.__typename,
            },
            author_association: feedback.authorAssociation,
            updated_at: feedback.updatedAt,
            submitted_at: feedback.updatedAt,
            commit_id: feedback.commit?.oid ?? pr.head.sha,
            in_reply_to_id: feedback.rootId && feedback.rootId !== id ? feedback.rootId : undefined,
            state: feedback.state ?? 'COMMENTED',
            html_url: feedback.url,
          },
        }
      );
      if (!event || event.kind !== 'feedback') {
        unknownFeedback = true;
        continue;
      }
      state = projectWatchPrEvent(
        state,
        { ...event, ...(feedback.threadId ? { threadId: feedback.threadId } : {}) },
        state.generation
      );
      if (feedback.threadId)
        state = projectWatchPrEvent(
          state,
          {
            ...identity,
            kind: 'thread',
            prNumber: watch.pr_number,
            threadId: feedback.threadId,
            rootIds: [feedback.rootId ?? id],
            resolved: feedback.resolved,
            updatedAt: feedback.updatedAt,
          },
          state.generation
        );
    }
    for (const check of refreshed.observations.checks) {
      if (refreshed.maintenanceCheckRuns && !check.key.startsWith('status:')) continue;
      const event = check.key.startsWith('status:')
        ? {
            ...identity,
            kind: 'status' as const,
            key: `${check.key}:${pr.head.sha}`,
            objectId: check.id,
            sha: pr.head.sha,
            updatedAt: check.at ?? pr.updated_at,
            state:
              check.outcome === 'failed'
                ? 'failure'
                : check.outcome === 'passed'
                  ? 'success'
                  : 'pending',
            name: check.key.slice('status:'.length),
          }
        : {
            ...identity,
            kind: 'check' as const,
            prNumbers: [watch.pr_number],
            key: `${check.key}:${pr.head.sha}`,
            objectId: check.id,
            sha: pr.head.sha,
            updatedAt: check.at,
            startedAt: null,
            attempt: check.attempt,
            state: check.phase >= 2 ? 'completed' : check.phase === 1 ? 'in_progress' : 'queued',
            conclusion:
              check.outcome === 'failed'
                ? 'failure'
                : check.outcome === 'passed'
                  ? 'success'
                  : null,
            name: check.key.split(':').slice(2).join(':'),
            detailsUrl:
              refreshed.maintenanceCheckDetails?.find(run => run.id === check.id)?.detailsUrl ??
              null,
          };
      state = projectWatchPrEvent(state, event, state.generation);
    }
    const projection = watchPrProjectionSchema.parse(state.projection);
    projection.purpose = {
      title: truncateWatchPrBody(pr.title, 500),
      body: truncateWatchPrBody(pr.body, 8000),
    };
    const prior = watchPrProjectionSchema.safeParse(watch.projection);
    projection.files = refreshed.maintenance
      ? {
          headSha: pr.head.sha,
          paths: refreshed.maintenance.files,
          complete: refreshed.maintenance.filesComplete,
        }
      : undefined;
    projection.truncated ||= !refreshed.maintenance?.complete || unknownFeedback;
    projection.needsAttention ||=
      projection.truncated || (refreshed.observations.unavailable?.length ?? 0) > 0;
    projection.conflict = {
      headSha: pr.head.sha,
      baseSha: pr.base.sha,
      state:
        pr.mergeable === false ? 'CONFLICTING' : pr.mergeable === true ? 'MERGEABLE' : 'UNKNOWN',
      checkedAt: new Date().toISOString(),
      dueAt: pr.mergeable === null ? new Date(Date.now() + 30_000).toISOString() : null,
      retries: pr.mergeable === null ? 1 : 0,
    };
    if (pr.mergeable === false && watch.policy.version === 2 && watch.policy.categories.conflicts)
      projection.pending.push({ key: 'conflict', reason: 'conflict' });
    boundWatchPrPending(projection);
    const changed =
      !prior.success ||
      JSON.stringify(
        prior.data.pending.map(item => [
          item.key,
          prior.data.evidence.find(evidence => evidence.key === item.key)?.contentFingerprint,
        ])
      ) !==
        JSON.stringify(
          projection.pending.map(item => [
            item.key,
            projection.evidence.find(evidence => evidence.key === item.key)?.contentFingerprint,
          ])
        ) ||
      watch.head_sha !== pr.head.sha ||
      watch.base_sha !== pr.base.sha;
    state = { ...state, projection, pending_revision: watch.pending_revision + (changed ? 1 : 0) };
    return {
      status: 'assessed',
      state,
      observations: refreshed.observations,
      problems: collectWatchPrProblems(state),
      pullRequest,
    };
  } catch (error) {
    const limited = toGitHubRateLimitError(error);
    if (limited) {
      await deferPrRefresh({ ...scope, resetAt: limited.resetAt });
      return { status: 'deferred', reason: 'rate_limited', retryAt: limited.resetAt };
    }
    if (error instanceof PrMaintenanceDeferredError)
      return { status: 'deferred', reason: error.reason, retryAt: error.retryAt };
    if (error instanceof GitHubRuntimeAuthorizationError)
      throw new TRPCError({
        code: 'FORBIDDEN',
        message:
          'The GitHub connection is unavailable. Reconnect the GitHub App, then resume maintenance.',
      });
    const http = z.object({ status: z.number().int() }).safeParse(error);
    if (http.success && [401, 403, 404].includes(http.data.status))
      throw new TRPCError({
        code: http.data.status === 404 ? 'PRECONDITION_FAILED' : 'FORBIDDEN',
        message:
          http.data.status === 401
            ? 'GitHub authentication is unavailable. Reconnect the GitHub App, then resume maintenance.'
            : http.data.status === 403
              ? 'GitHub denied access to this PR. Check App permissions, then resume maintenance.'
              : 'The PR is unavailable. Confirm repository access, then recheck maintenance.',
      });
    throw error;
  }
}
