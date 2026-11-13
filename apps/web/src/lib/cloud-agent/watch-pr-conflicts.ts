import 'server-only';

import { Octokit } from '@octokit/rest';
import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  cloud_agent_pr_maintenance_attempts,
  cloud_agent_pr_watches,
  type CloudAgentPrWatch,
} from '@kilocode/db/schema';
import {
  watchPrLiveAttemptStatuses,
  watchPrMaintenanceDefaults,
} from '@kilocode/db/cloud-agent-pr-maintenance';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  generateGitHubInstallationToken,
  toGitHubRateLimitError,
} from '@/lib/integrations/platforms/github/adapter';
import {
  assertGitHubInstallationRuntimeAuthorized,
  GitHubRuntimeAuthorizationError,
} from '@/lib/integrations/github/runtime-authorization';
import {
  claimPrMaintenanceCall,
  claimPrConflictBatch,
  deferPrRefresh,
  recordPrMaintenanceApiCall,
  type PrMaintenanceScope,
} from '@/lib/integrations/platforms/github/pr-refresh-budget';
import { isRateLimitGraphQlError } from '@/lib/integrations/platforms/github/pr-status';
import { boundWatchPrPending, watchPrProjectionSchema } from './watch-pr-events';
import { watchPrBatchSchedule } from './watch-pr-observation';
import { watchPrRepository, type WatchPrAssessmentDeferred } from './watch-pr-assessment';
import { selectWatchMaintenanceRepair } from './watch-pr-maintenance-store';

const conflictResponseSchema = z.object({
  data: z.record(z.string(), z.unknown()).optional(),
  errors: z
    .array(
      z.object({
        type: z.string().optional(),
        path: z.array(z.union([z.string(), z.number()])).optional(),
        extensions: z.object({ code: z.string().optional() }).optional(),
      })
    )
    .optional(),
});
const aliasSchema = z
  .object({
    pullRequest: z
      .object({
        headRefOid: z.string(),
        baseRefOid: z.string(),
        baseRefName: z.string(),
        mergeable: z.enum(['CONFLICTING', 'MERGEABLE', 'UNKNOWN']),
        files: z
          .object({
            nodes: z.array(
              z.object({ path: z.string().max(1000), changeType: z.string().optional() })
            ),
            pageInfo: z.object({ hasNextPage: z.boolean() }),
          })
          .nullable()
          .optional(),
      })
      .nullable(),
  })
  .nullable();
const rateSchema = z.object({
  cost: z.number(),
  limit: z.number(),
  remaining: z.number(),
  resetAt: z.string(),
});

export function buildWatchPrConflictQuery(
  watches: (Pick<CloudAgentPrWatch, 'repo_url' | 'pr_number'> &
    Partial<Pick<CloudAgentPrWatch, 'head_sha' | 'projection'>>)[]
): string {
  if (watches.length < 1 || watches.length > watchPrMaintenanceDefaults.conflictQueryBatchSize)
    throw new Error('Invalid conflict query size');
  return `query WatchPrConflicts { rateLimit { cost limit remaining resetAt } ${watches
    .map((watch, index) => {
      const { owner, repo } = watchPrRepository(watch);
      const projection = watchPrProjectionSchema.safeParse(watch.projection);
      const cached = projection.success && projection.data.files?.headSha === watch.head_sha;
      const files = cached
        ? ''
        : 'files(first:100) { nodes { path changeType } pageInfo { hasNextPage } }';
      return `p${index}: repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(repo)}) { pullRequest(number:${z.number().int().positive().parse(watch.pr_number)}) { headRefOid baseRefOid baseRefName mergeable ${files} } }`;
    })
    .join('\n')} }`;
}

