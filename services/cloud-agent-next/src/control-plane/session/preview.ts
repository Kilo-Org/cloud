import type { SessionMetadata } from '../../persistence/session-metadata.js';
import { isControlSession } from '../../session-identity.js';
import { isTerminalSessionEligible } from '../../terminal/access.js';
import type {
  ResolvedPreviewTarget,
  PreviewSandboxScope,
  PreviewTargetResult,
} from '../sandbox/preview-target.js';

export type ControlPlanePreviewDeps = {
  getMetadata: () => SessionMetadata | null;
  resolveTarget: (sandboxId: string, scope: PreviewSandboxScope) => Promise<PreviewTargetResult>;
};

/**
 * Session-shaped preview URLs remain aliases for their stored workspace.
 */
export function createControlPlanePreview(deps: ControlPlanePreviewDeps) {
  async function resolve(): Promise<ResolvedPreviewTarget> {
    const metadata = deps.getMetadata();
    if (metadata === null) return { status: 'not_ready' };
    if (!isControlSession(metadata.identity.sessionId) || !isTerminalSessionEligible(metadata)) {
      return { status: 'ineligible' };
    }
    const sandboxId = metadata.workspace?.sandboxId;
    if (sandboxId === undefined || sandboxId.length === 0) return { status: 'not_ready' };
    return deps.resolveTarget(sandboxId, {
      ownerId: metadata.identity.userId,
      organizationId: metadata.identity.orgId ?? null,
      scopeId: metadata.workspace?.worktreeId ?? metadata.identity.sessionId,
    });
  }

  return { resolve };
}

export type ControlPlanePreview = ReturnType<typeof createControlPlanePreview>;
