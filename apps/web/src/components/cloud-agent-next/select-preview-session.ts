import type { CloudAgentWorktreeId } from '@kilocode/session-ingest-contracts';
import type { PreviewTarget } from '../../../../../services/cloud-agent-next/src/shared/preview-target';

export type PreviewSessionInput = {
  /** The grouped worktree whose sandbox the preview opens. */
  selectedWorktreeId: CloudAgentWorktreeId | null | undefined;
  /** The viewed workspace's control session, used only when no worktree is grouped. */
  sessionId: string | null | undefined;
};

/**
 * The target the preview button and chat links use. A grouped worktree wins
 * regardless of which chat is open or whether its route is ready: every chat in
 * the worktree shares one sandbox. A standalone Cloud Agent session is still
 * accepted when no worktree is selected. Terminals resolve sibling routes on
 * click instead (`selectTerminalOwner`).
 */
export function selectPreviewTarget({
  selectedWorktreeId,
  sessionId,
}: PreviewSessionInput): PreviewTarget | null {
  if (selectedWorktreeId) return { worktreeId: selectedWorktreeId };
  return canOpenWorkspacePreview(sessionId) ? { cloudAgentSessionId: sessionId } : null;
}

/**
 * A preview is served by the control plane only, so a legacy `agent_*` action
 * session (which can only 404) must not offer one. Narrows to the router's
 * `workspace_*` session id type.
 */
export function canOpenWorkspacePreview(
  sessionId: string | null | undefined
): sessionId is `workspace_${string}` {
  return sessionId?.startsWith('workspace_') === true;
}

/**
 * One capability gate for the preview button and the chat's preview links.
 */
export function gatePreviewTarget(
  target: PreviewTarget | null,
  canOpenPreview: boolean
): PreviewTarget | null {
  return canOpenPreview ? target : null;
}
