/**
 * Per-part change notification shared by the reactive attachment caches.
 *
 * Each cache stores one value per part id, and every mounted card or file part
 * subscribes only to its own id. A write for one attachment must not wake the
 * subscribers of every other attachment in a long transcript, so the listeners
 * are bucketed by part id instead of living in one module-wide set.
 */
export type PartSubscriptions = {
  /** Register `listener` for `partId`; the returned function unregisters it. */
  subscribe(partId: string, listener: () => void): () => void;
  /** Wake the listeners registered for one part. */
  notify(partId: string): void;
  /** Wake every listener, for a reset that drops every part. */
  notifyAll(): void;
};

export function createPartSubscriptions(): PartSubscriptions {
  const listenersByPartId = new Map<string, Set<() => void>>();

  function subscribe(partId: string, listener: () => void): () => void {
    let listeners = listenersByPartId.get(partId);
    if (!listeners) {
      listeners = new Set();
      listenersByPartId.set(partId, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = listenersByPartId.get(partId);
      if (!current) {
        return;
      }
      current.delete(listener);
      if (current.size === 0) {
        listenersByPartId.delete(partId);
      }
    };
  }

  function notify(partId: string): void {
    const listeners = listenersByPartId.get(partId);
    if (!listeners) {
      return;
    }
    for (const listener of listeners) {
      listener();
    }
  }

  function notifyAll(): void {
    for (const listeners of listenersByPartId.values()) {
      for (const listener of listeners) {
        listener();
      }
    }
  }

  return { subscribe, notify, notifyAll };
}
