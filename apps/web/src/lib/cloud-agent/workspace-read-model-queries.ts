import 'server-only';
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { cloud_agent_worktrees } from '@kilocode/db/schema';
import { activeOrganizationAccessSql } from '@kilocode/worker-utils/organization-membership';
import { KNOWN_PLATFORMS } from '@kilocode/app-shared/platforms';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { normalizeGitUrl } from '@/lib/integrations/platforms/github/normalize-git-url';
import { MAX_STACK_ANCESTRY } from '@/components/cloud-agent-next/workspace-stacks';
import { WORKSPACE_STALE_STATUS_MS } from './workspace-activity';

export type WorkspaceReadScope = { userId: string; organizationId: string | null };
type WorkspaceDirectoryFilters = {
  createdOnPlatform?: string | string[];
  gitUrl?: string | string[];
};

const timestamp = z.string().transform(value => new Date(value).toISOString());
export const workspaceChatSummarySchema = z.object({
  sessionId: z.string(),
  title: z.string().nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
  lastActivityAt: timestamp.nullable(),
  cloudAgentSessionId: z.string().nullable(),
  sessionStatus: z.string().nullable(),
  sessionStatusUpdatedAt: timestamp.nullable(),
});

export type WorkspaceChatSummary = z.infer<typeof workspaceChatSummarySchema>;

const activitySchema = workspaceChatSummarySchema.extend({
  latestRunFailureKind: z.enum(['failed', 'system_interrupted']).nullable(),
  latestRunTerminalAt: timestamp.nullable(),
});

const prSchema = z.object({
  pr_url: z.string().nullable(),
  pr_number: z.number().nullable(),
  pr_state: z.string().nullable(),
  pr_title: z.string().nullable(),
  pr_head_sha: z.string().nullable(),
  pr_last_synced_at: timestamp.nullable(),
  pr_review_decision: z.string().nullable(),
  review_decision_pending: z.boolean().nullable(),
  pr_base_ref: z.string().nullable(),
  stack_number: z.number().nullable(),
  stack_position: z.number().nullable(),
  stack_size: z.number().nullable(),
});

const directoryRowSchema = z.object({
  worktreeId: z.string(),
  name: z.string().nullable(),
  gitUrl: z.string().nullable(),
  branch: z.string().nullable(),
  folderId: z.string().nullable(),
  sidebarPosition: z.string().nullable(),
  parentWorktreeId: z.string().nullable(),
  baseBranch: z.string().nullable(),
  baseSha: z.string().nullable(),
  createdAt: timestamp,
  lastActivityAt: timestamp,
  latest: activitySchema,
  active: z.array(activitySchema),
  pr: prSchema.nullable(),
  searchMatch: z.boolean(),
});

export type WorkspaceDirectoryRow = z.infer<typeof directoryRowSchema>;
const stackDirectoryRowSchema = directoryRowSchema.pick({
  worktreeId: true,
  parentWorktreeId: true,
  branch: true,
  baseBranch: true,
  gitUrl: true,
  pr: true,
});
export type WorkspaceStackDirectoryRow = z.infer<typeof stackDirectoryRowSchema>;

function scopedDirectory(scope: WorkspaceReadScope): SQL {
  const organizationScope =
    scope.organizationId === null
      ? sql`${cloud_agent_worktrees.organization_id} IS NULL`
      : sql`${cloud_agent_worktrees.organization_id} = ${scope.organizationId}::uuid
          AND ${activeOrganizationAccessSql(cloud_agent_worktrees.organization_id, scope.userId)}`;
  return sql`SELECT * FROM ${cloud_agent_worktrees}
    WHERE ${cloud_agent_worktrees.kilo_user_id} = ${scope.userId}
      AND ${organizationScope}
      AND ${cloud_agent_worktrees.deletion_started_at} IS NULL
      AND ${cloud_agent_worktrees.deletion_completed_at} IS NULL`;
}

