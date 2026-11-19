import 'server-only';

import { cli_sessions_v2, cloud_agent_worktrees } from '@kilocode/db/schema';
import { cloudAgentWorktreeIdSchema } from '@kilocode/session-ingest-contracts';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { baseProcedure } from '@kilocode/web-shared/lib/trpc/init';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import { activeOrganizationAccessSql } from '@kilocode/worker-utils/organization-membership';
import { TRPCError } from '@trpc/server';
import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { queueWorkspaceUpdates } from './session-events';

const sessionIdSchema = z.string().min(1).max(200);
const scopeSchema = z.object({ organizationId: z.uuid().toLowerCase().nullable() });

export const workspaceTabInputSchema = scopeSchema.extend({
  worktreeId: cloudAgentWorktreeIdSchema,
  sessionId: sessionIdSchema,
});
export const reorderWorkspaceTabInputSchema = workspaceTabInputSchema.extend({
  beforeSessionId: sessionIdSchema.nullable(),
});
export const replaceWorkspaceTabInputSchema = scopeSchema.extend({
  worktreeId: cloudAgentWorktreeIdSchema,
  oldSessionId: sessionIdSchema,
  newSessionId: sessionIdSchema,
});
export const importWorkspaceTabsInputSchema = scopeSchema.extend({
  closedSessionIds: z.array(sessionIdSchema).max(10_000),
  sessionOrderByWorktree: z
    .record(cloudAgentWorktreeIdSchema, z.array(sessionIdSchema).max(2_000))
    .refine(orders => Object.keys(orders).length <= 500, 'Too many workspaces')
    .refine(
      orders => Object.values(orders).reduce((count, ids) => count + ids.length, 0) <= 10_000,
      'Too many chat tabs'
    ),
});

export type WorkspaceTabScope = { userId: string; organizationId: string | null };
type WorkspaceTabDatabase = Pick<typeof db, 'select' | 'update' | 'transaction'>;
type TabUpdate = Pick<
  typeof cloud_agent_worktrees.$inferInsert,
  'closed_session_ids' | 'tab_order'
>;
type TabExpressions = { [Key in keyof Required<TabUpdate>]: SQL<string[]> };

function ownerScope(
  table: typeof cloud_agent_worktrees | typeof cli_sessions_v2,
  scope: WorkspaceTabScope
) {
  return and(
    eq(table.kilo_user_id, scope.userId),
    scope.organizationId === null
      ? isNull(table.organization_id)
      : eq(table.organization_id, scope.organizationId)
  );
}

function writableWorkspace(scope: WorkspaceTabScope, worktreeId?: string) {
  return and(
    ownerScope(cloud_agent_worktrees, scope),
    worktreeId === undefined ? undefined : eq(cloud_agent_worktrees.worktree_id, worktreeId),
    isNull(cloud_agent_worktrees.deletion_started_at),
    isNull(cloud_agent_worktrees.deletion_completed_at),
    activeOrganizationAccessSql(cloud_agent_worktrees.organization_id, scope.userId)
  );
}

function rootMembership(scope: WorkspaceTabScope, sessionId: string | SQL) {
  return sql`exists (
    select 1 from ${cli_sessions_v2}
    where ${ownerScope(cli_sessions_v2, scope)}
      and ${cli_sessions_v2.cloud_agent_worktree_id} = ${cloud_agent_worktrees.worktree_id}
      and ${cli_sessions_v2.session_id} = ${sessionId}
      and ${cli_sessions_v2.parent_session_id} is null
  )`;
}

function textArray(values: readonly string[]): SQL<string[]> {
  return sql`array[${sql.join(
    values.map(value => sql`${value}`),
    sql`, `
  )}]::text[]`;
}

function openTabOrder(scope: WorkspaceTabScope): SQL<string[]> {
  return sql`array(
    select ${cli_sessions_v2.session_id} from ${cli_sessions_v2}
    where ${ownerScope(cli_sessions_v2, scope)}
      and ${cli_sessions_v2.cloud_agent_worktree_id} = ${cloud_agent_worktrees.worktree_id}
      and ${cli_sessions_v2.parent_session_id} is null
      and not (${cli_sessions_v2.session_id} = any(${cloud_agent_worktrees.closed_session_ids}))
    order by array_position(${cloud_agent_worktrees.tab_order}, ${cli_sessions_v2.session_id}) nulls last,
      ${cli_sessions_v2.created_at}, ${cli_sessions_v2.session_id}
  )`;
}

async function updateTabs(
  scope: WorkspaceTabScope,
  worktreeId: string,
  sessionIds: readonly string[],
  expressions: TabExpressions,
  fromDb: WorkspaceTabDatabase
) {
  const rows = await fromDb.transaction(async tx => {
    const [workspace] = await tx
      .select({ worktreeId: cloud_agent_worktrees.worktree_id })
      .from(cloud_agent_worktrees)
      .where(writableWorkspace(scope, worktreeId))
      .for('update');
    if (!workspace) return [];
    return tx
      .update(cloud_agent_worktrees)
      .set(expressions)
      .where(
        and(
          writableWorkspace(scope, worktreeId),
          ...sessionIds.map(sessionId => rootMembership(scope, sessionId))
        )
      )
      .returning({ worktreeId: cloud_agent_worktrees.worktree_id });
  });
  if (rows.length === 0) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Workspace chat not found' });
  }
  return { worktreeIds: rows.map(row => row.worktreeId) };
}

