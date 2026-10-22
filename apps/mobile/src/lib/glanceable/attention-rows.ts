import { isAttentionAcked, sessionNeedsInput } from '@/lib/session-attention';

/**
 * The rows the glanceable surfaces derive their counts from, after the
 * session-attention ack store has been applied.
 *
 * The ack store is the app's record that the user answered a raise from the
 * needs-input notification (`ackSessionAttention`). The in-app Agents list
 * reads it through `shouldShowNeedsInput`, but the glanceable surfaces counted
 * the raw row status, so a raise answered from the notification kept showing as
 * "Needs input" on the launcher badge and the Active-agents notification while
 * the needs-input notification for the same session read "Request approved".
 *
 * An answered raise keeps its place in the counts — the session is still
 * connected — but resolves to `idle`: the user answered, so the app can no
 * longer claim the agent waits on them, and the shared `glanceableStatusKind`
 * reserves `running` for a working agent the status names. That is the kind the
 * surface reports once the CLI's own idle status lands, so the derived read
 * agrees with the raise's real end state instead of contradicting it.
 *
 * Only this derived read changes. The tray row's stored status is untouched,
 * and `reconcileSessionAttention` drops the ack once the server status leaves
 * attention (or the raise is replaced), so a re-raise counts again.
 *
 * Raise identity is `statusUpdatedAt ?? status` (see `session-attention`). A
 * tray row carries the server `statusUpdatedAt`, so the ack is read against
 * that identity and the row's status: an answered raise counts as idle, while a
 * re-raise under the same status counts as waiting again.
 */

/** The row fields the ack resolution reads. */
export type AttentionRow = {
  id: string;
  status: string;
  /** Server status time when the row carries one; tray rows do. */
  statusUpdatedAt?: string;
};

/** Whether this row's attention raise is one the user has already answered. */
export function isAnsweredAttentionRow(row: AttentionRow): boolean {
  if (!sessionNeedsInput(row.status)) {
    return false;
  }
  return isAttentionAcked(row.id, {
    raiseId: row.statusUpdatedAt ?? row.status,
    status: row.status,
  });
}

/** Resolve every row to the status the glanceable surfaces should count. */
export function resolveAnsweredRaises<T extends AttentionRow>(rows: readonly T[]): T[] {
  return rows.map(row => (isAnsweredAttentionRow(row) ? { ...row, status: 'idle' } : row));
}