function directoryCtes(scope: WorkspaceReadScope, worktreeIds?: readonly string[]): SQL {
  if (!worktreeIds)
    return sql`scoped_workspaces AS (${scopedDirectory(scope)}),
    workspace_directory AS (SELECT * FROM scoped_workspaces)`;
  return sql`scoped_workspaces AS MATERIALIZED (${scopedDirectory(scope)}),
    workspace_seeds AS (
      SELECT w.worktree_id, coalesce(w.git_url, visible.git_url) AS git_url
      FROM scoped_workspaces w
      LEFT JOIN LATERAL (
        SELECT s.git_url FROM cli_sessions_v2 s
        WHERE s.kilo_user_id = w.kilo_user_id AND s.cloud_agent_worktree_id = w.worktree_id
          AND s.organization_id IS NOT DISTINCT FROM w.organization_id
          AND s.parent_session_id IS NULL AND ${visibleChat}
        ORDER BY coalesce(s.last_activity_at, s.created_at) DESC, s.session_id DESC NULLS LAST LIMIT 1
      ) visible ON w.git_url IS NULL
      WHERE w.worktree_id = ANY(${sql.param(worktreeIds)}::text[])
    ),
    workspace_ancestors AS (
      SELECT worktree_id, parent_worktree_id, ARRAY[worktree_id] AS path
      FROM scoped_workspaces
      WHERE worktree_id IN (SELECT worktree_id FROM workspace_seeds)
      UNION ALL
      SELECT parent.worktree_id, parent.parent_worktree_id, ancestors.path || parent.worktree_id
      FROM scoped_workspaces parent
      INNER JOIN workspace_ancestors ancestors ON parent.worktree_id = ancestors.parent_worktree_id
      WHERE cardinality(ancestors.path) < ${MAX_STACK_ANCESTRY}
        AND NOT parent.worktree_id = ANY(ancestors.path)
    ),
    workspace_family AS (
      SELECT worktree_id FROM workspace_ancestors
      UNION
      SELECT child.worktree_id FROM scoped_workspaces child
      INNER JOIN workspace_family family ON child.parent_worktree_id = family.worktree_id
    ),
    workspace_pr_base_refs AS (
      SELECT git_url, pr_base_ref AS branch FROM github_branch_pull_requests
      WHERE pr_number IS NOT NULL AND pr_base_ref IS NOT NULL
        AND ${scope.organizationId === null ? sql`owned_by_user_id = ${scope.userId}` : sql`owned_by_organization_id = ${scope.organizationId}::uuid`}
        AND git_url IN (SELECT git_url FROM workspace_seeds)
    ),
    workspace_inferred_branches AS (
      SELECT git_url, git_branch AS branch FROM github_branch_pull_requests
      WHERE pr_number IS NOT NULL
        AND ${scope.organizationId === null ? sql`owned_by_user_id = ${scope.userId}` : sql`owned_by_organization_id = ${scope.organizationId}::uuid`}
        AND git_url IN (SELECT git_url FROM workspace_seeds)
      UNION
      SELECT git_url, branch FROM workspace_pr_base_refs
    ),
    workspace_chat_base_candidates AS (
      SELECT DISTINCT s.cloud_agent_worktree_id AS worktree_id
      FROM workspace_pr_base_refs refs
      INNER JOIN cli_sessions_v2 s ON s.git_url = refs.git_url AND s.git_branch = refs.branch
      WHERE s.kilo_user_id = ${scope.userId}
        AND s.organization_id IS NOT DISTINCT FROM ${scope.organizationId}::uuid
        AND s.cloud_agent_worktree_id IS NOT NULL
        AND s.parent_session_id IS NULL AND ${visibleChat}
    ),
    workspace_directory AS (
      SELECT * FROM scoped_workspaces
      WHERE worktree_id IN (SELECT worktree_id FROM workspace_family)
        OR (git_url IS NULL AND (
          git_branch IN (SELECT branch FROM workspace_pr_base_refs)
          OR worktree_id IN (SELECT worktree_id FROM workspace_chat_base_candidates)
        ))
        OR (git_url IN (
            SELECT git_url FROM scoped_workspaces
            WHERE worktree_id IN (SELECT worktree_id FROM workspace_family)
            UNION SELECT git_url FROM workspace_seeds
          ) AND (
            parent_worktree_id IS NOT NULL
            OR worktree_id IN (SELECT parent_worktree_id FROM scoped_workspaces WHERE parent_worktree_id IS NOT NULL)
            OR (git_url, git_branch) IN (SELECT git_url, branch FROM workspace_inferred_branches)
          )
        )
        OR (git_url IS NULL AND (
          parent_worktree_id IS NOT NULL
          OR worktree_id IN (SELECT parent_worktree_id FROM scoped_workspaces WHERE parent_worktree_id IS NOT NULL)
        ))
    )`;
}