async function saveConflict(
  watch: CloudAgentPrWatch,
  update: {
    state: 'CONFLICTING' | 'MERGEABLE' | 'UNKNOWN';
    retry: boolean;
    files?: { paths: string[]; complete: boolean };
    attention?: boolean;
    retryAt?: Date;
  }
) {
  const now = new Date();
  const projection = watchPrProjectionSchema.parse(watch.projection);
  const prior = projection.conflict;
  if (!prior) return;
  projection.conflict = {
    ...prior,
    state: update.state,
    checkedAt: update.retryAt ? prior.checkedAt : now.toISOString(),
    dueAt:
      update.retryAt?.toISOString() ??
      (update.retry ? new Date(now.getTime() + 30_000).toISOString() : null),
    retries: update.retry ? 1 : prior.retries,
  };
  if (update.files) projection.files = { headSha: watch.head_sha, ...update.files };
  projection.pending = projection.pending.filter(item => item.reason !== 'conflict');
  if (update.state === 'CONFLICTING')
    projection.pending.push({ key: 'conflict', reason: 'conflict' });
  boundWatchPrPending(projection);
  if (update.attention) projection.needsAttention = true;
  const changed =
    JSON.stringify(projection.pending) !==
    JSON.stringify(watchPrProjectionSchema.parse(watch.projection).pending);
  const next = {
    ...watch,
    projection,
    pending_revision: watch.pending_revision + (changed ? 1 : 0),
  };
  await db
    .update(cloud_agent_pr_watches)
    .set({
      projection,
      pending_revision: next.pending_revision,
      ...watchPrBatchSchedule(watch, next, now),
      updated_at: now.toISOString(),
    })
    .where(
      and(
        eq(cloud_agent_pr_watches.id, watch.id),
        eq(cloud_agent_pr_watches.generation, watch.generation),
        eq(cloud_agent_pr_watches.updated_at, watch.updated_at),
        eq(cloud_agent_pr_watches.status, 'watching')
      )
    );
}

