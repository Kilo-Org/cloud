/**
 * Which session owns a terminal is a worktree-scoped decision: sibling chats
 * share one sandbox and checkout, so any session with a ready route can own it.
 * A terminal requires the target session's route to be ready, and a stopped
 * session keeps its `preparedAt`/`initiatedAt` while losing its route, so
 * readiness must come from the route state and never from those timestamps.
 */
export type TerminalOwnerCandidate = {
  kiloSessionId: string;
  cloudAgentSessionId: string;
  /**
   * `true` when the candidate's route is ready, `false` when it is known not
   * ready, `undefined` when readiness could not be resolved.
   */
  routeReady: boolean | undefined;
};

/**
 * Pick the session a new terminal must target.
 *
 * Order: the session the user is viewing when its route is not known to be
 * unready, then any sibling whose route is ready, then the viewed session, then
 * the first known session. The viewed session is preferred so a stopped
 * sibling is never selected ahead of a usable current route, and falling back
 * to it names the right session in the server's "workspace not prepared" error.
 */
export function selectTerminalOwner({
  loadedKiloSessionId,
  candidates,
}: {
  loadedKiloSessionId: string | null;
  candidates: readonly TerminalOwnerCandidate[];
}): string | null {
  const loaded = loadedKiloSessionId
    ? (candidates.find(candidate => candidate.kiloSessionId === loadedKiloSessionId) ?? null)
    : null;

  if (loaded && loaded.routeReady !== false) {
    return loaded.cloudAgentSessionId;
  }

  const readySibling = candidates.find(candidate => candidate.routeReady === true);
  if (readySibling) {
    return readySibling.cloudAgentSessionId;
  }

  return loaded?.cloudAgentSessionId ?? candidates[0]?.cloudAgentSessionId ?? null;
}
