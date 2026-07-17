import { useEffect, useSyncExternalStore } from 'react';

/**
 * Pure session-attention derivation + in-memory ack store for the mobile
 * Agents session list "needs input" indicator.
 *
 * The detail screen is the only ack writer. Acks are intentionally NOT
 * persisted across app restarts. Raise identity is `statusUpdatedAt ?? status`
 * (stored rows carry server `status_updated_at`; remote active-only rows
 * carry none so identity degrades to the status string).
 *
 * No backend, tRPC, or shared-package imports: this is a mobile-local
 * module so the web client can keep its own copy.
 */

const ATTENTION_STATUSES = new Set(['question', 'permission']);

export function sessionNeedsInput(status: string | null | undefined): boolean {
  return status != null && ATTENTION_STATUSES.has(status);
}

type AckEntry = { raiseId: string | null };

const listeners = new Set<() => void>();
const entries = new Map<string, AckEntry>();
let revision = 0;

function bumpRevision(): void {
  revision += 1;
  for (const listener of listeners) {
    listener();
  }
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getRevisionSnapshot(): number {
  return revision;
}

/**
 * Server snapshot for `useSyncExternalStore`. Stable across calls so the
 * hook is SSR / RN-safe; the real revision is read on the client.
 */
function getServerSnapshot(): number {
  return 0;
}

export function ackSessionAttention(sessionId: string): void {
  // Opening a session always leaves the entry pending. If it is already
  // pending, nothing changes — skip the bump so we don't fire a redundant
  // global re-render (e.g. React Strict Mode's double effect invocation).
  if (entries.get(sessionId)?.raiseId === null) {
    return;
  }
  entries.set(sessionId, { raiseId: null });
  bumpRevision();
}

/**
 * Reconcile the ack store against the latest observed status.
 *
 * `raiseId = statusUpdatedAt ?? status`.
 *
 * - non-attention status: delete the entry (if any) and notify
 * - attention + existing pending entry: resolve it to the current raise
 * - otherwise: no-op (does NOT bump the revision)
 */
export function reconcileSessionAttention(
  sessionId: string,
  status: string | null | undefined,
  statusUpdatedAt: string | null | undefined
): void {
  if (!sessionNeedsInput(status)) {
    if (entries.delete(sessionId)) {
      bumpRevision();
    }
    return;
  }

  const raiseId = statusUpdatedAt ?? status ?? null;
  if (entries.get(sessionId)?.raiseId === null) {
    entries.set(sessionId, { raiseId });
    bumpRevision();
  }
}

export function isAttentionAcked(sessionId: string, raiseId: string | null): boolean {
  const entry = entries.get(sessionId);
  if (!entry) {
    return false;
  }
  return entry.raiseId === null || entry.raiseId === raiseId;
}

export function shouldShowNeedsInput({
  status,
  raiseId: _raiseId,
  isAcked,
}: {
  status: string | null | undefined;
  raiseId: string | null;
  isAcked: boolean;
}): boolean {
  return sessionNeedsInput(status) && !isAcked;
}

/**
 * Subscribe a component to the ack store's revision counter. When the
 * revision changes, the component re-renders and re-evaluates
 * `isAttentionAcked` for its session.
 */
export function useSessionAttentionRevision(): number {
  return useSyncExternalStore(subscribe, getRevisionSnapshot, getServerSnapshot);
}

/**
 * Ack a session's attention indicator when the detail screen opens.
 * Re-runs if `sessionId` changes (e.g. switching sessions).
 */
export function useAckSessionAttentionOnOpen(sessionId: string): void {
  useEffect(() => {
    ackSessionAttention(sessionId);
  }, [sessionId]);
}

/**
 * Test-only: clear all acks and reset the revision counter so each
 * test starts from a known state. Not for production use.
 */
export function __resetSessionAttentionForTests(): void {
  entries.clear();
  revision = 0;
}

/**
 * Test-only: peek at the current entry for a session (or undefined if
 * no entry exists). Lets tests assert on the raw store shape without
 * exposing it on the production API.
 */
export function __peekSessionAttentionForTests(sessionId: string): AckEntry | undefined {
  return entries.get(sessionId);
}
