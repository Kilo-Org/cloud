import { sortActiveSessionsByCreatedAt } from '@/lib/active-session-order';
import { type ActiveSession } from '@/lib/hooks/use-agent-sessions';
import { isAttentionAcked, shouldShowNeedsInput } from '@/lib/session-attention';

/**
 * The agent the one-tap "open the agent that is waiting" control opens.
 *
 * The predicate is exactly the one the Agents tab badge counts
 * (`shouldShowNeedsInput` over `isAttentionAcked`), so "the agent that is
 * waiting" is the agent the badge is counting and an already-acked raise is
 * never reopened. The rows are ordered with the app's canonical session order
 * (`sortActiveSessionsByCreatedAt`), and the first waiting row wins.
 *
 * Ordering note: the canonical comparator puts unenriched rows first (by id
 * ascending) and enriched rows newest-first, so the newest waiting agent is
 * the one opened.
 *
 * Pure: no React, tRPC, or network imports, so this stays in the pure suite.
 * No waiting row (empty list, every raise acked, or only busy/idle/retry
 * statuses) returns `null` — the caller's empty-state condition.
 */
export function pickWaitingAgent(sessions: readonly ActiveSession[]): ActiveSession | null {
  // `sortActiveSessionsByCreatedAt` takes a mutable array and copies before
  // sorting, so spreading keeps the readonly input contract intact.
  const ordered = sortActiveSessionsByCreatedAt([...sessions]);
  for (const session of ordered) {
    if (
      shouldShowNeedsInput({
        status: session.status,
        raiseId: session.status,
        isAcked: isAttentionAcked(session.id, session.status),
      })
    ) {
      return session;
    }
  }
  return null;
}
