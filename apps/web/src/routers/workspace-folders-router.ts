import 'server-only';
import {
  cli_sessions_v2,
  cloud_agent_workspace_folders,
  cloud_agent_worktrees,
  kilocode_users,
  operation_ledgers,
  organization_memberships,
  organizations,
} from '@kilocode/db/schema';
import { isGoneOrDeletingBlockedReason } from '@kilocode/db/user-soft-delete';
import {
  cloudAgentWorktreeIdSchema,
  cloudAgentWorktreeLocationSchema,
} from '@kilocode/session-ingest-contracts';
import { TRPCError } from '@trpc/server';
import { and, asc, eq, inArray, isNull, max, sql } from 'drizzle-orm';
import * as z from 'zod';
import { createControlTokenForRequest } from '@/lib/auth/resource-delegation';
import {
  createCloudAgentNextClient,
  rethrowCloudAgentError,
} from '@/lib/cloud-agent-next/cloud-agent-client';
import {
  workspaceFolderColorSchema,
  workspaceFolderNameSchema,
  type WorkspaceFolder,
} from '@/lib/cloud-agent/workspace-folders';
import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import {
  baseProcedure,
  createTRPCRouter,
  type TRPCContext,
} from '@kilocode/web-shared/lib/trpc/init';

const uuidSchema = z.uuid().transform(id => id.toLowerCase());
const scopeInputSchema = z.object({ organizationId: uuidSchema.nullable() });
const folderInputSchema = z.object({ folderId: uuidSchema });
const workspaceSessionIdSchema = z.templateLiteral(['workspace_', z.uuid()]);
const SCOPED_FOLDER_PROCEDURES = new Set([
  'workspaceFolders.list',
  'workspaceFolders.moveWorktree',
]);
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

/**
 * A Cloud Agent parent may only reach the folder surface through the shared
 * authority allowlist. Revalidate the live parent on the Worker before the
 * transaction opens, so a revoked authority or a remote failure cannot write.
 */
async function revalidateScopedFolderAccess(
  ctx: TRPCContext,
  procedure: string,
  organizationId: string | null,
  rawInput: unknown
): Promise<void> {
  const authority = ctx.cloudAgentAuthority;
  if (authority === undefined) return;
  if (
    !SCOPED_FOLDER_PROCEDURES.has(procedure) ||
    authority.ownerId !== ctx.user.id ||
    authority.organizationId !== organizationId
  ) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Cloud Agent authority denied' });
  }

  const { token } = await createControlTokenForRequest(ctx.user, 'cloud-agent-next', {
    headers: ctx.headersList,
    ...(authority.organizationId === null ? {} : { organizationId: authority.organizationId }),
    tokenSource: 'cloud-agent',
  });
  const client = createCloudAgentNextClient(token);
  const signedOrganizationId = authority.organizationId ?? undefined;

  if (procedure === 'workspaceFolders.list') {
    await client
      .listChildSessions({
        limit: 1,
        ...(signedOrganizationId === undefined ? {} : { organizationId: signedOrganizationId }),
      })
      .catch(rethrowCloudAgentError);
    return;
  }

  const target = z
    .object({
      cloudAgentSessionId: workspaceSessionIdSchema,
      worktreeId: cloudAgentWorktreeIdSchema,
    })
    .safeParse(rawInput);
  if (!target.success) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'A child workspace is required' });
  }
  if (target.data.cloudAgentSessionId === authority.parentSessionId) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Worktree not found' });
  }

  const session = await client
    .getSession(target.data.cloudAgentSessionId, signedOrganizationId)
    .catch(rethrowCloudAgentError);
  if (
    session.worktreeId !== target.data.worktreeId ||
    session.userId !== ctx.user.id ||
    (signedOrganizationId === undefined
      ? session.orgId != null
      : session.orgId !== signedOrganizationId)
  ) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Worktree not found' });
  }
}

const workspaceFolderProcedure = baseProcedure
  .input(scopeInputSchema)
  .use(async ({ ctx, input, path, type, getRawInput, next }) => {
    await revalidateScopedFolderAccess(ctx, path, input.organizationId, await getRawInput());
    return db.transaction(async tx => {
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
    });
  });

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

const worktreeRuntimeAllocationSchema = z.object({
  cloudAgentSessionId: z.string().min(1),
  sandboxId: cloudAgentWorktreeLocationSchema.shape.sandboxId,
  sandboxProvider: cloudAgentWorktreeLocationSchema.shape.provider,
});

/**
 * Runtime locations for a worktree materialized from a standalone session.
 *
 * Worktree rows created when a Cloud Agent session starts record the sandbox
 * that hosts it. Filing an already-ungrouped session has no create event, so
 * the row would start with `runtime_locations: []` and worktree deletion
 * could not locate the sandbox to tear it down. Read the same `create_cloud`
 * ledger entry that deletion's ownership fallback reads, so the materialized
 * row carries the location the teardown path needs.
 */
