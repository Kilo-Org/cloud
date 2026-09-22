import { useCallback, useSyncExternalStore } from 'react';

/**
 * Session-scoped goal disclosure state.
 *
 * The goal row's collapsed/expanded flag is a client-side, per-session
 * preference, so it must not depend on a request: the store is in-memory and
 * keyed by session id, and it lives at module scope so leaving the session and
 * reopening it keeps the state. Absence means expanded, so the first paint is
 * unchanged and only sessions the user collapsed hold an entry.
 */

/** Session ids whose goal row is collapsed. Absence means expanded. */
const collapsedBySession = new Map<string, true>();

/** Per-session listener sets. A session gets an entry only while subscribed. */
const listenersBySession = new Map<string, Set<() => void>>();

/** True when this session's goal row is collapsed. Unknown sessions are expanded. */
export function isSessionGoalCollapsed(sessionId: string): boolean {
  return collapsedBySession.has(sessionId);
}

/**
 * Collapse or expand one session's goal row. A no-op change does not notify
 * subscribers, so a re-set of the current value does not re-render.
 */
export function setSessionGoalCollapsed(sessionId: string, collapsed: boolean): void {
  if (collapsedBySession.has(sessionId) === collapsed) {
    return;
  }
  if (collapsed) {
    collapsedBySession.set(sessionId, true);
  } else {
    collapsedBySession.delete(sessionId);
  }
  notifySession(sessionId);
}

/** Flip one session's goal row between collapsed and expanded. */
export function toggleSessionGoalCollapsed(sessionId: string): void {
  setSessionGoalCollapsed(sessionId, !isSessionGoalCollapsed(sessionId));
}

/**
 * Drop every session's disclosure value on sign-out or account switch, so the
 * next signed-in account starts expanded and the module-scope map cannot carry
 * a prior account's session ids forward. It notifies the sessions still mounted
 * (their row re-renders expanded) and is synchronous, like the other
 * session-scoped clears in `@/lib/auth/session-scoped-state`.
 */
export function clearSessionGoalCollapseState(): void {
  if (collapsedBySession.size === 0) {
    return;
  }
  const sessionIds = [...collapsedBySession.keys()];
  collapsedBySession.clear();
  for (const sessionId of sessionIds) {
    notifySession(sessionId);
  }
}

/** React binding for the goal row: subscribes to one session's disclosure value. */
export function useSessionGoalCollapsed(sessionId: string): boolean {
  const subscribe = useCallback(
    (listener: () => void) => subscribeSession(sessionId, listener),
    [sessionId]
  );
  const getSnapshot = useCallback(() => isSessionGoalCollapsed(sessionId), [sessionId]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

function notifySession(sessionId: string): void {
  const listeners = listenersBySession.get(sessionId);
  if (listeners === undefined) {
    return;
  }
  for (const listener of listeners) {
    listener();
  }
}

function subscribeSession(sessionId: string, listener: () => void): () => void {
  let listeners = listenersBySession.get(sessionId);
  if (listeners === undefined) {
    listeners = new Set();
    listenersBySession.set(sessionId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      listenersBySession.delete(sessionId);
    }
  };
}
