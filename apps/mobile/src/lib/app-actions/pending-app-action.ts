// The single pending in-app action slot.
//
// Two writers park here: the URL rails (`action-url-handler.ts`) when an action
// URL arrives, and the dispatcher when a `StartAgent` run finishes into a
// session the app must show. One reader consumes it: the tabs layout, the one
// place that holds both the router and the live session list.
//
// Shaped like the pending deep-link slot (`deep-link-launch.ts`): one value, an
// observable store for `useSyncExternalStore`, consumed once.

import { type AppActionRequest } from './app-action-contract';

let pendingAppAction: AppActionRequest | null = null;

// The signed-in user id the CURRENT slot was parked for, or null when it was
// parked before an account was known. Bound the same way the pending deep-link
// slot binds `pendingDeepLinkUserId`: a StartAgent (or a session it parked)
// spends the account's credits, so a request parked for one account must never
// be taken after another account signs in.
let pendingAppActionUserId: string | null = null;

// The latest signed-in user id the auth context published, or null while
// signed out. The auth boundary calls `setCurrentAppActionUserId` at the same
// points it calls `setCurrentDeepLinkUserId`, so park time reads the account
// the destination belongs to.
let currentAppActionUserId: string | null = null;

// Whether the account identity is known yet. A cold launch can park an action
// from a URL before auth restores (the synchronous `redirectSystemPath` path),
// so such a request is unbound and is adopted — or dropped when the launch
// settles signed out — by the first `setCurrentAppActionUserId`.
let appActionUserSettled = false;

// Observable slot: listeners are notified whenever the pending slot changes, so
// the tabs layout reacts through `useSyncExternalStore` instead of waiting for
// an unrelated dependency change (the list settling, a token refresh).
const pendingAppActionListeners = new Set<() => void>();

function notifyPendingAppActionListeners(): void {
  for (const listener of pendingAppActionListeners) {
    listener();
  }
}

/** Drop the parked request and its binding. */
function clearPendingAppAction(): void {
  pendingAppAction = null;
  pendingAppActionUserId = null;
  notifyPendingAppActionListeners();
}

/**
 * Bind the pending slot to the signed-in account, called by the auth boundary
 * exactly where `setCurrentDeepLinkUserId` is called. A request parked for a
 * different account (or parked while signed out) is dropped instead of being
 * taken later and executed with this account's credentials and credits.
 *
 * A request parked before any account was known is adopted for the account the
 * launch settles into — or dropped when it settles signed out, because a
 * signed-out slug must not start an agent on whoever signs in next in this
 * process.
 */
export function setCurrentAppActionUserId(userId: string | null): void {
  const wasSettled = appActionUserSettled;
  currentAppActionUserId = userId;
  appActionUserSettled = true;
  if (pendingAppAction === null) {
    return;
  }
  if (!wasSettled) {
    if (userId === null) {
      clearPendingAppAction();
    } else {
      pendingAppActionUserId = userId;
    }
    return;
  }
  if (pendingAppActionUserId !== userId) {
    clearPendingAppAction();
  }
}

/**
 * Sign-out drop: clear a request parked for the account being signed out. The
 * in-memory clear is synchronous, so a request parked before the first await of
 * sign-out cannot be taken while the session is torn down. A signed-out request
 * is dropped when the next account settles (`setCurrentAppActionUserId`), since
 * only that settle knows an account is actually taking over.
 */
export function clearAccountBoundPendingAppAction(): void {
  if (pendingAppAction !== null && pendingAppActionUserId !== null) {
    clearPendingAppAction();
  }
}

/** Park a request for the tabs consumer. A newer request replaces the slot. */
export function setPendingAppAction(request: AppActionRequest): void {
  pendingAppAction = request;
  pendingAppActionUserId = currentAppActionUserId;
  notifyPendingAppActionListeners();
}

/** Current request without consuming it. Snapshot for `useSyncExternalStore`. */
export function getPendingAppAction(): AppActionRequest | null {
  return pendingAppAction;
}

/**
 * Consume-and-clear. The tabs consumer calls this before it navigates (or
 * dispatches) so a later back-gesture or an unrelated re-render cannot re-fire
 * the action.
 */
export function takePendingAppAction(): AppActionRequest | null {
  const request = pendingAppAction;
  if (request === null) {
    return null;
  }
  pendingAppAction = null;
  pendingAppActionUserId = null;
  notifyPendingAppActionListeners();
  return request;
}

/** Subscribe to pending-slot changes. Returns an unsubscribe function. */
export function subscribePendingAppAction(listener: () => void): () => void {
  pendingAppActionListeners.add(listener);
  return () => {
    pendingAppActionListeners.delete(listener);
  };
}

/** Test-only: reset the slot, its binding, and the account identity between cases. */
export function _resetPendingAppActionForTests(): void {
  pendingAppAction = null;
  pendingAppActionUserId = null;
  currentAppActionUserId = null;
  appActionUserSettled = false;
  pendingAppActionListeners.clear();
}
