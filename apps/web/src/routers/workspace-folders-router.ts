import 'server-only';
import {
  cli_sessions_v2,
  cloud_agent_workspace_folders,
  cloud_agent_worktrees,
  kilocode_users,
  organization_memberships,
  organizations,
} from '@kilocode/db/schema';
import { isGoneOrDeletingBlockedReason } from '@kilocode/db/user-soft-delete';
import { cloudAgentWorktreeIdSchema } from '@kilocode/session-ingest-contracts';
import { TRPCError } from '@trpc/server';
import { and, asc, eq, inArray, isNull, max, sql } from 'drizzle-orm';
import * as z from 'zod';
import {
  workspaceFolderColorSchema,
  workspaceFolderNameSchema,
  type WorkspaceFolder,
} from '@/lib/cloud-agent/workspace-folders';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';

const uuidSchema = z.uuid().transform(id => id.toLowerCase());
const scopeInputSchema = z.object({ organizationId: uuidSchema.nullable() });
const folderInputSchema = z.object({ folderId: uuidSchema });
const workspaceSessionIdSchema = z.templateLiteral(['workspace_', z.uuid()]);
const folderOutputSchema = z.object({
  id: z.uuid(),
  name: workspaceFolderNameSchema,
  color: workspaceFolderColorSchema,
  worktreeIds: z.array(z.string()),
});

const folderFields = {
  id: cloud_agent_workspace_folders.id,
  name: cloud_agent_workspace_folders.name,
  color: cloud_agent_workspace_folders.color,
};

type FolderScope = { userId: string; organizationId: string | null };

function ownerScopeCondition(
  table:
    | typeof cloud_agent_workspace_folders
    | typeof cloud_agent_worktrees
    | typeof cli_sessions_v2,
  scope: FolderScope
) {
  return and(
    eq(table.kilo_user_id, scope.userId),
    scope.organizationId === null
      ? isNull(table.organization_id)
      : eq(table.organization_id, scope.organizationId)
  );
}

const workspaceFolderProcedure = baseProcedure
  .input(scopeInputSchema)
  .use(async ({ ctx, input, type, next }) =>
    db.transaction(async tx => {
      const scope: FolderScope = { userId: ctx.user.id, organizationId: input.organizationId };
      const [user] = await tx
        .select({ blockedReason: kilocode_users.blocked_reason })
        .from(kilocode_users)
        .where(eq(kilocode_users.id, scope.userId))
        .for(type === 'mutation' ? 'no key update' : 'key share');

      if (!user || isGoneOrDeletingBlockedReason(user.blockedReason)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Workspace folders are unavailable' });
      }

      if (scope.organizationId !== null) {
        const [membership] = await tx
          .select({ id: organization_memberships.id })
          .from(organization_memberships)
          .innerJoin(organizations, eq(organizations.id, organization_memberships.organization_id))
          .where(
            and(
              eq(organization_memberships.kilo_user_id, scope.userId),
              eq(organization_memberships.organization_id, scope.organizationId),
              isNull(organizations.deleted_at)
            )
          )
          .for('share', { of: organization_memberships });
        if (!membership) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Organization membership required' });
        }
      }

      const result = await next({ ctx: { folderDb: tx, folderScope: scope } });
      if (!result.ok) throw result.error;
      return result;
    })
  );

function ownedRootSessions(tx: DrizzleTransaction, scope: FolderScope, worktreeId: string) {
  return tx
    .select({
      createdAt: cli_sessions_v2.created_at,
      cloudAgentSessionId: cli_sessions_v2.cloud_agent_session_id,
    })
    .from(cli_sessions_v2)
    .where(
      and(
        ownerScopeCondition(cli_sessions_v2, scope),
        eq(cli_sessions_v2.cloud_agent_worktree_id, worktreeId),
        isNull(cli_sessions_v2.parent_session_id)
      )
    )
    .orderBy(asc(cli_sessions_v2.created_at), asc(cli_sessions_v2.session_id));
}