function platformCondition(createdOnPlatform?: string | string[]): SQL {
  if (!createdOnPlatform) return sql`true`;
  const platforms = Array.isArray(createdOnPlatform) ? createdOnPlatform : [createdOnPlatform];
  const concrete = platforms.filter(platform => platform !== 'other');
  // OFFSET keeps PostgreSQL from replacing this bounded probe with a historical-chat semijoin.
  return sql`EXISTS (
    SELECT 1 FROM cli_sessions_v2 platform_session
    WHERE platform_session.kilo_user_id = w.kilo_user_id
      AND platform_session.cloud_agent_worktree_id = w.worktree_id
      AND platform_session.organization_id IS NOT DISTINCT FROM w.organization_id
      AND platform_session.parent_session_id IS NULL
      AND (platform_session.created_on_platform = ANY(${sql.param(concrete)}::text[])
        OR (${platforms.includes('other')} AND NOT platform_session.created_on_platform = ANY(${sql.param([...KNOWN_PLATFORMS])}::text[])))
      AND (platform_session.title IS NOT NULL OR platform_session.status IS NOT NULL
        OR platform_session.created_on_platform != 'unknown' OR platform_session.total_cost_microdollars IS NOT NULL)
    LIMIT 1 OFFSET 0
  )`;
}

const visibleChat = sql`(s.title IS NOT NULL OR s.status IS NOT NULL
  OR s.created_on_platform != 'unknown' OR s.total_cost_microdollars IS NOT NULL)`;

const chatJson = sql`jsonb_build_object(
  'sessionId', s.session_id, 'title', s.title,
  'createdAt', s.created_at, 'updatedAt', s.updated_at,
  'lastActivityAt', s.last_activity_at, 'cloudAgentSessionId', s.cloud_agent_session_id,
  'sessionStatus', s.status, 'sessionStatusUpdatedAt', s.status_updated_at,
  'gitUrl', s.git_url, 'branch', s.git_branch
)`;

const latestRun = sql`SELECT status, failure_code, terminal_at
  FROM cloud_agent_session_runs
  WHERE cloud_agent_session_id = s.cloud_agent_session_id
  ORDER BY queued_at DESC NULLS LAST, message_id DESC NULLS LAST LIMIT 1`;

const activityJson = sql`${chatJson} || jsonb_build_object(
  'latestRunFailureKind', CASE
    WHEN run.status = 'failed' THEN 'failed'
    WHEN run.status = 'interrupted' AND run.failure_code IN ('system_interrupt', 'container_shutdown')
      THEN 'system_interrupted' ELSE NULL END,
  'latestRunTerminalAt', run.terminal_at
)`;

const workspacePrFields = sql`pr_url, pr_number, pr_state, pr_title, pr_head_sha,
  pr_last_synced_at, pr_review_decision, review_decision_pending, pr_base_ref,
  stack_number, stack_position, stack_size`;

