import type { SessionMetadata } from '../../persistence/session-metadata.js';
import { isControlSession } from '../../session-plane.js';
import { isTerminalSessionPlatform } from '../../terminal/access.js';
import type { ResolvedPreviewTarget, PreviewTargetResult } from '../sandbox/preview-target.js';

export type ControlPlanePreviewDeps = {
  getMetadata: () => SessionMetadata | null;
  resolveTarget: (sandboxId: string) => Promise<PreviewTargetResult>;
};

/**
 * Owns preview eligibility and which sandbox serves the session. Route and
 * allocation state belong to the Sandbox DO's `previewTarget` read.
 */
export function createControlPlanePreview(deps: ControlPlanePreviewDeps) {
  async function resolve(): Promise<ResolvedPreviewTarget> {
    const metadata = deps.getMetadata();
    if (metadata === null) return { status: 'not_ready' };
    if (
      !isControlSession(metadata.identity.sessionId) ||
      !isTerminalSessionPlatform(metadata.identity.createdOnPlatform)
    ) {
      return { status: 'ineligible' };
    }
    const sandboxId = metadata.workspace?.sandboxId;
    if (sandboxId === undefined || sandboxId.length === 0) return { status: 'not_ready' };
    return deps.resolveTarget(sandboxId);
  }

  return { resolve };
}

export type ControlPlanePreview = ReturnType<typeof createControlPlanePreview>;
