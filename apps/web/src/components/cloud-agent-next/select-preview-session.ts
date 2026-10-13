import type { StoredSession } from './types';

type PreviewSessionInput = {
  selectedWorktreeId: string | null | undefined;
  /** The viewed session's route readiness; `undefined` when it is not known. */
  routeReady: boolean | undefined;
  sessionIdFromParams: string | null | undefined;
  sessionId: string | null | undefined;
  worktreeChats: readonly StoredSession[];
};

/**
 * The session the preview button and chat links target. It must be known
 * before a click, so it reads only the viewed session's known route state:
 * siblings share the worktree sandbox, so a sibling stands in when the viewed
 * route is known not ready. Terminals resolve sibling routes on click instead
 * (`selectTerminalOwner`).
 */
export function selectPreviewSessionId({
  selectedWorktreeId,
  routeReady,
  sessionIdFromParams,
  sessionId,
  worktreeChats,
}: PreviewSessionInput): string | null {
  const siblingSessionId =
    selectedWorktreeId && routeReady === false
      ? worktreeChats.find(
          chat => chat.sessionId !== sessionIdFromParams && chat.cloudAgentSessionId
        )?.cloudAgentSessionId
      : null;

  if (sessionIdFromParams) {
    return siblingSessionId ?? sessionId ?? null;
  }

  return worktreeChats.find(chat => chat.cloudAgentSessionId)?.cloudAgentSessionId ?? null;
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
