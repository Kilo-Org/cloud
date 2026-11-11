import {
  cloudAgentWorktreeIdSchema,
  type CloudAgentWorkspaceSummary,
} from '@kilocode/session-ingest-contracts';
import { TRPCError } from '@trpc/server';
import type {
  PreviewTargetResult,
  ResolvedPreviewTarget,
} from '../control-plane/sandbox/preview-target.js';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import { isTerminalSessionEligible } from '../terminal/access.js';
import { getSandboxControlStub } from '../sandbox-control/stub.js';
import { getSandboxSessionStub, type SessionStub } from '../sandbox-session/session-stub.js';
import type { Env } from '../types.js';
import { withDORetry } from '../utils/do-retry.js';

type WorkspacePreviewRequest = {
  env: Env;
  kiloUserId: string;
  worktreeId: string;
  expectedOrganizationId: string | null;
};

export async function requireCurrentWorkspaceAccess(
  request: WorkspacePreviewRequest
): Promise<CloudAgentWorkspaceSummary> {
  const worktreeId = cloudAgentWorktreeIdSchema.parse(request.worktreeId);
  let workspace: CloudAgentWorkspaceSummary | null;
  try {
    workspace = await request.env.SESSION_INGEST.getCloudAgentWorkspace({
      kiloUserId: request.kiloUserId,
      workspaceId: worktreeId,
      sessionLimit: 1,
    });
  } catch {
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Workspace access is temporarily unavailable',
    });
  }
  if (
    workspace === null ||
    workspace.workspaceId !== worktreeId ||
    workspace.userId !== request.kiloUserId ||
    workspace.organizationId !== request.expectedOrganizationId ||
    workspace.deletionState !== 'active'
  ) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Workspace access denied' });
  }
  return workspace;
}

export async function resolveWorkspacePreviewTarget(
  request: WorkspacePreviewRequest
): Promise<ResolvedPreviewTarget> {
  const workspace = await requireCurrentWorkspaceAccess(request);
  const root = workspace.sessions[0];
  if (root === undefined) return { status: 'not_running' };
  const metadata = await withDORetry<SessionStub, SessionMetadata | null>(
    () => getSandboxSessionStub(request.env, request.kiloUserId, root.cloudAgentSessionId),
    stub => stub.getMetadata(),
    'getMetadata'
  );
  if (metadata === null) return { status: 'not_ready' };
  if (
    root.workspaceId !== workspace.workspaceId ||
    root.userId !== request.kiloUserId ||
    root.organizationId !== request.expectedOrganizationId ||
    metadata.identity.sessionId !== root.cloudAgentSessionId ||
    metadata.auth.kiloSessionId !== root.kiloSessionId ||
    metadata.identity.userId !== request.kiloUserId ||
    (metadata.identity.orgId ?? null) !== request.expectedOrganizationId ||
    metadata.workspace?.worktreeId !== workspace.workspaceId
  ) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Workspace placement mismatch' });
  }
  if (!isTerminalSessionEligible(metadata)) return { status: 'ineligible' };
  const sandboxId = metadata.workspace.sandboxId;
  if (!sandboxId) return { status: 'not_running' };
  return withDORetry<ReturnType<typeof getSandboxControlStub>, PreviewTargetResult>(
    () => getSandboxControlStub(request.env, sandboxId),
    stub =>
      stub.previewTarget({
        ownerId: request.kiloUserId,
        organizationId: request.expectedOrganizationId,
        scopeId: workspace.workspaceId,
      }),
    'previewTarget'
  );
}