function workspacePrQuery(fields: SQL) {
  return sql`SELECT ${fields}
  FROM github_branch_pull_requests
  WHERE git_url = w.git_url AND git_branch = w.git_branch AND pr_number IS NOT NULL
    AND ((w.organization_id IS NULL AND owned_by_user_id = w.kilo_user_id)
      OR owned_by_organization_id = w.organization_id)
  ORDER BY (pr_state IN ('open', 'draft')) DESC, pr_number DESC LIMIT 1`;
}

export function workspaceDirectoryQuery(
  scope: WorkspaceReadScope,
  options: WorkspaceDirectoryFilters & {
    directoryIds?: readonly string[];
    search?: string;
  } = {}
) {
  const urls = options.gitUrl
    ? (Array.isArray(options.gitUrl) ? options.gitUrl : [options.gitUrl]).map(normalizeGitUrl)
    : null;
  const needle = options.search;
  const searchMatch = needle
    ? sql`(position(${needle} in lower(coalesce(w.name, ''))) > 0
      OR position(${needle} in lower(coalesce(w.git_branch, ''))) > 0
      OR position(${needle} in lower(w.worktree_id)) > 0
      OR position(${needle} in lower(coalesce(pr.pr_title, ''))) > 0
      OR pr.pr_number::text = ${needle}
      OR EXISTS (SELECT 1 FROM cli_sessions_v2 s
        WHERE s.kilo_user_id = w.kilo_user_id AND s.cloud_agent_worktree_id = w.worktree_id
          AND s.organization_id IS NOT DISTINCT FROM w.organization_id
          AND s.parent_session_id IS NULL AND ${visibleChat}
          AND position(${needle} in lower(coalesce(s.title, ''))) > 0))`
    : sql`true`;
  return sql`WITH RECURSIVE ${directoryCtes(scope)}
    SELECT w.worktree_id AS "worktreeId", w.name,
      coalesce(w.git_url, latest.activity->>'gitUrl') AS "gitUrl",
      coalesce(w.git_branch, latest.activity->>'branch') AS branch,
      w.folder_id AS "folderId", w.sidebar_position AS "sidebarPosition",
      parent.worktree_id AS "parentWorktreeId",
      w.base_branch AS "baseBranch", w.base_sha AS "baseSha", w.created_at::text AS "createdAt",
      greatest(w.last_activity_at, coalesce((latest.activity->>'lastActivityAt')::timestamptz,
        (latest.activity->>'createdAt')::timestamptz, w.created_at))::text AS "lastActivityAt",
      latest.activity AS latest, coalesce(active.sessions, '[]'::jsonb) AS active,
      to_jsonb(pr) AS pr, coalesce(${searchMatch}, false) AS "searchMatch"
    FROM workspace_directory w
    LEFT JOIN cloud_agent_worktrees parent ON parent.worktree_id = w.parent_worktree_id
      AND parent.kilo_user_id = w.kilo_user_id AND parent.organization_id IS NOT DISTINCT FROM w.organization_id
      AND parent.deletion_started_at IS NULL AND parent.deletion_completed_at IS NULL
    INNER JOIN LATERAL (
      SELECT ${activityJson} AS activity FROM (
        SELECT * FROM cli_sessions_v2 s
        WHERE s.kilo_user_id = w.kilo_user_id AND s.cloud_agent_worktree_id = w.worktree_id
          AND s.organization_id IS NOT DISTINCT FROM w.organization_id
          AND s.parent_session_id IS NULL AND s.cloud_agent_worktree_id IS NOT NULL AND ${visibleChat}
        ORDER BY coalesce(s.last_activity_at, s.created_at) DESC, s.session_id DESC NULLS LAST LIMIT 1
      ) s LEFT JOIN LATERAL (${latestRun}) run ON true
    ) latest ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(${activityJson}) AS sessions FROM cli_sessions_v2 s
      LEFT JOIN LATERAL (${latestRun}) run ON true
      WHERE s.kilo_user_id = w.kilo_user_id AND s.cloud_agent_worktree_id = w.worktree_id
        AND s.organization_id IS NOT DISTINCT FROM w.organization_id
        AND s.parent_session_id IS NULL AND s.status IN ('question', 'permission', 'busy', 'retry')
        AND (s.status IN ('question', 'permission')
          OR coalesce(s.status_updated_at, s.updated_at) > ${new Date(Date.now() - WORKSPACE_STALE_STATUS_MS).toISOString()}::timestamptz)
    ) active ON true
    LEFT JOIN LATERAL (${workspacePrQuery(workspacePrFields)}) pr ON true
    WHERE ${platformCondition(options.createdOnPlatform)}
      AND ${urls ? sql`coalesce(w.git_url, latest.activity->>'gitUrl') = ANY(${sql.param(urls)}::text[])` : sql`true`}
      AND ${options.directoryIds ? sql`w.worktree_id = ANY(${sql.param(options.directoryIds)}::text[])` : sql`true`}
    ORDER BY w.worktree_id`;
}

