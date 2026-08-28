// Root-row selection for the live active-sessions cache. A subagent raise
// arrives on the child row, so the hoist happens here before children drop.

/** Incoming WS row; carries `parentSessionId` for the root filter. */
export type IncomingWsSession = {
  id: string;
  status: string;
  title: string;
  gitUrl?: string;
  gitBranch?: string;
  parentSessionId?: string;
  connectionId?: string;
  capabilities?: { attachments?: boolean };
  /** Set by `selectRootWsSessions`, never on the wire: children listed, none waits for input. */
  childrenSettled?: boolean;
};

/** Structured question/permission — the Active Now "NEEDS INPUT" badge. */
export function isAttentionStatus(status: string | null | undefined): boolean {
  return status === 'question' || status === 'permission';
}

/**
 * Prefer stored attention over live idle/busy so released-CLI heartbeats
 * do not clear NEEDS INPUT. Non-attention stored values yield to live.
 */
export function effectiveStatus(
  live: string | null | undefined,
  stored: string | null | undefined
): string {
  if (isAttentionStatus(stored) && stored != null) {
    return stored;
  }
  return live ?? '';
}

function isRootWsSession(session: IncomingWsSession): boolean {
  return !session.parentSessionId;
}

/** Keep root rows only; hoist a child's attention status onto its root first. */
export function selectRootWsSessions<T extends IncomingWsSession>(sessions: readonly T[]): T[] {
  const hoisted = new Map<string, string>();
  const parentsWithChildren = new Set<string>();
  for (const session of sessions) {
    if (session.parentSessionId) {
      parentsWithChildren.add(session.parentSessionId);
      if (isAttentionStatus(session.status)) {
        hoisted.set(session.parentSessionId, session.status);
      }
    }
  }
  const roots: T[] = [];
  for (const session of sessions) {
    if (isRootWsSession(session)) {
      const status = hoisted.get(session.id);
      if (status !== undefined) {
        roots.push({ ...session, status });
      } else if (parentsWithChildren.has(session.id)) {
        roots.push({ ...session, childrenSettled: true });
      } else {
        roots.push(session);
      }
    }
  }
  return roots;
}