async function readWorktreeRuntimeLocations(
  tx: DrizzleTransaction,
  scope: FolderScope,
  cloudAgentSessionId: string
): Promise<{ sandboxId: string; provider: 'cloudflare' | 'vercel' | 'cloudflare-containers' }[]> {
  const rows = await tx
    .select({
      organizationId: operation_ledgers.organization_id,
      canonicalResult: operation_ledgers.canonical_result,
    })
    .from(operation_ledgers)
    .where(
      and(
        eq(operation_ledgers.kilo_user_id, scope.userId),
        eq(operation_ledgers.domain, 'session'),
        eq(operation_ledgers.intent, 'create_cloud'),
        isNull(operation_ledgers.resource_key),
        sql`${operation_ledgers.canonical_result}->>'cloudAgentSessionId' = ${cloudAgentSessionId}`
      )
    );

  const locations = new Map<
    string,
    { sandboxId: string; provider: 'cloudflare' | 'vercel' | 'cloudflare-containers' }
  >();
  for (const row of rows) {
    // Match the row's scope the way deletion's allocation fallback does
    // (`allocationLocation`), rather than filtering `organization_id` in SQL:
    // the column is text and a narrowing predicate would silently drop rows.
    if (row.organizationId !== scope.organizationId) continue;
    const allocation = worktreeRuntimeAllocationSchema.safeParse(row.canonicalResult);
    if (!allocation.success || allocation.data.cloudAgentSessionId !== cloudAgentSessionId) {
      continue;
    }
    const { sandboxId, sandboxProvider } = allocation.data;
    locations.set(`${sandboxProvider}:${sandboxId}`, { sandboxId, provider: sandboxProvider });
  }
  // Two distinct allocations mean the workspace was relocated; seeding either
  // would advertise a sandbox that no longer hosts it, so refuse to seed.
  if (locations.size > 1) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Workspace runtime history is unavailable. Refresh and try again.',
    });
  }
  return [...locations.values()];
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
    // The row may be missing because the worktree predates metadata
    // registration. Seed the location deletion needs from the same ledger
    // entry the standalone moveSession path uses, so this path cannot leave
    // runtime_locations empty either.
    const runtimeLocations = await readWorktreeRuntimeLocations(
      tx,
      scope,
      workspaceSessionIdSchema.parse(firstRoot.cloudAgentSessionId)
    );
    await tx
      .insert(cloud_agent_worktrees)
      .values({
        worktree_id: worktreeId,
        kilo_user_id: scope.userId,
        organization_id: scope.organizationId,
        created_at: firstRoot.createdAt,
        runtime_locations: runtimeLocations,
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

async function lockScopedChildSession(
  tx: DrizzleTransaction,
  scope: FolderScope,
  child: { cloudAgentSessionId: string; worktreeId: string }
) {
  const [session] = await tx
    .select({ worktreeId: cli_sessions_v2.cloud_agent_worktree_id })
    .from(cli_sessions_v2)
    .where(
      and(
        ownerScopeCondition(cli_sessions_v2, scope),
        eq(cli_sessions_v2.cloud_agent_session_id, child.cloudAgentSessionId)
      )
    )
    .for('update');
  if (!session || session.worktreeId !== child.worktreeId) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Worktree not found' });
  }
}

export const workspaceFoldersRouter = createTRPCRouter({
  list: workspaceFolderProcedure
    .output(z.object({ folders: z.array(folderOutputSchema) }))
    .query(async ({ ctx }) => {
      if (ctx.cloudAgentAuthority !== undefined) {
        // Scoped parents may choose a folder by metadata, but workspace IDs are
        // ordinary-user listing data and must not cross the authority boundary.
        const rows = await ctx.folderDb
          .select(folderFields)
          .from(cloud_agent_workspace_folders)
          .where(ownerScopeCondition(cloud_agent_workspace_folders, ctx.folderScope))
          .orderBy(
            asc(cloud_agent_workspace_folders.position),
            asc(cloud_agent_workspace_folders.id)
          );
        return {
          folders: rows.map(folder => ({ ...folder, worktreeIds: [] })),
        };
      }

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
    .input(
      z.object({
        worktreeId: cloudAgentWorktreeIdSchema,
        folderId: uuidSchema.nullable(),
        cloudAgentSessionId: workspaceSessionIdSchema.optional(),
      })
    )
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

      if (ctx.cloudAgentAuthority !== undefined) {
        if (input.cloudAgentSessionId === undefined) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'A child workspace is required' });
        }
        await lockScopedChildSession(ctx.folderDb, ctx.folderScope, {
          cloudAgentSessionId: input.cloudAgentSessionId,
          worktreeId: input.worktreeId,
        });
      }

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

  moveSession: workspaceFolderProcedure
    .input(z.object({ sessionId: workspaceSessionIdSchema, folderId: uuidSchema.nullable() }))
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

      const readSession = () =>
        ctx.folderDb
          .select({
            createdAt: cli_sessions_v2.created_at,
            cloudAgentWorktreeId: cli_sessions_v2.cloud_agent_worktree_id,
          })
          .from(cli_sessions_v2)
          .where(
            and(
              ownerScopeCondition(cli_sessions_v2, ctx.folderScope),
              eq(cli_sessions_v2.cloud_agent_session_id, input.sessionId),
              isNull(cli_sessions_v2.parent_session_id)
            )
          );

      // Read first so an ungrouped session can derive its worktree id without
      // taking a row lock. The authoritative lock is taken below in the same
      // order worktree deletion uses (worktree row, then root rows), which
      // avoids the ABBA deadlock of locking the root before its worktree.
      const [session] = await readSession();
      if (!session) throw new TRPCError({ code: 'NOT_FOUND', message: 'Session not found' });

      const groupedWorktreeId = session.cloudAgentWorktreeId;
      // An ungrouped session dropped on Ungrouped has nothing to move. Skip it
      // so direct callers cannot materialize a worktree by asking for the state
      // the session is already in.
      if (groupedWorktreeId === null && input.folderId === null) return { success: true };

      const worktreeId =
        groupedWorktreeId ?? `worktree_${input.sessionId.slice('workspace_'.length)}`;
      if (groupedWorktreeId) {
        await lockMovableWorktree(ctx.folderDb, ctx.folderScope, groupedWorktreeId);
        const [lockedSession] = await readSession().for('update');
        if (!lockedSession || lockedSession.cloudAgentWorktreeId !== groupedWorktreeId) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Session moved. Refresh and try again.',
          });
        }
      } else {
        const runtimeLocations = await readWorktreeRuntimeLocations(
          ctx.folderDb,
          ctx.folderScope,
          input.sessionId
        );
        await ctx.folderDb
          .insert(cloud_agent_worktrees)
          .values({
            worktree_id: worktreeId,
            kilo_user_id: ctx.folderScope.userId,
            organization_id: ctx.folderScope.organizationId,
            created_at: session.createdAt,
            runtime_locations: runtimeLocations,
          })
          .onConflictDoNothing({ target: cloud_agent_worktrees.worktree_id });
        // The insert may have conflicted with an existing row, so lock it and
        // re-validate ownership and the deletion fence before linking the
        // session. Without this, a conflicting foreign or deleting worktree
        // would be linked and the mutation could report success.
        const [worktree] = await ctx.folderDb
          .select({
            kiloUserId: cloud_agent_worktrees.kilo_user_id,
            organizationId: cloud_agent_worktrees.organization_id,
            deletionStartedAt: cloud_agent_worktrees.deletion_started_at,
            deletionCompletedAt: cloud_agent_worktrees.deletion_completed_at,
          })
          .from(cloud_agent_worktrees)
          .where(eq(cloud_agent_worktrees.worktree_id, worktreeId))
          .for('update');
        if (
          !worktree ||
          worktree.kiloUserId !== ctx.folderScope.userId ||
          worktree.organizationId !== ctx.folderScope.organizationId
        ) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Worktree not found' });
        }
        if (worktree.deletionStartedAt !== null || worktree.deletionCompletedAt !== null) {
          throw new TRPCError({ code: 'CONFLICT', message: 'Worktree is being deleted' });
        }
        const linked = await ctx.folderDb
          .update(cli_sessions_v2)
          .set({ cloud_agent_worktree_id: worktreeId })
          .where(
            and(
              ownerScopeCondition(cli_sessions_v2, ctx.folderScope),
              eq(cli_sessions_v2.cloud_agent_session_id, input.sessionId),
              isNull(cli_sessions_v2.cloud_agent_worktree_id)
            )
          )
          .returning({ sessionId: cli_sessions_v2.session_id });
        if (linked.length === 0) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Session moved. Refresh and try again.',
          });
        }
        // A standalone root's descendants carry a null worktree id. Link them
        // in the same transaction so worktree deletion, which discovers
        // members by worktree id and refuses roots with unregistered children,
        // can tear the new workspace down.
        await ctx.folderDb
          .update(cli_sessions_v2)
          .set({ cloud_agent_worktree_id: worktreeId })
          .where(
            and(
              ownerScopeCondition(cli_sessions_v2, ctx.folderScope),
              eq(cli_sessions_v2.cloud_agent_session_scope_id, input.sessionId),
              isNull(cli_sessions_v2.cloud_agent_worktree_id)
            )
          );
      }

      await ctx.folderDb
        .update(cloud_agent_worktrees)
        .set({ folder_id: input.folderId })
        .where(
          and(
            ownerScopeCondition(cloud_agent_worktrees, ctx.folderScope),
            eq(cloud_agent_worktrees.worktree_id, worktreeId)
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