export async function readWorkspaceDirectory(
  ...args: Parameters<typeof workspaceDirectoryQuery>
): Promise<WorkspaceDirectoryRow[]> {
  const { rows } = await db.execute(workspaceDirectoryQuery(...args));
  return z.array(directoryRowSchema).parse(rows);
}

export function workspaceStackDirectoryQuery(
  scope: WorkspaceReadScope,
  worktreeIds: readonly string[],
  options: WorkspaceDirectoryFilters = {}
) {
  const urls = options.gitUrl
    ? (Array.isArray(options.gitUrl) ? options.gitUrl : [options.gitUrl]).map(normalizeGitUrl)
    : null;
  return sql`WITH RECURSIVE ${directoryCtes(scope, worktreeIds)}
    SELECT w.worktree_id AS "worktreeId",
      coalesce(w.git_url, visible.git_url) AS "gitUrl",
      coalesce(w.git_branch, visible.git_branch) AS branch,
      parent.worktree_id AS "parentWorktreeId",
      w.base_branch AS "baseBranch",
      to_jsonb(pr) AS pr
    FROM workspace_directory w
    LEFT JOIN cloud_agent_worktrees parent ON parent.worktree_id = w.parent_worktree_id
      AND parent.kilo_user_id = w.kilo_user_id AND parent.organization_id IS NOT DISTINCT FROM w.organization_id
      AND parent.deletion_started_at IS NULL AND parent.deletion_completed_at IS NULL
    INNER JOIN LATERAL (SELECT s.git_url, s.git_branch, s.last_activity_at, s.created_at FROM cli_sessions_v2 s
      WHERE s.kilo_user_id = w.kilo_user_id AND s.cloud_agent_worktree_id = w.worktree_id
        AND s.organization_id IS NOT DISTINCT FROM w.organization_id
        AND s.parent_session_id IS NULL AND ${visibleChat}
      ORDER BY coalesce(s.last_activity_at, s.created_at) DESC, s.session_id DESC NULLS LAST LIMIT 1) visible ON true
    LEFT JOIN LATERAL (${workspacePrQuery(workspacePrFields)}) pr ON w.git_url IS NOT NULL
    WHERE ${platformCondition(options.createdOnPlatform)}
      AND (w.git_url IS NOT NULL OR w.worktree_id IN (SELECT worktree_id FROM workspace_family)
        OR w.parent_worktree_id IS NOT NULL
        OR w.worktree_id IN (SELECT parent_worktree_id FROM scoped_workspaces WHERE parent_worktree_id IS NOT NULL)
        OR (visible.git_url, coalesce(w.git_branch, visible.git_branch)) IN (
          SELECT git_url, branch FROM workspace_pr_base_refs
        ))
      AND ${urls ? sql`coalesce(w.git_url, visible.git_url) = ANY(${sql.param(urls)}::text[])` : sql`true`}
    ORDER BY w.worktree_id`;
}