export async function processWatchPrConflictBatch(
  scope: PrMaintenanceScope
): Promise<{ status: 'completed'; checked: number } | WatchPrAssessmentDeferred> {
  const candidates = await db
    .select()
    .from(cloud_agent_pr_watches)
    .where(
      and(
        eq(cloud_agent_pr_watches.installation_id, scope.installationId),
        eq(cloud_agent_pr_watches.github_app_type, scope.appType),
        eq(cloud_agent_pr_watches.status, 'watching'),
        sql`NOT EXISTS (SELECT 1 FROM ${cloud_agent_pr_maintenance_attempts} WHERE ${cloud_agent_pr_maintenance_attempts.worktree_id} = ${cloud_agent_pr_watches.worktree_id} AND ${inArray(cloud_agent_pr_maintenance_attempts.status, [...watchPrLiveAttemptStatuses])})`,
        lte(cloud_agent_pr_watches.next_run_at, new Date().toISOString()),
        sql`(${cloud_agent_pr_watches.projection}->'conflict'->>'dueAt')::timestamptz <= ${new Date().toISOString()}`
      )
    )
    .limit(100);
  const watches: CloudAgentPrWatch[] = [];
  for (const watch of candidates) {
    const projection = watchPrProjectionSchema.parse(watch.projection);
    const conflict = projection.conflict;
    if (
      !conflict?.dueAt ||
      Date.parse(conflict.dueAt) > Date.now() ||
      watch.policy.version !== 2 ||
      !watch.policy.categories.conflicts
    )
      continue;
    if ((await selectWatchMaintenanceRepair(watch, watch.policy)).startable) {
      await saveConflict(watch, { state: conflict.state, retry: false });
      continue;
    }
    const earliest = conflict.checkedAt
      ? Date.parse(conflict.checkedAt) +
        watchPrMaintenanceDefaults.conflictCheckIntervalSeconds * 1000
      : 0;
    if (earliest > Date.now() && conflict.retries === 0) {
      await saveConflict(watch, {
        state: conflict.state,
        retry: false,
        retryAt: new Date(earliest),
      });
      continue;
    }
    try {
      await assertGitHubInstallationRuntimeAuthorized(
        scope.installationId,
        scope.appType,
        watch.integration_id,
        'agent'
      );
    } catch (error) {
      if (!(error instanceof GitHubRuntimeAuthorizationError)) throw error;
      await saveConflict(watch, { state: 'UNKNOWN', retry: false, attention: true });
      continue;
    }
    watches.push(watch);
  }
  let checked = 0;
  if (watches.length) {
    const claim = await claimPrConflictBatch(scope);
    if (!claim.allowed) {
      for (const watch of watches)
        await saveConflict(watch, { state: 'UNKNOWN', retry: false, retryAt: claim.retryAt });
      return { status: 'deferred', reason: claim.reason, retryAt: claim.retryAt };
    }
  }
  for (
    let offset = 0;
    offset < watches.length;
    offset += watchPrMaintenanceDefaults.conflictQueryBatchSize
  ) {
    const batch = watches.slice(offset, offset + watchPrMaintenanceDefaults.conflictQueryBatchSize);
    const budget = await claimPrMaintenanceCall(scope);
    if (!budget.allowed) {
      for (const watch of watches.slice(offset))
        await saveConflict(watch, { state: 'UNKNOWN', retry: false, retryAt: budget.retryAt });
      return { status: 'deferred', reason: budget.reason, retryAt: budget.retryAt };
    }
    const first = batch[0];
    if (!first) continue;
    try {
      const signal = AbortSignal.timeout(10_000);
      const token = await generateGitHubInstallationToken(
        scope.installationId,
        scope.appType,
        first.integration_id,
        'agent',
        signal
      );
      const octokit = new Octokit({
        auth: token.token,
        request: { signal },
      });
      await recordPrMaintenanceApiCall({ ...scope, endpoint: 'conflict', reason: 'base_overlap' });
      const response = await octokit.request('POST /graphql', {
        query: buildWatchPrConflictQuery(batch),
      });
      const parsed = conflictResponseSchema.parse(response.data);
      const rate = rateSchema.safeParse(parsed.data?.rateLimit);
      await recordPrMaintenanceApiCall({
        ...scope,
        endpoint: 'conflict',
        reason: 'base_overlap',
        headers: response.headers,
        calls: 0,
        graphqlCost: rate.success ? rate.data.cost : undefined,
        graphqlBudget: rate.success ? rate.data : undefined,
      });
      if (parsed.errors?.some(isRateLimitGraphQlError)) {
        throw { status: 429, response: { headers: response.headers } };
      }
      for (const [index, watch] of batch.entries()) {
        const result = aliasSchema.safeParse(parsed.data?.[`p${index}`]);
        const pr = result.success ? result.data?.pullRequest : null;
        const projection = watchPrProjectionSchema.parse(watch.projection);
        const stale =
          pr &&
          (pr.headRefOid !== watch.head_sha ||
            pr.baseRefOid !== watch.base_sha ||
            pr.baseRefName !== watch.base_ref);
        const aliasError = parsed.errors?.some(
          error => !error.path || error.path[0] === `p${index}`
        );
        const unknown = !pr || stale || aliasError || pr.mergeable === 'UNKNOWN';
        await saveConflict(watch, {
          state: unknown ? 'UNKNOWN' : pr.mergeable,
          retry: Boolean(unknown && projection.conflict?.retries === 0),
          attention: Boolean(unknown && projection.conflict?.retries === 1),
          ...(pr?.files
            ? {
                files: {
                  paths: pr.files.nodes.map(file => file.path),
                  complete:
                    !pr.files.pageInfo.hasNextPage &&
                    !pr.files.nodes.some(file => file.changeType === 'RENAMED'),
                },
              }
            : {}),
        });
        checked++;
      }
    } catch (error) {
      const limited = toGitHubRateLimitError(error);
      if (limited) {
        await deferPrRefresh({ ...scope, resetAt: limited.resetAt });
        for (const watch of watches.slice(offset))
          await saveConflict(watch, { state: 'UNKNOWN', retry: false, retryAt: limited.resetAt });
        return { status: 'deferred', reason: 'rate_limited', retryAt: limited.resetAt };
      }
      for (const watch of batch) {
        const projection = watchPrProjectionSchema.parse(watch.projection);
        await saveConflict(watch, {
          state: 'UNKNOWN',
          retry: projection.conflict?.retries === 0,
          attention: projection.conflict?.retries === 1,
        });
      }
    }
  }
  return { status: 'completed', checked };
}
