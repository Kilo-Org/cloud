import type {
  CloudAgentWorkspaceSummary,
  CloudAgentWorktreeId,
} from '@kilocode/session-ingest-contracts';
import { hasOrganizationAccess } from '@kilocode/worker-utils';
import { TRPCError } from '@trpc/server';
import { getPgDb } from '../../db/pg.js';
import type { TRPCContext } from '../../types.js';

type WorkspaceAccessContext = Pick<TRPCContext, 'env' | 'userId'>;

/**
 * Resolves one hosted workspace for the authenticated caller.
 *
 * The catalog read is owner-scoped, so a guessed or another owner's
 * `workspaceId` is indistinguishable from a missing one and never reveals the
 * workspace. An explicit organization scope must be one the caller can access
 * and must match the workspace's own tenant, and a workspace whose
 * organization the caller has left stays unreachable.
 */
export async function getAuthorizedHostedWorkspace(
  ctx: WorkspaceAccessContext,
  input: { workspaceId: CloudAgentWorktreeId; kilocodeOrganizationId?: string },
  options: { sessionLimit?: number } = {}
): Promise<CloudAgentWorkspaceSummary> {
  const requestedOrganizationId = input.kilocodeOrganizationId ?? null;
  if (
    requestedOrganizationId !== null &&
    !(await hasOrganizationAccess(getPgDb(ctx.env), {
      kiloUserId: ctx.userId,
      organizationId: requestedOrganizationId,
    }))
  ) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Workspace access denied' });
  }
  const workspace = await ctx.env.SESSION_INGEST.getCloudAgentWorkspace({
    kiloUserId: ctx.userId,
    workspaceId: input.workspaceId,
    ...(options.sessionLimit === undefined ? {} : { sessionLimit: options.sessionLimit }),
  });
  if (!workspace) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Workspace not found' });
  }
  if (requestedOrganizationId !== null && workspace.organizationId !== requestedOrganizationId) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Workspace scope mismatch' });
  }
  if (
    workspace.organizationId !== null &&
    !(await hasOrganizationAccess(getPgDb(ctx.env), {
      kiloUserId: ctx.userId,
      organizationId: workspace.organizationId,
    }))
  ) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Workspace access denied' });
  }
  return workspace;
}
