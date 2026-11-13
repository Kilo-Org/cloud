import type { WorkerDb } from '@kilocode/db/client';
import {
  cli_sessions_v2,
  cloud_agent_worktrees,
  github_branch_pull_requests,
} from '@kilocode/db/schema';
import { getPrObservationSummary } from '@kilocode/worker-utils/pr-observations';
import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getPgDb } from '../db/pg.js';
import type { Env } from '../types.js';

const count = z.number().int().nonnegative();

export const workspacePullRequestChecksSchema = z
  .object({
    total: count,
    passed: count,
    failed: count,
    pending: count,
    skipped: count,
    unknown: count,
    complete: z.boolean(),
    available: z.boolean(),
  })
  .strict();

export const workspacePullRequestSummarySchema = z
  .object({
    url: z.string().min(1).max(2048),
    number: z.number().int().positive(),
    state: z.enum(['open', 'draft', 'merged', 'closed', 'unknown']),
    title: z.string().max(1024).nullable(),
    headSha: z
      .string()
      .regex(/^[a-f\d]{40}$/i)
      .nullable(),
    lastSyncedAt: z.string().min(1),
    review: z
      .object({
        decision: z.enum(['none', 'review_required', 'approved', 'changes_requested']).nullable(),
        available: z.boolean(),
        pending: z.boolean(),
      })
      .strict(),
    checks: workspacePullRequestChecksSchema,
    conversations: z
      .object({
        unresolved: count.nullable(),
        complete: z.boolean(),
      })
      .strict(),
    mergeability: z
      .object({
        mergeable: z.boolean().nullable(),
        state: z.string().max(100).nullable(),
        complete: z.boolean(),
      })
      .strict(),
    partial: z.boolean(),
    unavailable: z.array(z.enum(['checks', 'statuses', 'reviews'])),
  })
  .strict();

export type WorkspacePullRequestSummary = z.infer<typeof workspacePullRequestSummarySchema>;

export type WorkspacePullRequestTarget = {
  workspaceId: string;
};

export type WorkspacePullRequestCacheRow = {
  pr_url: string | null;
  pr_number: number | null;
  pr_state: string | null;
  pr_title: string | null;
  pr_head_sha: string | null;
  pr_observations: unknown;
  pr_last_synced_at: string | null;
  pr_review_decision: string | null;
  review_decision_pending: boolean | null;
};

const PR_STATES = new Set(['open', 'draft', 'merged', 'closed']);
const REVIEW_DECISIONS = new Set(['approved', 'changes_requested', 'review_required']);
const HEAD_SHA = /^[a-f\d]{40}$/i;

function toIsoTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function prState(value: string | null): WorkspacePullRequestSummary['state'] {
  return value && PR_STATES.has(value)
    ? (value as WorkspacePullRequestSummary['state'])
    : 'unknown';
}

function reviewSummary(row: WorkspacePullRequestCacheRow): WorkspacePullRequestSummary['review'] {
  if (row.review_decision_pending === true) {
    return { decision: null, available: false, pending: true };
  }
  if (row.pr_review_decision === null) {
    return { decision: 'none', available: true, pending: false };
  }
  if (REVIEW_DECISIONS.has(row.pr_review_decision)) {
    return {
      decision: row.pr_review_decision as WorkspacePullRequestSummary['review']['decision'],
      available: true,
      pending: false,
    };
  }
  return { decision: null, available: false, pending: false };
}

export function summarizeWorkspacePullRequest(
  row: WorkspacePullRequestCacheRow
): WorkspacePullRequestSummary | null {
  if (row.pr_url === null || row.pr_number === null || row.pr_last_synced_at === null) {
    return null;
  }

  const observation = getPrObservationSummary(row.pr_observations, row.pr_head_sha);
  const checks = observation?.checks ?? null;
  const checksComplete = checks?.complete === true;
  const conversationsComplete = observation?.threadsComplete === true;
  const mergeability = observation?.mergeability ?? null;
  const review = reviewSummary(row);

  return {
    url: row.pr_url,
    number: row.pr_number,
    state: prState(row.pr_state),
    title: row.pr_title,
    headSha: row.pr_head_sha && HEAD_SHA.test(row.pr_head_sha) ? row.pr_head_sha : null,
    lastSyncedAt: toIsoTimestamp(row.pr_last_synced_at),
    review,
    checks: {
      total: checks?.total ?? 0,
      passed: checks?.passed ?? 0,
      failed: checks?.failed ?? 0,
      pending: checks?.pending ?? 0,
      skipped: checks?.skipped ?? 0,
      unknown: checks?.unknown ?? 0,
      complete: checksComplete,
      available: checks !== null,
    },
    conversations: {
      unresolved: observation?.unresolvedThreads ?? null,
      complete: conversationsComplete,
    },
    mergeability: {
      mergeable: mergeability?.mergeable ?? null,
      state: mergeability?.state ?? null,
      complete: mergeability !== null,
    },
    partial:
      observation?.truncated === true ||
      (observation?.unavailable?.length ?? 0) > 0 ||
      !checksComplete ||
      !conversationsComplete ||
      mergeability === null ||
      !review.available,
    unavailable: observation?.unavailable ?? [],
  };
}

