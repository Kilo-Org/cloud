import type { SessionMetadata } from '../../persistence/session-metadata.js';

/**
 * The server-owned session ID used to route child callbacks to this chat.
 */
export function sessionCallbackContext(metadata: SessionMetadata | null): string | undefined {
  if (metadata?.allowSubagentSessions !== true) {
    return undefined;
  }
  const sessionId = metadata.identity.sessionId;
  return [
    `<cloud-agent-context session-id="${sessionId}" />`,
    ...(metadata.workspace?.worktreeId === undefined
      ? []
      : [`<cloud-agent-worktree id="${metadata.workspace.worktreeId}" />`]),
  ].join('\n');
}
