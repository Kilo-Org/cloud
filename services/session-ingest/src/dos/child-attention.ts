import { isNeedsInputStatus } from './session-ingest-attention';

type ChildSession = { id: string; status: string; parentSessionId?: string };

/**
 * A subagent raise arrives on the child row, but the session list emits root
 * rows only. Map each root id to the needs-input status of one of its children.
 */
export function hoistedChildAttention(sessions: readonly ChildSession[]): Map<string, string> {
  // ponytail: one level deep; iterate to a fixed point if the CLI ever nests deeper.
  const hoisted = new Map<string, string>();
  for (const session of sessions) {
    if (session.parentSessionId && isNeedsInputStatus(session.status)) {
      hoisted.set(session.parentSessionId, session.status);
    }
  }
  return hoisted;
}

/**
 * Root ids whose hoisted status changed between two heartbeats, with the status
 * the root must now show: the child's raise, or the root's own live status once
 * every child settled or left the heartbeat.
 */
export function hoistedAttentionChanges(
  previous: readonly ChildSession[],
  current: readonly ChildSession[]
): Array<{ sessionId: string; status: string; previousStatus: string | null }> {
  const before = hoistedChildAttention(previous);
  const after = hoistedChildAttention(current);
  const changes: Array<{ sessionId: string; status: string; previousStatus: string | null }> = [];
  for (const root of current) {
    if (root.parentSessionId) {
      continue;
    }
    const was = before.get(root.id) ?? null;
    const now = after.get(root.id) ?? null;
    if (was !== now) {
      changes.push({ sessionId: root.id, status: now ?? root.status, previousStatus: was });
    }
  }
  return changes;
}
