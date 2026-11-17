import 'server-only';
import { kilocode_users, organization_memberships, organizations } from '@kilocode/db/schema';
import { isGoneOrDeletingBlockedReason } from '@kilocode/db/user-soft-delete';
import { cloudAgentWorktreeIdSchema } from '@kilocode/session-ingest-contracts';
import { TRPCError } from '@trpc/server';
import { and, eq, isNull, type AnyColumn, type SQL } from 'drizzle-orm';
import * as z from 'zod';
import { createControlTokenForRequest } from '@/lib/auth/resource-delegation';
import {
  createCloudAgentNextClient,
  rethrowCloudAgentError,
} from '@/lib/cloud-agent-next/cloud-agent-client';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { baseProcedure, type TRPCContext } from '@kilocode/web-shared/lib/trpc/init';

export const uuidSchema = z.uuid().transform(id => id.toLowerCase());

export const scopeInputSchema = z.object({ organizationId: uuidSchema.nullable() });

export const workspaceSessionIdSchema = z.templateLiteral(['workspace_', z.uuid()]);

const SCOPED_FOLDER_PROCEDURES = new Set([
  'workspaceFolders.list',
  'workspaceFolders.moveWorktree',
]);

export type SidebarScope = { userId: string; organizationId: string | null };

type OwnerScopedTable = {
  kilo_user_id: AnyColumn;
  organization_id: AnyColumn;
};

export function ownerScopeCondition(table: OwnerScopedTable, scope: SidebarScope): SQL {
  return and(
    eq(table.kilo_user_id, scope.userId),
    scope.organizationId === null
      ? isNull(table.organization_id)
      : eq(table.organization_id, scope.organizationId)
  ) as SQL;
}

/**
 * A Cloud Agent parent may only reach the sidebar surface through the shared
 * authority allowlist, which permits only the folder procedures below. Revalidate
 * the live parent on the Worker before the transaction opens, so a revoked
 * authority or a remote failure cannot write.
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

export const cloudAgentSidebarScopeProcedure = baseProcedure
  .input(scopeInputSchema)
  .use(async ({ ctx, input, path, type, getRawInput, next }) => {
    await revalidateScopedFolderAccess(ctx, path, input.organizationId, await getRawInput());
    return db.transaction(async tx => {
      const scope: SidebarScope = { userId: ctx.user.id, organizationId: input.organizationId };
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

      const result = await next({ ctx: { sidebarDb: tx, sidebarScope: scope } });
      if (!result.ok) throw result.error;
      return result;
    });
  });