export function closeWorkspaceTab(
  scope: WorkspaceTabScope,
  input: z.infer<typeof workspaceTabInputSchema>,
  fromDb: WorkspaceTabDatabase = db
) {
  return updateTabs(
    scope,
    input.worktreeId,
    [input.sessionId],
    {
      closed_session_ids: sql`${textArray([input.sessionId])} || array_remove(${cloud_agent_worktrees.closed_session_ids}, ${input.sessionId})`,
      tab_order: sql`array_remove(${cloud_agent_worktrees.tab_order}, ${input.sessionId})`,
    },
    fromDb
  );
}

export function reopenWorkspaceTab(
  scope: WorkspaceTabScope,
  input: z.infer<typeof workspaceTabInputSchema>,
  fromDb: WorkspaceTabDatabase = db
) {
  return updateTabs(
    scope,
    input.worktreeId,
    [input.sessionId],
    {
      closed_session_ids: sql`array_remove(${cloud_agent_worktrees.closed_session_ids}, ${input.sessionId})`,
      tab_order: sql`case when ${input.sessionId} = any(${cloud_agent_worktrees.tab_order})
        then ${cloud_agent_worktrees.tab_order}
        when not (${input.sessionId} = any(${cloud_agent_worktrees.closed_session_ids}))
          then ${openTabOrder(scope)}
        else ${openTabOrder(scope)} || ${textArray([input.sessionId])} end`,
    },
    fromDb
  );
}

export function reorderWorkspaceTab(
  scope: WorkspaceTabScope,
  input: z.infer<typeof reorderWorkspaceTabInputSchema>,
  fromDb: WorkspaceTabDatabase = db
) {
  const remaining = sql<string[]>`array_remove(${openTabOrder(scope)}, ${input.sessionId})`;
  const tabOrder =
    input.beforeSessionId === null
      ? sql<string[]>`${remaining} || ${textArray([input.sessionId])}`
      : sql<string[]>`array(
          select value from (
            select value, ordinal * 2 as position
              from unnest(${remaining}) with ordinality as tabs(value, ordinal)
            union all select ${input.sessionId},
              coalesce(array_position(${remaining}, ${input.beforeSessionId})::bigint * 2 - 1,
                cardinality(${remaining})::bigint * 2 + 1)
          ) ordered_tabs order by position
        )`;
  return updateTabs(
    scope,
    input.worktreeId,
    input.beforeSessionId === null ? [input.sessionId] : [input.sessionId, input.beforeSessionId],
    {
      closed_session_ids: sql`${cloud_agent_worktrees.closed_session_ids}`,
      tab_order:
        input.beforeSessionId === input.sessionId
          ? sql`${cloud_agent_worktrees.tab_order}`
          : tabOrder,
    },
    fromDb
  );
}

export function replaceWorkspaceTab(
  scope: WorkspaceTabScope,
  input: z.infer<typeof replaceWorkspaceTabInputSchema>,
  fromDb: WorkspaceTabDatabase = db
) {
  if (input.oldSessionId === input.newSessionId) {
    return reopenWorkspaceTab(scope, { ...input, sessionId: input.newSessionId }, fromDb);
  }
  const withoutNew = sql<string[]>`array_remove(${openTabOrder(scope)}, ${input.newSessionId})`;
  return updateTabs(
    scope,
    input.worktreeId,
    [input.oldSessionId, input.newSessionId],
    {
      closed_session_ids: sql`${textArray([input.oldSessionId])} || array_remove(array_remove(
        ${cloud_agent_worktrees.closed_session_ids}, ${input.newSessionId}), ${input.oldSessionId})`,
      tab_order: sql`case when ${input.oldSessionId} = any(${withoutNew})
        then array_replace(${withoutNew}, ${input.oldSessionId}, ${input.newSessionId})
        else ${withoutNew} || ${textArray([input.newSessionId])} end`,
    },
    fromDb
  );
}

