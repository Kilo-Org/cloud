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

// Observable slot: listeners are notified whenever the pending slot changes, so
// the tabs layout reacts through `useSyncExternalStore` instead of waiting for
// an unrelated dependency change (the list settling, a token refresh).
const pendingAppActionListeners = new Set<() => void>();

function notifyPendingAppActionListeners(): void {
  for (const listener of pendingAppActionListeners) {
    listener();
  }
}

/** Park a request for the tabs consumer. A newer request replaces the slot. */
export function setPendingAppAction(request: AppActionRequest): void {
  pendingAppAction = request;
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