/**
 * Read the one PR that represents a Cloud Agent workspace.
 *
 * A workspace is the checkout: every root session in it shares the workspace's
 * repository and branch, so the PR is selected once per workspace rather than
 * per session. A candidate is either the PR cached for the workspace's branch
 * or a PR a root session verified. Unverified links are never candidates.
 *
 * This is a passive Postgres read. It never opens a sandbox or asks compute to
 * start, and it never calls GitHub. A workspace whose owner has no GitHub
 * integration therefore has no source for a cache row and returns no summary.
 * Completed-deletion tombstones are excluded. Cached values can be older than
 * `lastSyncedAt`, which is the cache write time.
 */
export async function readWorkspacePullRequestSummaries(
  env: Pick<Env, 'HYPERDRIVE'>,
  params: { userId: string; workspaces: readonly WorkspacePullRequestTarget[] }
): Promise<Map<string, WorkspacePullRequestSummary>> {
  const summaries = new Map<string, WorkspacePullRequestSummary>();
  const workspaceIds = [...new Set(params.workspaces.map(workspace => workspace.workspaceId))];
  if (workspaceIds.length === 0) return summaries;

  const db: WorkerDb = getPgDb(env);
  const workspaceBranchMatch = sql`
    ${cloud_agent_worktrees.deletion_started_at} is null
    and ${github_branch_pull_requests.git_url} = ${cloud_agent_worktrees.git_url}
    and ${github_branch_pull_requests.git_branch} = ${cloud_agent_worktrees.git_branch}
  `;

  const rows = await db
    .selectDistinctOn([cloud_agent_worktrees.worktree_id], {
      workspaceId: cloud_agent_worktrees.worktree_id,
      pr_url: github_branch_pull_requests.pr_url,
      pr_number: github_branch_pull_requests.pr_number,
      pr_state: github_branch_pull_requests.pr_state,
      pr_title: github_branch_pull_requests.pr_title,
      pr_head_sha: github_branch_pull_requests.pr_head_sha,
      pr_observations: github_branch_pull_requests.pr_observations,
      pr_last_synced_at: github_branch_pull_requests.pr_last_synced_at,
      pr_review_decision: github_branch_pull_requests.pr_review_decision,
      review_decision_pending: github_branch_pull_requests.review_decision_pending,
    })
    .from(cloud_agent_worktrees)
    .innerJoin(
      cli_sessions_v2,
      and(
        eq(cli_sessions_v2.cloud_agent_worktree_id, cloud_agent_worktrees.worktree_id),
        eq(cli_sessions_v2.kilo_user_id, params.userId),
        isNull(cli_sessions_v2.parent_session_id),
        sql`${cli_sessions_v2.organization_id} is not distinct from ${cloud_agent_worktrees.organization_id}`
      )
    )
    .innerJoin(
      github_branch_pull_requests,
      and(
        isNotNull(github_branch_pull_requests.pr_number),
        isNotNull(github_branch_pull_requests.pr_url),
        isNotNull(github_branch_pull_requests.pr_last_synced_at),
        or(
          and(
            isNotNull(cloud_agent_worktrees.organization_id),
            eq(
              github_branch_pull_requests.owned_by_organization_id,
              cloud_agent_worktrees.organization_id
            ),
            isNull(github_branch_pull_requests.owned_by_user_id)
          ),
          and(
            isNull(cloud_agent_worktrees.organization_id),
            eq(github_branch_pull_requests.owned_by_user_id, cloud_agent_worktrees.kilo_user_id),
            isNull(github_branch_pull_requests.owned_by_organization_id)
          )
        ),
        or(
          workspaceBranchMatch,
          and(
            isNotNull(cli_sessions_v2.pr_link_verified_at),
            isNotNull(cli_sessions_v2.git_url),
            isNotNull(cli_sessions_v2.pr_number),
            eq(github_branch_pull_requests.git_url, cli_sessions_v2.git_url),
            eq(github_branch_pull_requests.pr_number, cli_sessions_v2.pr_number)
          )
        )
      )
    )
    .where(
      and(
        inArray(cloud_agent_worktrees.worktree_id, workspaceIds),
        eq(cloud_agent_worktrees.kilo_user_id, params.userId),
        isNull(cloud_agent_worktrees.deletion_completed_at)
      )
    )
    .orderBy(
      asc(cloud_agent_worktrees.worktree_id),
      sql`coalesce(${github_branch_pull_requests.pr_state} in ('open', 'draft'), false) desc`,
      sql`coalesce((${workspaceBranchMatch}), false) desc`,
      desc(github_branch_pull_requests.pr_number)
    );

  for (const row of rows) {
    const summary = summarizeWorkspacePullRequest(row);
    if (summary !== null) summaries.set(row.workspaceId, summary);
  }
  return summaries;
}
