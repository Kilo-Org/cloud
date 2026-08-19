import { atom } from 'jotai';
import type { Atom } from 'jotai';
import type { createStore } from 'jotai';
import type { Part } from '@kilocode/app-shared/opencode';
import type { MessageInfo } from '../types';
import type { SessionStorage } from './types';
import {
  EMPTY_PARTS,
  applyTextDelta,
  clonePart,
  createReadonlyPartView,
  createSeedTextPart,
  insertPartSorted,
  insertSorted,
  isSupportedDeltaField,
  notify,
  upsertPartDroppingStaleSyntheticTextParts,
} from './helpers';

type JotaiStore = ReturnType<typeof createStore>;

type JotaiSessionStorage = SessionStorage & {
  atoms: {
    messageIds: Atom<string[]>;
    messages: Atom<Map<string, MessageInfo>>;
    parts: Atom<Map<string, Part[]>>;
    partsRevision: Atom<number>;
  };
};

function createJotaiStorage(
  store: JotaiStore,
  options?: { schedule?: (cb: () => void) => void }
): JotaiSessionStorage {
  // Coalescing scheduler. On device this is `requestAnimationFrame`; under
  // node (every vitest/jest run) it runs the callback synchronously so landed
  // assertions stay deterministic. Never default to `queueMicrotask`.
  const schedule =
    options?.schedule ??
    (typeof requestAnimationFrame === 'function'
      ? (cb: () => void) => requestAnimationFrame(() => cb())
      : (cb: () => void) => cb());

  const messageIdsAtom = atom<string[]>([]);
  const messagesAtom = atom<Map<string, MessageInfo>>(new Map());
  // Stable parts map. The atom holds this one reference for its lifetime;
  // mutations write per-message arrays into it in place and publish via
  // `partsRevisionAtom` instead of replacing the map.
  const partsMap = new Map<string, Part[]>();
  const partsAtom = atom<Map<string, Part[]>>(partsMap);
  const partsRevisionAtom = atom(0);

  const partsSnapshot = new Map<string, Part[] | null>();
  const subscribers = new Map<string, Set<() => void>>();

  // Coalesced delta publication. `applyPartDelta` marks a message id dirty and
  // schedules one flush; the flush bumps `partsRevisionAtom` once and notifies
  // once per dirty id. Structural operations flush pending work first.
  const dirtyPartIds = new Set<string>();
  let flushScheduled = false;

  function bumpPartsRevision(): void {
    store.set(partsRevisionAtom, r => r + 1);
  }

  function flushPendingDeltas(): void {
    if (!flushScheduled) return;
    flushScheduled = false;
    const dirty = [...dirtyPartIds];
    dirtyPartIds.clear();
    if (dirty.length === 0) return;
    bumpPartsRevision();
    for (const messageId of dirty) {
      partsSnapshot.set(messageId, null);
      notify(subscribers, `parts:${messageId}`);
    }
  }

  function scheduleFlush(): void {
    if (flushScheduled) return;
    flushScheduled = true;
    schedule(flushPendingDeltas);
  }

  return {
    atoms: {
      messageIds: messageIdsAtom,
      messages: messagesAtom,
      parts: partsAtom,
      partsRevision: partsRevisionAtom,
    },

    upsertMessage(info) {
      flushPendingDeltas();
      const messages = store.get(messagesAtom);
      const existing = messages.get(info.id);
      const next = new Map(messages);
      next.set(info.id, info);
      store.set(messagesAtom, next);
      if (existing) {
        notify(subscribers, `message:${info.id}`);
      } else {
        store.set(messageIdsAtom, insertSorted(store.get(messageIdsAtom), info.id));
        notify(subscribers, 'messageIds');
      }
    },

    getMessageIds() {
      return [...store.get(messageIdsAtom)];
    },

    getMessageInfo(messageId) {
      return store.get(messagesAtom).get(messageId);
    },

    upsertPart(messageId, part) {
      flushPendingDeltas();
      const arr = partsMap.get(messageId) ?? [];
      const nextArr = upsertPartDroppingStaleSyntheticTextParts(arr, part);
      partsMap.set(messageId, nextArr);
      bumpPartsRevision();
      partsSnapshot.set(messageId, null);
      notify(subscribers, `parts:${messageId}`);
    },

    applyPartDelta(messageId, partId, field, delta) {
      if (!isSupportedDeltaField(field)) {
        return;
      }

      const arr = partsMap.get(messageId);

      if (!arr) {
        partsMap.set(messageId, [createSeedTextPart(messageId, partId, delta)]);
      } else {
        const idx = arr.findIndex(p => p.id === partId);
        const existing = idx >= 0 ? arr[idx] : undefined;
        if (!existing) {
          partsMap.set(
            messageId,
            insertPartSorted(arr, createSeedTextPart(messageId, partId, delta))
          );
        } else {
          const updatedPart = applyTextDelta(existing, delta);
          if (updatedPart === existing) {
            return;
          }
          const nextArr = [...arr];
          nextArr[idx] = updatedPart;
          partsMap.set(messageId, nextArr);
        }
      }
      // State write is immediate; publication is coalesced to one flush.
      // Invalidate the cached snapshot so a `getParts` before the flush
      // rebuilds from the freshly written parts instead of the stale cache.
      partsSnapshot.set(messageId, null);
      dirtyPartIds.add(messageId);
      scheduleFlush();
    },

    deletePart(messageId, partId) {
      flushPendingDeltas();
      const arr = partsMap.get(messageId);
      if (!arr) return;
      const filtered = arr.filter(p => p.id !== partId);
      partsMap.set(messageId, filtered);
      bumpPartsRevision();
      partsSnapshot.set(messageId, null);
      notify(subscribers, `parts:${messageId}`);
    },

    getParts(messageId) {
      const cached = partsSnapshot.get(messageId);
      if (cached) return cached;

      const arr = partsMap.get(messageId);
      if (!arr || arr.length === 0) return EMPTY_PARTS;

      const snapshot = arr.map(part => createReadonlyPartView(clonePart(part)));
      partsSnapshot.set(messageId, snapshot);
      return snapshot;
    },

    subscribe(key, callback) {
      let set = subscribers.get(key);
      if (!set) {
        set = new Set();
        subscribers.set(key, set);
      }
      set.add(callback);
      return () => {
        set.delete(callback);
        if (set.size === 0) subscribers.delete(key);
      };
    },

    clear() {
      flushPendingDeltas();
      const existingMessageIds = store.get(messageIdsAtom);
      const existingPartMessageIds = [...partsMap.keys()];

      store.set(messagesAtom, new Map());
      store.set(messageIdsAtom, []);
      partsMap.clear();
      bumpPartsRevision();
      partsSnapshot.clear();

      for (const messageId of existingMessageIds) {
        notify(subscribers, `message:${messageId}`);
      }
      for (const messageId of existingPartMessageIds) {
        notify(subscribers, `parts:${messageId}`);
      }
      notify(subscribers, 'messageIds');
    },

    deleteMessage(messageId) {
      flushPendingDeltas();
      const messages = store.get(messagesAtom);
      if (!messages.has(messageId)) return;

      const nextMessages = new Map(messages);
      nextMessages.delete(messageId);
      store.set(messagesAtom, nextMessages);

      const messageIds = store.get(messageIdsAtom);
      const nextMessageIds = messageIds.filter(id => id !== messageId);
      store.set(messageIdsAtom, nextMessageIds);

      if (partsMap.has(messageId)) {
        partsMap.delete(messageId);
        bumpPartsRevision();
        partsSnapshot.delete(messageId);
        notify(subscribers, `parts:${messageId}`);
      }

      notify(subscribers, `message:${messageId}`);
      notify(subscribers, 'messageIds');
    },
  };
}

export { createJotaiStorage };
export type { JotaiSessionStorage, JotaiStore };