async function lockMovableWorktree(tx: DrizzleTransaction, scope: FolderScope, worktreeId: string) {
  const selectWorktree = () =>
    tx
      .select()
      .from(cloud_agent_worktrees)
      .where(eq(cloud_agent_worktrees.worktree_id, worktreeId))
      .for('update');

  let [worktree] = await selectWorktree();
  if (!worktree) {
    const roots = await ownedRootSessions(tx, scope, worktreeId);
    const firstRoot = roots.find(
      root => workspaceSessionIdSchema.safeParse(root.cloudAgentSessionId).success
    );
    if (!firstRoot) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Worktree not found' });
    }
    await tx
      .insert(cloud_agent_worktrees)
      .values({
        worktree_id: worktreeId,
        kilo_user_id: scope.userId,
        organization_id: scope.organizationId,
        created_at: firstRoot.createdAt,
      })
      .onConflictDoNothing({ target: cloud_agent_worktrees.worktree_id });
    [worktree] = await selectWorktree();
  }

  if (
    !worktree ||
    worktree.kilo_user_id !== scope.userId ||
    worktree.organization_id !== scope.organizationId
  ) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Worktree not found' });
  }
  if (worktree.deletion_started_at !== null || worktree.deletion_completed_at !== null) {
    throw new TRPCError({ code: 'CONFLICT', message: 'Worktree is being deleted' });
  }

  const roots = await ownedRootSessions(tx, scope, worktreeId).for('share');
  if (!roots.some(root => workspaceSessionIdSchema.safeParse(root.cloudAgentSessionId).success)) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Worktree not found' });
  }
}

