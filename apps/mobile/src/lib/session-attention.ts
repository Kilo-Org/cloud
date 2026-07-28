import { useSyncExternalStore } from 'react';

/**
 * Pure session-attention derivation + in-memory ack store for the mobile
 * Agents session list "needs input" indicator.
 *
 * Acks are written only when the user successfully answers, skips, or
 * responds to a permission — never on merely opening the detail screen.
 * Acks are intentionally NOT persisted across app restarts. Raise identity
 * is `statusUpdatedAt ?? status` (stored rows carry server
 * `status_updated_at`; remote active-only rows carry none so identity
 * degrades to the status string).
 *
 * No backend, tRPC, or shared-package imports: this is a mobile-local
 * module so the web client can keep its own copy.
 */

const ATTENTION_STATUSES = new Set(['question', 'permission']);

export function sessionNeedsInput(status: string | null | undefined): boolean {
  return status != null && ATTENTION_STATUSES.has(status);
}

type AckEntry = { raiseId: string | null };

type AttentionStore = {
  listeners: Set<() => void>;
  entries: Map<string, AckEntry>;
  revision: number;
};

const STORE_KEY = '__kiloSessionAttentionStore__';
const globalScope = globalThis as typeof globalThis & { [STORE_KEY]?: AttentionStore };
const store: AttentionStore = (globalScope[STORE_KEY] ??= {
  listeners: new Set<() => void>(),
  entries: new Map<string, AckEntry>(),
  revision: 0,
});

function bumpRevision(): void {
  store.revision += 1;
  // Isolate subscribers: one throwing listener must not prevent the rest from
  // being notified of the revision change.
  for (const listener of store.listeners) {
    try {
      listener();
    } catch {
      // A subscriber's own error must not break store notification.
    }
  }
}

export function subscribe(listener: () => void): () => void {
  store.listeners.add(listener);
  return () => {
    store.listeners.delete(listener);
  };
}

export function getRevisionSnapshot(): number {
  return store.revision;
}

/**
 * Server snapshot for `useSyncExternalStore`. Stable across calls so the
 * hook is SSR / RN-safe; the real revision is read on the client.
 */
function getServerSnapshot(): number {
  return 0;
}

/**
 * Hide the needs-input badge immediately after a successful answer / skip /
 * permission response, before the server status round-trip lands.
 * `reconcileSessionAttention` clears the entry once status leaves attention.
 *
 * If the entry is already pending, nothing changes — skip the bump so we
 * don't fire a redundant global re-render.
 */
export function ackSessionAttention(sessionId: string): void {
  if (store.entries.get(sessionId)?.raiseId === null) {
    return;
  }
  store.entries.set(sessionId, { raiseId: null });
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
    if (store.entries.delete(sessionId)) {
      bumpRevision();
    }
    return;
  }

  const raiseId = statusUpdatedAt ?? status ?? null;
  if (store.entries.get(sessionId)?.raiseId === null) {
    store.entries.set(sessionId, { raiseId });
    bumpRevision();
  }
}

export function isAttentionAcked(sessionId: string, raiseId: string | null): boolean {
  const entry = store.entries.get(sessionId);
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
 * Test-only: clear all acks and reset the revision counter so each
 * test starts from a known state. Not for production use.
 */
export function __resetSessionAttentionForTests(): void {
  store.entries.clear();
  store.revision = 0;
}

/**
 * Test-only: peek at the current entry for a session (or undefined if
 * no entry exists). Lets tests assert on the raw store shape without
 * exposing it on the production API.
 */
export function __peekSessionAttentionForTests(sessionId: string): AckEntry | undefined {
  return store.entries.get(sessionId);
}
