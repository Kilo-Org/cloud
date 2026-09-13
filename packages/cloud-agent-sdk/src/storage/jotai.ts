import { atom } from 'jotai';
import type { Atom } from 'jotai';
import type { createStore } from 'jotai';
import type { Part } from '@kilocode/app-shared/opencode';
import type { MessageInfo } from '../types';
import type { SessionStorage } from './types';
import {
  EMPTY_PARTS,
  applyTextDeltas,
  clonePart,
  createReadonlyPartView,
  createSeedTextPart,
  insertPartSorted,
  insertSorted,
  isSupportedDeltaField,
  notify,
  upsertPartDroppingStaleSyntheticParts,
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

  // Coalesced delta publication. `applyPartDelta` buffers the incoming chunk
  // and schedules one flush; the flush applies every buffered chunk for a part
  // with a single concatenation, then bumps `partsRevisionAtom` once and
  // notifies once per dirty id. Structural operations flush pending work first.
  const dirtyPartIds = new Set<string>();
  // Buffered stream chunks, keyed messageId -> partId -> chunks. Buffering is
  // what bounds the work per token: a `message.part.delta` costs one array push
  // here, not a re-copy of the whole accumulated text (which is O(n) per token
  // and quadratic over a long reasoning/text stream).
  const pendingTextDeltas = new Map<string, Map<string, string[]>>();
  let flushScheduled = false;

  function bumpPartsRevision(): void {
    store.set(partsRevisionAtom, r => r + 1);
  }

  /** Apply one publication's worth of buffered chunks to a single part. */
  function applyBufferedDeltaBatch(messageId: string, partId: string, chunks: string[]): void {
    const arr = partsMap.get(messageId);
    if (!arr) {
      partsMap.set(messageId, [createSeedTextPart(messageId, partId, chunks.join(''))]);
      return;
    }
    const idx = arr.findIndex(p => p.id === partId);
    const existing = idx >= 0 ? arr[idx] : undefined;
    if (!existing) {
      partsMap.set(
        messageId,
        insertPartSorted(arr, createSeedTextPart(messageId, partId, chunks.join('')))
      );
      return;
    }
    const updatedPart = applyTextDeltas(existing, chunks);
    if (updatedPart === existing) {
      return;
    }
    const nextArr = [...arr];
    nextArr[idx] = updatedPart;
    partsMap.set(messageId, nextArr);
  }

  /**
   * Apply and consume the buffered chunks for one message without publishing.
   * Used by `getParts` so a direct reader sees the deltas already received
   * (the chat processor's empty-text guard) even though the publication — and
   * its revision bump / subscriber notify — is still coalesced to the frame.
   */
  function applyPendingTextDeltas(messageId: string): boolean {
    const byPart = pendingTextDeltas.get(messageId);
    if (!byPart) return false;
    pendingTextDeltas.delete(messageId);
    for (const [partId, chunks] of byPart) {
      applyBufferedDeltaBatch(messageId, partId, chunks);
    }
    // The buffered chunks just became part of the parts map, so any cached
    // snapshot for this message is stale.
    partsSnapshot.set(messageId, null);
    return true;
  }

  function flushPendingDeltas(): void {
    // Clear the scheduled flag unconditionally: a structural operation may
    // force this flush while a frame is still queued, and the queued frame
    // must be a harmless no-op rather than a second application of the same
    // buffered chunks.
    flushScheduled = false;
    const dirty = [...dirtyPartIds];
    dirtyPartIds.clear();
    if (dirty.length === 0 && pendingTextDeltas.size === 0) return;
    const touched = new Set(dirty);
    for (const messageId of [...pendingTextDeltas.keys()]) {
      applyPendingTextDeltas(messageId);
      touched.add(messageId);
    }
    bumpPartsRevision();
    for (const messageId of touched) {
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
      const nextArr = upsertPartDroppingStaleSyntheticParts(arr, part);
      partsMap.set(messageId, nextArr);
      bumpPartsRevision();
      partsSnapshot.set(messageId, null);
      notify(subscribers, `parts:${messageId}`);
    },

    applyPartDelta(messageId, partId, field, delta) {
      if (!isSupportedDeltaField(field)) {
        return;
      }

      let byPart = pendingTextDeltas.get(messageId);
      if (!byPart) {
        byPart = new Map();
        pendingTextDeltas.set(messageId, byPart);
      }
      const chunks = byPart.get(partId);
      if (chunks) {
        chunks.push(delta);
      } else {
        byPart.set(partId, [delta]);
      }

      // Invalidate the cached snapshot so a `getParts` before the flush
      // rebuilds from the freshly applied parts instead of the stale cache.
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
      // Buffered stream chunks are not published until the frame flush, but a
      // direct reader (the chat processor's empty-text guard) must still see
      // the deltas that already arrived. Consume them into the parts map
      // without bumping the revision or notifying subscribers.
      applyPendingTextDeltas(messageId);
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