export async function importWorkspaceTabs(
  scope: WorkspaceTabScope,
  input: z.infer<typeof importWorkspaceTabsInputSchema>,
  fromDb: WorkspaceTabDatabase = db
) {
  const allIds = [
    ...new Set([...input.closedSessionIds, ...Object.values(input.sessionOrderByWorktree).flat()]),
  ];
  if (allIds.length === 0) return { worktreeIds: [] };
  const memberships = await fromDb
    .select({
      sessionId: cli_sessions_v2.session_id,
      worktreeId: cli_sessions_v2.cloud_agent_worktree_id,
    })
    .from(cli_sessions_v2)
    .innerJoin(
      cloud_agent_worktrees,
      eq(cloud_agent_worktrees.worktree_id, cli_sessions_v2.cloud_agent_worktree_id)
    )
    .where(
      and(
        ownerScope(cli_sessions_v2, scope),
        ownerScope(cloud_agent_worktrees, scope),
        isNull(cli_sessions_v2.parent_session_id),
        isNull(cloud_agent_worktrees.deletion_started_at),
        isNull(cloud_agent_worktrees.deletion_completed_at),
        activeOrganizationAccessSql(cloud_agent_worktrees.organization_id, scope.userId),
        inArray(cli_sessions_v2.session_id, allIds)
      )
    );
  const membershipById = new Map(memberships.map(row => [row.sessionId, row.worktreeId]));
  const groups = new Map<string, { closed: string[]; order: string[] }>();
  const group = (worktreeId: string) => {
    let value = groups.get(worktreeId);
    if (!value) {
      value = { closed: [], order: [] };
      groups.set(worktreeId, value);
    }
    return value;
  };
  const closedIds = new Set(input.closedSessionIds);
  for (const id of new Set(input.closedSessionIds.toReversed())) {
    const worktreeId = membershipById.get(id);
    if (worktreeId) group(worktreeId).closed.push(id);
  }
  for (const [worktreeId, order] of Object.entries(input.sessionOrderByWorktree)) {
    for (const id of new Set(order)) {
      if (!closedIds.has(id) && membershipById.get(id) === worktreeId)
        group(worktreeId).order.push(id);
    }
  }
  const worktreeIds = [...groups.keys()].sort();
  if (worktreeIds.length === 0) return { worktreeIds: [] };
  const importedArray = (field: 'closed' | 'order') => sql<
    string[]
  >`case ${cloud_agent_worktrees.worktree_id}
    ${sql.join(
      [...groups].map(([id, values]) => sql`when ${id} then ${textArray(values[field])}`),
      sql` `
    )}
    else '{}'::text[] end`;
  const unseenMembers = (ids: SQL<string[]>) => sql<string[]>`array(
    select value from unnest(${ids}) with ordinality as imported(value, ordinal)
    where not (value = any(${cloud_agent_worktrees.closed_session_ids} || ${cloud_agent_worktrees.tab_order}))
      and ${rootMembership(scope, sql`imported.value`)}
    order by ordinal
  )`;
  const rows = await fromDb.transaction(async tx => {
    const condition = and(
      writableWorkspace(scope),
      inArray(cloud_agent_worktrees.worktree_id, worktreeIds)
    );
    await tx
      .select({ worktreeId: cloud_agent_worktrees.worktree_id })
      .from(cloud_agent_worktrees)
      .where(condition)
      .orderBy(cloud_agent_worktrees.worktree_id)
      .for('update');
    return tx
      .update(cloud_agent_worktrees)
      .set({
        closed_session_ids: sql`${cloud_agent_worktrees.closed_session_ids} || ${unseenMembers(importedArray('closed'))}`,
        tab_order: sql`${cloud_agent_worktrees.tab_order} || ${unseenMembers(importedArray('order'))}`,
      })
      .where(condition)
      .returning({ worktreeId: cloud_agent_worktrees.worktree_id });
  });
  return { worktreeIds: rows.map(row => row.worktreeId) };
}

const workspaceTabProcedure = baseProcedure.input(scopeSchema).use(async ({ ctx, input, next }) => {
  if (input.organizationId !== null) await ensureOrganizationAccess(ctx, input.organizationId);
  return next({ ctx: { tabScope: { userId: ctx.user.id, organizationId: input.organizationId } } });
});

async function updateAndNotify(
  scope: WorkspaceTabScope,
  update: Promise<{ worktreeIds: string[] }>
) {
  const result = await update;
  queueWorkspaceUpdates(scope, result.worktreeIds);
  return result;
}

export const workspaceTabProcedures = {
  closeWorkspaceTab: workspaceTabProcedure
    .input(workspaceTabInputSchema)
    .mutation(({ ctx, input }) =>
      updateAndNotify(ctx.tabScope, closeWorkspaceTab(ctx.tabScope, input))
    ),
  reopenWorkspaceTab: workspaceTabProcedure
    .input(workspaceTabInputSchema)
    .mutation(({ ctx, input }) =>
      updateAndNotify(ctx.tabScope, reopenWorkspaceTab(ctx.tabScope, input))
    ),
  reorderWorkspaceTab: workspaceTabProcedure
    .input(reorderWorkspaceTabInputSchema)
    .mutation(({ ctx, input }) =>
      updateAndNotify(ctx.tabScope, reorderWorkspaceTab(ctx.tabScope, input))
    ),
  replaceWorkspaceTab: workspaceTabProcedure
    .input(replaceWorkspaceTabInputSchema)
    .mutation(({ ctx, input }) =>
      updateAndNotify(ctx.tabScope, replaceWorkspaceTab(ctx.tabScope, input))
    ),
  importWorkspaceTabs: workspaceTabProcedure
    .input(importWorkspaceTabsInputSchema)
    .mutation(({ ctx, input }) =>
      updateAndNotify(ctx.tabScope, importWorkspaceTabs(ctx.tabScope, input))
    ),
};
