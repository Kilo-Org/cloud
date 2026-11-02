import 'server-only';
import {
  cli_sessions_v2,
  cloud_agent_workspace_folders,
  cloud_agent_worktrees,
} from '@kilocode/db/schema';
import { cloudAgentWorktreeIdSchema } from '@kilocode/session-ingest-contracts';
import { TRPCError } from '@trpc/server';
import { and, asc, eq, inArray, isNull, max, sql } from 'drizzle-orm';
import * as z from 'zod';
import { isUniqueViolation } from '@/lib/db-errors';
import {
  smartFolderPresetSchema,
  workspaceFolderColorSchema,
  workspaceFolderKindSchema,
  workspaceFolderNameSchema,
  workspaceFolderSortModeSchema,
  type WorkspaceFolder,
} from '@/lib/cloud-agent/workspace-folders';
import { type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import {
  cloudAgentSidebarScopeProcedure,
  ownerScopeCondition,
  uuidSchema,
  type SidebarScope,
} from './cloud-agent-sidebar-scope';

const folderInputSchema = z.object({ folderId: uuidSchema });
const workspaceSessionIdSchema = z.templateLiteral(['workspace_', z.uuid()]);
const folderOutputSchema = z.object({
  id: z.uuid(),
  name: workspaceFolderNameSchema,
  color: workspaceFolderColorSchema,
  kind: workspaceFolderKindSchema,
  smartPreset: smartFolderPresetSchema.nullable(),
  sortMode: workspaceFolderSortModeSchema,
  worktreeIds: z.array(z.string()),
});

const folderFields = {
  id: cloud_agent_workspace_folders.id,
  name: cloud_agent_workspace_folders.name,
  color: cloud_agent_workspace_folders.color,
  kind: cloud_agent_workspace_folders.kind,
  smartPreset: cloud_agent_workspace_folders.smart_preset,
  sortMode: cloud_agent_workspace_folders.sort_mode,
};

function ownedRootSessions(tx: DrizzleTransaction, scope: SidebarScope, worktreeId: string) {
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

async function lockMovableWorktree(
  tx: DrizzleTransaction,
  scope: SidebarScope,
  worktreeId: string
) {
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

const createFolderInputSchema = z
  .object({
    name: workspaceFolderNameSchema,
    color: workspaceFolderColorSchema,
    kind: workspaceFolderKindSchema.optional(),
    smartPreset: smartFolderPresetSchema.optional(),
    sortMode: workspaceFolderSortModeSchema.optional(),
  })
  .superRefine((input, ctx) => {
    if (input.kind === 'smart' && input.smartPreset === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['smartPreset'],
        message: 'A smart folder requires a preset',
      });
    }
    if (input.kind === 'manual' && input.smartPreset !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['smartPreset'],
        message: 'A manual folder cannot have a smart preset',
      });
    }
  });