export async function readWorkspaceStackDirectory(
  scope: WorkspaceReadScope,
  worktreeIds: readonly string[],
  options: WorkspaceDirectoryFilters = {}
) {
  const { rows } = await db.execute(workspaceStackDirectoryQuery(scope, worktreeIds, options));
  return z.array(stackDirectoryRowSchema).parse(rows);
}

const hydratedRowSchema = z.object({
  worktreeId: z.string(),
  rootSessionId: z.string(),
  rootTitle: z.string().nullable(),
  latestOpenSessionId: z.string().nullable(),
  latestOpenCloudAgentSessionId: z.string().nullable(),
  chatCount: z.number(),
  closedChatCount: z.number(),
  hasOpenRun: z.boolean(),
  observations: z.unknown(),
});

function workspaceSummaryHydrationQuery(scope: WorkspaceReadScope, worktreeIds: string[]) {
  return sql`WITH scoped_workspaces AS (${scopedDirectory(scope)}),
    workspace_open_runs AS (
      SELECT DISTINCT s.cloud_agent_worktree_id AS worktree_id
      FROM cli_sessions_v2 s INNER JOIN cloud_agent_session_runs open_run
        ON open_run.cloud_agent_session_id = s.cloud_agent_session_id
      WHERE s.kilo_user_id = ${scope.userId}
        AND ${scope.organizationId === null ? sql`s.organization_id IS NULL` : sql`s.organization_id = ${scope.organizationId}::uuid`}
        AND s.cloud_agent_worktree_id = ANY(${sql.param(worktreeIds)}::text[])
        AND s.parent_session_id IS NULL AND ${visibleChat}
        AND open_run.status IN ('queued', 'accepted')
        AND open_run.queued_at > ${new Date(Date.now() - WORKSPACE_STALE_STATUS_MS).toISOString()}::timestamptz
        AND NOT EXISTS (
          SELECT 1 FROM cloud_agent_session_runs newer
          WHERE newer.cloud_agent_session_id = open_run.cloud_agent_session_id
            AND (newer.queued_at > open_run.queued_at
              OR (newer.queued_at = open_run.queued_at AND newer.message_id > open_run.message_id))
        )
    )
    SELECT w.worktree_id AS "worktreeId", root.session_id AS "rootSessionId", root.title AS "rootTitle",
      latest_open.session_id AS "latestOpenSessionId",
      latest_open.cloud_agent_session_id AS "latestOpenCloudAgentSessionId",
      counts."chatCount", counts."closedChatCount", open_runs.worktree_id IS NOT NULL AS "hasOpenRun",
      pr.pr_observations AS observations
    FROM scoped_workspaces w
    LEFT JOIN workspace_open_runs open_runs ON open_runs.worktree_id = w.worktree_id
    LEFT JOIN LATERAL (${workspacePrQuery(sql`${workspacePrFields}, pr_observations`)}) pr ON true
    INNER JOIN LATERAL (
      SELECT s.session_id, s.title
      FROM cli_sessions_v2 s
      WHERE ${workspaceChatMembership}
      ORDER BY s.created_at, s.session_id LIMIT 1
    ) root ON true
    LEFT JOIN LATERAL (
      SELECT s.session_id, s.cloud_agent_session_id FROM cli_sessions_v2 s
      WHERE ${workspaceChatMembership} AND NOT (${chatIsClosed})
      ORDER BY coalesce(s.last_activity_at, s.created_at) DESC, s.session_id DESC LIMIT 1
    ) latest_open ON true
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS "chatCount",
        count(*) FILTER (WHERE ${chatIsClosed})::int AS "closedChatCount"
      FROM cli_sessions_v2 s WHERE ${workspaceChatMembership}
    ) counts
    WHERE w.worktree_id = ANY(${sql.param(worktreeIds)}::text[])`;
}

const workspaceChatMembership = sql`s.kilo_user_id = w.kilo_user_id
  AND s.cloud_agent_worktree_id = w.worktree_id
  AND s.organization_id IS NOT DISTINCT FROM w.organization_id
  AND s.parent_session_id IS NULL AND ${visibleChat}`;
