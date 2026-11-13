import { useSyncExternalStore } from 'react';

/**
 * Whether each session tells the person when its command finishes while the
 * app is off screen. It lives outside React because the notification is armed
 * on the native shell, which outlives the screen that set it.
 */
const enabled = new Map<string, boolean>();
const listeners = new Set<() => void>();
let snapshot: ReadonlyMap<string, boolean> = new Map();

export function subscribeIdleNotify(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function idleNotifySnapshot(): ReadonlyMap<string, boolean> {
  return snapshot;
}

export function setIdleNotify(sessionId: string, next: boolean): void {
  if ((enabled.get(sessionId) ?? false) === next) {
    return;
  }
  if (next) {
    enabled.set(sessionId, true);
  } else {
    enabled.delete(sessionId);
  }
  snapshot = new Map(enabled);
  for (const listener of listeners) {
    listener();
  }
}

export function forgetIdleNotify(sessionId: string): void {
  setIdleNotify(sessionId, false);
}

export function useIdleNotify(sessionId: string): boolean {
  const all = useSyncExternalStore(subscribeIdleNotify, idleNotifySnapshot, idleNotifySnapshot);
  return all.get(sessionId) ?? false;
}