export const workspaceFoldersRouter = createTRPCRouter({
  list: workspaceFolderProcedure
    .output(z.object({ folders: z.array(folderOutputSchema) }))
    .query(async ({ ctx }) => {
      const rows = await ctx.folderDb
        .select({
          ...folderFields,
          worktreeId: cloud_agent_worktrees.worktree_id,
          cloudAgentSessionId: cli_sessions_v2.cloud_agent_session_id,
        })
        .from(cloud_agent_workspace_folders)
        .leftJoin(
          cloud_agent_worktrees,
          and(
            eq(cloud_agent_worktrees.folder_id, cloud_agent_workspace_folders.id),
            ownerScopeCondition(cloud_agent_worktrees, ctx.folderScope),
            isNull(cloud_agent_worktrees.deletion_started_at),
            isNull(cloud_agent_worktrees.deletion_completed_at)
          )
        )
        .leftJoin(
          cli_sessions_v2,
          and(
            eq(cli_sessions_v2.cloud_agent_worktree_id, cloud_agent_worktrees.worktree_id),
            ownerScopeCondition(cli_sessions_v2, ctx.folderScope),
            isNull(cli_sessions_v2.parent_session_id)
          )
        )
        .where(ownerScopeCondition(cloud_agent_workspace_folders, ctx.folderScope))
        .orderBy(
          asc(cloud_agent_workspace_folders.position),
          asc(cloud_agent_workspace_folders.id),
          asc(cloud_agent_worktrees.worktree_id)
        );

      const folders = new Map<
        string,
        Omit<WorkspaceFolder, 'worktreeIds'> & { worktreeIds: Set<string> }
      >();
      for (const row of rows) {
        let folder = folders.get(row.id);
        if (!folder) {
          folder = { id: row.id, name: row.name, color: row.color, worktreeIds: new Set() };
          folders.set(row.id, folder);
        }
        const worktreeId = cloudAgentWorktreeIdSchema.safeParse(row.worktreeId);
        if (
          worktreeId.success &&
          workspaceSessionIdSchema.safeParse(row.cloudAgentSessionId).success
        ) {
          folder.worktreeIds.add(worktreeId.data);
        }
      }
      return {
        folders: Array.from(folders.values(), folder => ({
          ...folder,
          worktreeIds: [...folder.worktreeIds],
        })),
      };
    }),

  create: workspaceFolderProcedure
    .input(z.object({ name: workspaceFolderNameSchema, color: workspaceFolderColorSchema }))
    .output(folderOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const [last] = await ctx.folderDb
        .select({ position: max(cloud_agent_workspace_folders.position) })
        .from(cloud_agent_workspace_folders)
        .where(ownerScopeCondition(cloud_agent_workspace_folders, ctx.folderScope));
      const [folder] = await ctx.folderDb
        .insert(cloud_agent_workspace_folders)
        .values({
          kilo_user_id: ctx.folderScope.userId,
          organization_id: ctx.folderScope.organizationId,
          name: input.name,
          color: input.color,
          position: (last?.position ?? -1) + 1,
        })
        .returning(folderFields);
      if (!folder) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Folder creation failed' });
      }
      return { ...folder, worktreeIds: [] };
    }),

  update: workspaceFolderProcedure
    .input(
      folderInputSchema
        .extend({
          name: workspaceFolderNameSchema.optional(),
          color: workspaceFolderColorSchema.optional(),
        })
        .refine(input => input.name !== undefined || input.color !== undefined, {
          message: 'Provide a name or color',
        })
    )
    .mutation(async ({ ctx, input }) => {
      const [folder] = await ctx.folderDb
        .update(cloud_agent_workspace_folders)
        .set({ name: input.name, color: input.color })
        .where(
          and(
            ownerScopeCondition(cloud_agent_workspace_folders, ctx.folderScope),
            eq(cloud_agent_workspace_folders.id, input.folderId)
          )
        )
        .returning({ id: cloud_agent_workspace_folders.id });
      if (!folder) throw new TRPCError({ code: 'NOT_FOUND', message: 'Folder not found' });
      return { success: true };
    }),

  delete: workspaceFolderProcedure.input(folderInputSchema).mutation(async ({ ctx, input }) => {
    const [folder] = await ctx.folderDb
      .delete(cloud_agent_workspace_folders)
      .where(
        and(
          ownerScopeCondition(cloud_agent_workspace_folders, ctx.folderScope),
          eq(cloud_agent_workspace_folders.id, input.folderId)
        )
      )
      .returning({ id: cloud_agent_workspace_folders.id });
    if (!folder) throw new TRPCError({ code: 'NOT_FOUND', message: 'Folder not found' });
    return { success: true };
  }),

  moveWorktree: workspaceFolderProcedure
    .input(z.object({ worktreeId: cloudAgentWorktreeIdSchema, folderId: uuidSchema.nullable() }))
    .mutation(async ({ ctx, input }) => {
      if (input.folderId !== null) {
        const [folder] = await ctx.folderDb
          .select({ id: cloud_agent_workspace_folders.id })
          .from(cloud_agent_workspace_folders)
          .where(
            and(
              ownerScopeCondition(cloud_agent_workspace_folders, ctx.folderScope),
              eq(cloud_agent_workspace_folders.id, input.folderId)
            )
          )
          .for('key share');
        if (!folder) throw new TRPCError({ code: 'NOT_FOUND', message: 'Folder not found' });
      }

      await lockMovableWorktree(ctx.folderDb, ctx.folderScope, input.worktreeId);
      await ctx.folderDb
        .update(cloud_agent_worktrees)
        .set({ folder_id: input.folderId })
        .where(
          and(
            ownerScopeCondition(cloud_agent_worktrees, ctx.folderScope),
            eq(cloud_agent_worktrees.worktree_id, input.worktreeId)
          )
        );
      return { success: true };
    }),

  reorder: workspaceFolderProcedure
    .input(
      z.object({
        folderIds: z.array(uuidSchema).refine(ids => new Set(ids).size === ids.length, {
          message: 'Folder IDs must be unique',
        }),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const folders = await ctx.folderDb
        .select({ id: cloud_agent_workspace_folders.id })
        .from(cloud_agent_workspace_folders)
        .where(ownerScopeCondition(cloud_agent_workspace_folders, ctx.folderScope));
      const currentIds = new Set(folders.map(folder => folder.id));
      if (
        currentIds.size !== input.folderIds.length ||
        input.folderIds.some(id => !currentIds.has(id))
      ) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Folder order changed. Refresh and try again.',
        });
      }
      if (input.folderIds.length > 0) {
        await ctx.folderDb
          .update(cloud_agent_workspace_folders)
          .set({
            position: sql`CASE ${cloud_agent_workspace_folders.id} ${sql.join(
              input.folderIds.map(
                (id, position) => sql`WHEN ${id}::uuid THEN ${position}::integer`
              ),
              sql` `
            )} END`,
          })
          .where(
            and(
              ownerScopeCondition(cloud_agent_workspace_folders, ctx.folderScope),
              inArray(cloud_agent_workspace_folders.id, input.folderIds)
            )
          );
      }
      return { success: true };
    }),
});
