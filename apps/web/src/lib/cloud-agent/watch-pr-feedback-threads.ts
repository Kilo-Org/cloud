import 'server-only';

import { and, eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { cloud_agent_pr_watches, type CloudAgentPrWatch } from '@kilocode/db/schema';
import type { WatchPrProblem } from '@kilocode/db/cloud-agent-pr-maintenance';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { toGitHubRateLimitError } from '@/lib/integrations/platforms/github/adapter';
import {
  deferPrRefresh,
  PrMaintenanceDeferredError,
  recordPrMaintenanceApiCall,
} from '@/lib/integrations/platforms/github/pr-refresh-budget';
import { watchPrRepository } from './watch-pr-assessment';
import {
  normalizeWatchPrEvent,
  projectWatchPrEvent,
  watchPrProjectionSchema,
  type WatchPrObservationState,
} from './watch-pr-events';
import { prMaintenanceFeedbackCommentSchema as maintenanceCommentSchema } from '@/lib/integrations/platforms/github/pr-maintenance-feedback';
import { isRateLimitGraphQlError } from '@/lib/integrations/platforms/github/pr-status';
import { watchPrBatchSchedule } from './watch-pr-observation';
import { assertWatchPrGitHubCall, watchPrGitHubClient } from './watch-pr-github-client';

const responseSchema = z.object({
  data: z
    .object({
      rateLimit: z
        .object({ cost: z.number(), limit: z.number(), remaining: z.number(), resetAt: z.string() })
        .optional(),
      repository: z
        .object({
          pullRequest: z
            .object({
              headRefName: z.string(),
              headRefOid: z.string(),
              reviewThreads: z.object({
                nodes: z.array(
                  z.object({
                    id: z.string().max(200),
                    isResolved: z.boolean(),
                    comments: z.object({
                      nodes: z.array(maintenanceCommentSchema),
                    }),
                  })
                ),
              }),
            })
            .nullable(),
        })
        .nullable(),
    })
    .nullish(),
  errors: z.array(z.unknown()).optional(),
});

export async function hydrateWatchPrFeedbackThreads(input: {
  watch: CloudAgentPrWatch;
  problems: readonly WatchPrProblem[];
}): Promise<WatchPrProblem[]> {
  const { watch } = input;
  const missing = input.problems.filter(
    problem =>
      problem.kind === 'review' && problem.source === 'review_comment' && problem.threadId === null
  );
  if (!missing.length) return [...input.problems];
  let projection = watchPrProjectionSchema.parse(watch.projection);
  const rootIds = new Map(
    missing.flatMap(problem =>
      problem.kind === 'review'
        ? [
            [
              problem.problemKey,
              projection.evidence.find(item => item.key === problem.problemKey)?.rootId ??
                problem.sourceId,
            ] as const,
          ]
        : []
    )
  );
  await assertWatchPrGitHubCall(watch);
  const { owner, repo } = watchPrRepository(watch);
  const scope = { appType: watch.github_app_type, installationId: watch.installation_id };
  try {
    const octokit = await watchPrGitHubClient(watch);
    await recordPrMaintenanceApiCall({
      ...scope,
      endpoint: 'feedback_threads',
      reason: 'repair_context',
    });
    const response = await octokit.request('POST /graphql', {
      query: `query WatchPrRepairThreads { rateLimit {cost limit remaining resetAt} repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(repo)}) { pullRequest(number:${watch.pr_number}) { headRefName headRefOid reviewThreads(last:100) { nodes {id isResolved comments(first:1) {nodes {fullDatabaseId body authorAssociation author {login __typename ... on User {databaseId} ... on Bot {databaseId}} updatedAt url commit {oid}}}} } } } }`,
    });
    const parsed = responseSchema.parse(response.data);
    await recordPrMaintenanceApiCall({
      ...scope,
      endpoint: 'feedback_threads',
      reason: 'repair_context',
      headers: response.headers,
      calls: 0,
      graphqlCost: parsed.data?.rateLimit?.cost,
      graphqlBudget: parsed.data?.rateLimit,
    });
    if (parsed.errors?.length) {
      if (parsed.errors.some(isRateLimitGraphQlError))
        throw { status: 429, response: { headers: response.headers } };
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message:
          'GitHub review thread IDs are unavailable. Recheck the PR before starting maintenance.',
      });
    }
    const pr = parsed.data?.repository?.pullRequest;
    if (!pr)
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'The PR is unavailable. Confirm repository access, then recheck maintenance.',
      });
    if (pr.headRefOid !== watch.head_sha || pr.headRefName !== watch.head_ref)
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'The PR head changed. Recheck the PR before starting maintenance.',
      });
    const threads = new Map(
      pr.reviewThreads.nodes.flatMap(thread => {
        const rootId = thread.comments.nodes[0]?.fullDatabaseId;
        return rootId ? [[rootId, { id: thread.id, resolved: thread.isResolved }] as const] : [];
      })
    );
    let observed: WatchPrObservationState = watch;
    for (const thread of pr.reviewThreads.nodes) {
      const root = thread.comments.nodes[0];
      if (!root?.fullDatabaseId || !root.author?.databaseId) continue;
      if (![...rootIds.values()].includes(root.fullDatabaseId)) continue;
      const event = normalizeWatchPrEvent('pull_request_review_comment', {
        installation: { id: watch.installation_id },
        repository: { id: watch.repository_id },
        pull_request: { number: watch.pr_number },
        action: 'created',
        comment: {
          id: root.fullDatabaseId,
          body: root.body,
          user: {
            id: root.author.databaseId,
            login: root.author.login,
            type: root.author.__typename,
          },
          author_association: root.authorAssociation,
          updated_at: root.updatedAt,
          commit_id: root.commit?.oid ?? watch.head_sha,
          html_url: root.url,
        },
      });
      if (event?.kind === 'feedback')
        observed = projectWatchPrEvent(
          observed,
          { ...event, threadId: thread.id },
          observed.generation
        );
    }
    projection = watchPrProjectionSchema.parse(observed.projection);
    const prepared = input.problems.flatMap(problem => {
      if (problem.kind !== 'review' || problem.source !== 'review_comment') return [problem];
      if (problem.threadId !== null)
        return [...threads.values()].some(
          thread => thread.id === problem.threadId && thread.resolved
        )
          ? []
          : [problem];
      const rootId = rootIds.get(problem.problemKey);
      const thread = rootId ? threads.get(rootId) : null;
      if (!thread)
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            'Some review threads are outside the bounded snapshot. Recheck the PR before starting maintenance.',
        });
      return thread.resolved ? [] : [{ ...problem, threadId: thread.id }];
    });
    const retained = new Set(prepared.map(problem => problem.problemKey));
    const resolved = new Set(
      input.problems
        .filter(problem => !retained.has(problem.problemKey))
        .map(problem => problem.problemKey)
    );
    if (resolved.size || observed.pending_revision !== watch.pending_revision) {
      const now = new Date();
      for (const [rootId, thread] of threads) {
        projection.threads = projection.threads.filter(existing => existing.id !== thread.id);
        projection.threads.push({
          id: thread.id,
          rootIds: [rootId],
          resolved: thread.resolved,
          updatedAt: now.toISOString(),
        });
      }
      projection.threads = projection.threads.slice(-100);
      projection.pending = projection.pending.filter(item => !resolved.has(item.key));
      const next = { ...watch, projection, pending_revision: watch.pending_revision + 1 };
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
            eq(cloud_agent_pr_watches.updated_at, watch.updated_at)
          )
        );
    }
    return prepared;
  } catch (error) {
    const limited = toGitHubRateLimitError(error);
    if (limited) {
      await deferPrRefresh({ ...scope, resetAt: limited.resetAt });
      throw new PrMaintenanceDeferredError('rate_limited', limited.resetAt);
    }
    const http = z.object({ status: z.number().int() }).safeParse(error);
    if (http.success && [401, 403, 404].includes(http.data.status))
      throw new TRPCError({
        code: http.data.status === 404 ? 'PRECONDITION_FAILED' : 'FORBIDDEN',
        message:
          'GitHub review thread access is unavailable. Check App permissions, then recheck maintenance.',
      });
    throw error;
  }
}
