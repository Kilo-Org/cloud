import type { SessionMetadata } from '../persistence/session-metadata.js';
import { isControlSession } from '../session-identity.js';
import { isInteractiveSessionOrigin } from '../shared/control-plane-permission.js';

const TERMINAL_SESSION_PLATFORMS = new Set(['cloud-agent', 'cloud-agent-web', 'slack']);

export function isTerminalSessionPlatform(platform: string | undefined): boolean {
  return platform !== undefined && TERMINAL_SESSION_PLATFORMS.has(platform);
}

export function isTerminalSessionEligible(metadata: SessionMetadata): boolean {
  const platform = metadata.identity.createdOnPlatform;
  return (
    isTerminalSessionPlatform(platform) ||
    (isInteractiveSessionOrigin(platform) &&
      isControlSession(metadata.identity.sessionId) &&
      metadata.workspace?.worktreeId !== undefined &&
      metadata.workspace.sandboxId !== undefined &&
      metadata.workspace.sandboxProvider !== undefined)
  );
}