export const workspaceFoldersRouter = createTRPCRouter({
  list: cloudAgentSidebarScopeProcedure
    .output(z.object({ folders: z.array(folderOutputSchema) }))
    .query(async ({ ctx }) => {
      const rows = await ctx.sidebarDb
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
            ownerScopeCondition(cloud_agent_worktrees, ctx.sidebarScope),
            isNull(cloud_agent_worktrees.deletion_started_at),
            isNull(cloud_agent_worktrees.deletion_completed_at)
          )
        )
        .leftJoin(
          cli_sessions_v2,
          and(
            eq(cli_sessions_v2.cloud_agent_worktree_id, cloud_agent_worktrees.worktree_id),
            ownerScopeCondition(cli_sessions_v2, ctx.sidebarScope),
            isNull(cli_sessions_v2.parent_session_id)
          )
        )
        .where(ownerScopeCondition(cloud_agent_workspace_folders, ctx.sidebarScope))
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
          folder = {
            id: row.id,
            name: row.name,
            color: row.color,
            kind: row.kind,
            smartPreset: row.smartPreset,
            sortMode: row.sortMode,
            worktreeIds: new Set(),
          };
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

  create: cloudAgentSidebarScopeProcedure
    .input(createFolderInputSchema)
    .output(folderOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const [last] = await ctx.sidebarDb
        .select({ position: max(cloud_agent_workspace_folders.position) })
        .from(cloud_agent_workspace_folders)
        .where(ownerScopeCondition(cloud_agent_workspace_folders, ctx.sidebarScope));

      try {
        const [folder] = await ctx.sidebarDb
          .insert(cloud_agent_workspace_folders)
          .values({
            kilo_user_id: ctx.sidebarScope.userId,
            organization_id: ctx.sidebarScope.organizationId,
            name: input.name,
            color: input.color,
            position: (last?.position ?? -1) + 1,
            kind: input.kind ?? (input.smartPreset === undefined ? 'manual' : 'smart'),
            smart_preset: input.smartPreset ?? null,
            ...(input.sortMode === undefined ? {} : { sort_mode: input.sortMode }),
          })
          .returning(folderFields);
        if (!folder) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Folder creation failed',
          });
        }
        return { ...folder, worktreeIds: [] };
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'That smart folder already exists',
          });
        }
        throw error;
      }
    }),

  update: cloudAgentSidebarScopeProcedure
    .input(
      folderInputSchema
        .extend({
          name: workspaceFolderNameSchema.optional(),
          color: workspaceFolderColorSchema.optional(),
          sortMode: workspaceFolderSortModeSchema.optional(),
        })
        .refine(
          input =>
            input.name !== undefined || input.color !== undefined || input.sortMode !== undefined,
          { message: 'Provide a name, color, or sort mode' }
        )
    )
    .mutation(async ({ ctx, input }) => {
      const [folder] = await ctx.sidebarDb
        .update(cloud_agent_workspace_folders)
        .set({ name: input.name, color: input.color, sort_mode: input.sortMode })
        .where(
          and(
            ownerScopeCondition(cloud_agent_workspace_folders, ctx.sidebarScope),
            eq(cloud_agent_workspace_folders.id, input.folderId)
          )
        )
        .returning({ id: cloud_agent_workspace_folders.id });
      if (!folder) throw new TRPCError({ code: 'NOT_FOUND', message: 'Folder not found' });
      return { success: true };
    }),

  delete: cloudAgentSidebarScopeProcedure
    .input(folderInputSchema)
    .mutation(async ({ ctx, input }) => {
      const [folder] = await ctx.sidebarDb
        .delete(cloud_agent_workspace_folders)
        .where(
          and(
            ownerScopeCondition(cloud_agent_workspace_folders, ctx.sidebarScope),
            eq(cloud_agent_workspace_folders.id, input.folderId)
          )
        )
        .returning({ id: cloud_agent_workspace_folders.id });
      if (!folder) throw new TRPCError({ code: 'NOT_FOUND', message: 'Folder not found' });
      return { success: true };
    }),

  moveWorktree: cloudAgentSidebarScopeProcedure
    .input(
      z.object({
        worktreeId: cloudAgentWorktreeIdSchema,
        folderId: uuidSchema.nullable(),
        position: z.string().min(1).max(1024).nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (input.folderId !== null) {
        const [folder] = await ctx.sidebarDb
          .select({
            id: cloud_agent_workspace_folders.id,
            kind: cloud_agent_workspace_folders.kind,
          })
          .from(cloud_agent_workspace_folders)
          .where(
            and(
              ownerScopeCondition(cloud_agent_workspace_folders, ctx.sidebarScope),
              eq(cloud_agent_workspace_folders.id, input.folderId)
            )
          )
          .for('key share');
        if (!folder) throw new TRPCError({ code: 'NOT_FOUND', message: 'Folder not found' });
        if (folder.kind === 'smart') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Workspaces cannot be moved into a smart folder',
          });
        }
      }

      await lockMovableWorktree(ctx.sidebarDb, ctx.sidebarScope, input.worktreeId);
      await ctx.sidebarDb
        .update(cloud_agent_worktrees)
        .set({
          folder_id: input.folderId,
          ...(input.position === undefined ? {} : { sidebar_position: input.position }),
        })
        .where(
          and(
            ownerScopeCondition(cloud_agent_worktrees, ctx.sidebarScope),
            eq(cloud_agent_worktrees.worktree_id, input.worktreeId)
          )
        );
      return { success: true };
    }),

  reorder: cloudAgentSidebarScopeProcedure
    .input(
      z.object({
        folderIds: z.array(uuidSchema).refine(ids => new Set(ids).size === ids.length, {
          message: 'Folder IDs must be unique',
        }),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const folders = await ctx.sidebarDb
        .select({ id: cloud_agent_workspace_folders.id })
        .from(cloud_agent_workspace_folders)
        .where(ownerScopeCondition(cloud_agent_workspace_folders, ctx.sidebarScope));
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
        await ctx.sidebarDb
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
              ownerScopeCondition(cloud_agent_workspace_folders, ctx.sidebarScope),
              inArray(cloud_agent_workspace_folders.id, input.folderIds)
            )
          );
      }
      return { success: true };
    }),
});
