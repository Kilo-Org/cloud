import type { SessionMetadata } from '../../persistence/session-metadata.js';

/**
 * The server-owned session id an interactive chat needs to route a child
 * callback back to itself. Only subagent-enabled sessions in a workspace
 * receive it.
 */
export function sessionCallbackContext(metadata: SessionMetadata | null): string | undefined {
  if (metadata?.allowSubagentSessions !== true || metadata.workspace?.worktreeId === undefined) {
    return undefined;
  }
  const sessionId = metadata.identity.sessionId;
  return [
    'Cloud Agent session context. Use this session id only for callback routing in this chat.',
    `<cloud-agent-context session-id="${sessionId}" />`,
    `To deliver a child Cloud Agent completion into this chat, pass callbackTarget {"url":"workspace:${sessionId}"} to spawn_session.`,
  ].join('\n');
}
