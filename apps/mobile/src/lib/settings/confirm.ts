import { Effect } from 'effect';
import { useSyncExternalStore } from 'react';

/** One confirmation the mounted host has still to show. */
export type SettingsConfirmRequest = {
  id: number;
  /** The change the person is asked to allow, already localized by the tool. */
  summary: string;
};

// The module-level store. A request is removed only when it settles or is
// withdrawn, so the head keeps its identity while nothing changes — the
// `useSyncExternalStore` identity contract.
let requests: readonly SettingsConfirmRequest[] = [];
let nextRequestId = 1;
// Whether a host is mounted to draw the requests. Without one a destructive
// change is refused instead of waiting forever.
let hostMounted = false;
const listeners = new Set<() => void>();
// The one resolve each pending request is waiting on, keyed by its id.
const settleCallbacks = new Map<number, (confirmed: boolean) => void>();

/** `useSyncExternalStore` getSnapshot. Stable while the head is unchanged. */
export function getSettingsConfirmRequest(): SettingsConfirmRequest | undefined {
  return requests[0];
}

/** `useSyncExternalStore` subscribe. */
function subscribeSettingsConfirm(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The oldest request still waiting for an answer, or none. */
export function useSettingsConfirmRequest(): SettingsConfirmRequest | undefined {
  return useSyncExternalStore(subscribeSettingsConfirm, getSettingsConfirmRequest);
}

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** Records whether a host is mounted; the host owns the flag from its effect. */
export function setSettingsConfirmHostMounted(mounted: boolean): void {
  hostMounted = mounted;
}

/**
 * Enqueues a request and returns its id. The host draws requests one at a
 * time, oldest first, so a second request waits behind the first.
 */
export function requestSettingsConfirmChange(summary: string): number {
  const id = nextRequestId;
  nextRequestId += 1;
  requests = [...requests, { id, summary }];
  notify();
  return id;
}

function settle(id: number, confirmed: boolean): void {
  const settleRequest = settleCallbacks.get(id);
  if (settleRequest === undefined) {
    return;
  }
  settleCallbacks.delete(id);
  settleRequest(confirmed);
}

/**
 * Answers the request with this id. A late answer for a request the caller
 * withdrew does nothing: only a request still waiting is settled.
 */
export function answerSettingsConfirm(id: number, confirmed: boolean): void {
  if (!requests.some(request => request.id === id)) {
    return;
  }
  requests = requests.filter(request => request.id !== id);
  notify();
  settle(id, confirmed);
}

/** Removes the request without answering it, for an interrupted tool call. */
function withdrawSettingsConfirm(id: number): void {
  settleCallbacks.delete(id);
  if (!requests.some(request => request.id === id)) {
    return;
  }
  requests = requests.filter(request => request.id !== id);
  notify();
}

/**
 * Settles everything still waiting. The host calls this as it tears down, so
 * a tool call never waits on a confirm that can no longer appear.
 */
export function settleAllSettingsConfirms(confirmed: boolean): void {
  const pending = [...settleCallbacks.values()];
  settleCallbacks.clear();
  requests = [];
  notify();
  for (const settleRequest of pending) {
    settleRequest(confirmed);
  }
}

/**
 * Asks the person to confirm a destructive settings change. Resolves true when
 * they choose Save and false on Cancel, on Android Back, on a backdrop tap,
 * when the host tears down, and when no host is mounted.
 *
 * An agent's tool call never reaches the store until this resolves true, so a
 * destructive setting (the trusted-host list) is never changed in silence.
 */
export function confirmSettingChange(summary: string): Effect.Effect<boolean> {
  return Effect.callback<boolean>(resume => {
    if (!hostMounted) {
      resume(Effect.succeed(false));
      return Effect.void;
    }
    const id = requestSettingsConfirmChange(summary);
    settleCallbacks.set(id, confirmed => {
      resume(Effect.succeed(confirmed));
    });
    return Effect.sync(() => {
      withdrawSettingsConfirm(id);
    });
  });
}