const chatIsClosed = sql`s.session_id = ANY(w.closed_session_ids)`;

export async function hydrateWorkspaceSummaries(scope: WorkspaceReadScope, worktreeIds: string[]) {
  if (worktreeIds.length === 0) return [];
  const { rows } = await db.execute(workspaceSummaryHydrationQuery(scope, worktreeIds));
  return z.array(hydratedRowSchema).parse(rows);
}

export async function readWorkspaceChatPage(
  scope: WorkspaceReadScope,
  input: {
    worktreeId: string;
    limit: number;
    cursor?: { createdAt: string; sessionId: string; tabOrderVersion?: string };
    tabState?: 'open' | 'closed';
    sessionId?: string;
  }
) {
  const { cursor, tabState } = input;
  const tabPosition = (sessionId: SQL) =>
    tabState === 'closed'
      ? sql`array_position(w.closed_session_ids, ${sessionId})`
      : tabState === 'open'
        ? sql`coalesce(array_position(w.tab_order, ${sessionId}), 2147483647)`
        : sql`0`;
  const position = tabPosition(sql`s.session_id`);
  const tabOrderVersion =
    tabState === 'closed'
      ? sql`md5(jsonb_build_array(w.worktree_id, w.closed_session_ids)::text)`
      : tabState === 'open'
        ? sql`md5(jsonb_build_array(w.worktree_id, w.closed_session_ids, w.tab_order)::text)`
        : sql`NULL::text`;
  const { rows } = await db.execute(sql`WITH scoped_workspaces AS (${scopedDirectory(scope)})
    SELECT ${tabOrderVersion} AS "tabOrderVersion", to_jsonb(page) AS item
    FROM scoped_workspaces w
    LEFT JOIN LATERAL (
      SELECT ${chatJson} || jsonb_build_object('tabClosed', ${chatIsClosed}) AS chat,
        ${position} AS position, s.created_at, s.session_id,
        to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorCreatedAt"
      FROM cli_sessions_v2 s
      WHERE ${workspaceChatMembership}
        AND ${tabState === 'closed' ? chatIsClosed : tabState === 'open' ? sql`NOT (${chatIsClosed})` : sql`true`}
        AND ${input.sessionId ? sql`s.session_id = ${input.sessionId}` : sql`true`}
        AND ${cursor ? sql`(${position}, s.created_at, s.session_id) > (${tabPosition(sql`${cursor.sessionId}::text`)}, ${cursor.createdAt}::timestamptz, ${cursor.sessionId})` : sql`true`}
      ORDER BY position, s.created_at, s.session_id LIMIT ${input.limit + 1}
    ) page ON true
    WHERE w.worktree_id = ${input.worktreeId}
    ORDER BY page.position, page.created_at, page.session_id`);
  const parsedRows = z
    .array(
      z.object({
        tabOrderVersion: z.string().nullable(),
        item: z
          .object({
            chat: workspaceChatSummarySchema.extend({ tabClosed: z.boolean() }),
            cursorCreatedAt: z.iso.datetime(),
          })
          .nullable(),
      })
    )
    .parse(rows);
  const version = parsedRows[0]?.tabOrderVersion;
  if (tabState && cursor && version && cursor.tabOrderVersion !== version) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Workspace tabs changed. Start paging again without a cursor.',
    });
  }
  const parsed = parsedRows.flatMap(row => (row.item ? [row.item] : []));
  const hasMore = parsed.length > input.limit;
  const page = hasMore ? parsed.slice(0, input.limit) : parsed;
  const last = page.at(-1);
  return {
    chats: page.map(row => row.chat),
    nextCursor:
      hasMore && last
        ? {
            createdAt: last.cursorCreatedAt,
            sessionId: last.chat.sessionId,
            ...(version ? { tabOrderVersion: version } : {}),
          }
        : null,
  };
}
