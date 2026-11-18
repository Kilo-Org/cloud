import { useCallback, useSyncExternalStore } from 'react';

/**
 * Session-scoped auto-approve.
 *
 * Availability, state resolution, and the auto-reply plan are pure functions so
 * the repo's `node` vitest env can cover them without rendering React Native.
 * The per-session store is in-memory and keyed by session id: enabling the
 * toggle for one session never affects another, and it never writes the global
 * auto-approve config.
 */

/** Toggle state surfaced to the row: on, off, or unavailable for this session. */
export type SessionAutoApproveState = 'on' | 'off' | 'unavailable';

/**
 * Subset of the session manager's `activeSessionType` that can receive
 * permission asks. `null` means the transport is unresolved.
 */
export type SessionAutoApproveSessionType = 'remote' | 'cloud-agent' | 'read-only' | null;

/**
 * Whether the session's permission settings may be used.
 *
 * The auto-approve toggle is a client-side, per-session preference, so it must
 * be usable while the session is still opening: the transport resolves only
 * after the session metadata and transcript, and a session whose transcript is
 * still loading (or failed to load) still owns its settings. Treating the
 * unresolved transport (`null`) as unavailable hid the only way into the
 * context sheet for exactly that phase. A session known to be read-only can
 * never receive a permission ask, so it stays unavailable.
 */
export function canAutoApprovePermissions(input: {
  activeSessionType: SessionAutoApproveSessionType;
  isReadOnly: boolean;
}): boolean {
  if (input.isReadOnly) {
    return false;
  }
  return input.activeSessionType !== 'read-only';
}

/**
 * Whether the session can actually answer a permission ask, which is what
 * makes an auto-reply eligible.
 *
 * Distinct from {@link canAutoApprovePermissions}: the settings row must stay
 * reachable while the transport is unresolved, but an unresolved transport
 * cannot deliver an ask, so it must never make an auto-reply eligible.
 */
export function canAutoApproveReply(input: {
  activeSessionType: SessionAutoApproveSessionType;
  isReadOnly: boolean;
}): boolean {
  return input.activeSessionType !== null && canAutoApprovePermissions(input);
}

/** Resolve the row state: unavailable wins over the stored enabled flag. */
export function resolveSessionAutoApproveState(input: {
  enabled: boolean;
  available: boolean;
}): SessionAutoApproveState {
  if (!input.available) {
    return 'unavailable';
  }
  return input.enabled ? 'on' : 'off';
}

/** The reply/suppression decision for one pending permission ask. */
export type SessionAutoApproveReplyPlan = {
  /** Request id to answer with "once", or null when no reply is due. */
  replyRequestId: string | null;
  /** Request id whose permission card must not render, or null. */
  suppressedRequestId: string | null;
};

/**
 * Plan the auto-reply for a pending permission ask.
 *
 * Callers pass permission request ids only, so a clarification question is
 * never auto-answered. Suppression and reply both require the toggle to be on,
 * the session to be answerable, a request id, and a request that has not
 * already failed. A request already handled is suppressed (its card must not
 * reappear) but not replied to again. A failed request produces no plan, so its
 * card stays visible for the user.
 */
export function planAutoApproveReply(input: {
  enabled: boolean;
  available: boolean;
  requestId: string | null;
  handledRequestIds: ReadonlySet<string>;
  failedRequestIds: ReadonlySet<string>;
}): SessionAutoApproveReplyPlan {
  const { enabled, available, requestId, handledRequestIds, failedRequestIds } = input;
  if (!enabled || !available || requestId === null || failedRequestIds.has(requestId)) {
    return { replyRequestId: null, suppressedRequestId: null };
  }
  return {
    replyRequestId: handledRequestIds.has(requestId) ? null : requestId,
    suppressedRequestId: requestId,
  };
}

/**
 * Most request ids the reply hook remembers per set. A handled id must outlive
 * its ask so a queue that advances and returns does not answer it twice, and a
 * failed id must outlive its ask so a failed reply keeps its card. Only the
 * asks near the head of the queue can be re-shown, so a small window bounds the
 * memory without changing behavior for any realistic queue depth.
 */
export const MAX_REMEMBERED_REQUEST_IDS = 64;

/** Remember one request id, evicting the oldest once the window is full. */
export function rememberRequestId(remembered: Set<string>, requestId: string): void {
  remembered.add(requestId);
  if (remembered.size <= MAX_REMEMBERED_REQUEST_IDS) {
    return;
  }
  const oldest = remembered.values().next().value;
  if (oldest !== undefined) {
    remembered.delete(oldest);
  }
}

/** Session ids with auto-approve on. Absence means off. */
const enabledBySession = new Map<string, true>();

/** Per-session listener sets. A session gets an entry only while subscribed. */
const listenersBySession = new Map<string, Set<() => void>>();

/** True when auto-approve is on for this session. Unknown sessions are off. */
export function getSessionAutoApproveEnabled(sessionId: string): boolean {
  return enabledBySession.has(sessionId);
}

/**
 * Turn auto-approve on or off for one session. A no-op change does not notify
 * subscribers, so a re-set of the current value does not re-render.
 */
export function setSessionAutoApproveEnabled(sessionId: string, enabled: boolean): void {
  if (enabledBySession.has(sessionId) === enabled) {
    return;
  }
  if (enabled) {
    enabledBySession.set(sessionId, true);
  } else {
    enabledBySession.delete(sessionId);
  }
  notifySession(sessionId);
}

/**
 * Drop every session's toggle on sign-out or account switch, so a later sign-in
 * on the same process never inherits the prior account's auto-approve state.
 * Notifies the subscribers still mounted (a re-render later in the same frame is
 * how off appears) and does not touch the global auto-approve config.
 */
export function clearSessionAutoApprove(): void {
  if (enabledBySession.size === 0) {
    return;
  }
  const sessionIds = [...enabledBySession.keys()];
  enabledBySession.clear();
  for (const sessionId of sessionIds) {
    notifySession(sessionId);
  }
}

/** React binding for the row: subscribes to one session's toggle value. */
export function useSessionAutoApproveEnabled(sessionId: string): boolean {
  const subscribe = useCallback(
    (listener: () => void) => subscribeSession(sessionId, listener),
    [sessionId]
  );
  const getSnapshot = useCallback(() => getSessionAutoApproveEnabled(sessionId), [sessionId]);
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
