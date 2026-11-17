import { atom } from 'jotai';
import type { Atom } from 'jotai';
import type { createStore } from 'jotai';
import type { Part } from '@kilocode/app-shared/opencode';
import type { ReadonlyPart } from '../types';
import type { MessageInfo } from '../types';
import type { SessionStorage } from './types';
import {
  clearStorage,
  deleteMessageFromStorage,
  deletePartFromStorage,
  type StorageContainers,
} from './lifecycle';
import type { PartsSnapshot } from './helpers';
import {
  EMPTY_PARTS,
  appendPartTextChunks,
  clonePart,
  createReadonlyPartView,
  createSubscriberRegistry,
  insertSortedBy,
  isSupportedDeltaField,
  messageIdKey,
  publishPartsChanged,
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

  const partsSnapshot: PartsSnapshot = new Map<string, readonly ReadonlyPart[] | null>();
  // Ordering evidence of the last accepted update per part, owned next to the
  // parts it describes (see `upsertPartDroppingStaleSyntheticParts`).
  const partEvidence = new Map<string, number>();
  const subscribers = createSubscriberRegistry();

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
    partsMap.set(
      messageId,
      appendPartTextChunks(partsMap.get(messageId), messageId, partId, chunks)
    );
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
      publishPartsChanged(partsSnapshot, subscribers, messageId);
    }
  }

  function scheduleFlush(): void {
    if (flushScheduled) return;
    flushScheduled = true;
    schedule(flushPendingDeltas);
  }

  const containers: StorageContainers = {
    messages: {
      has: messageId => store.get(messagesAtom).has(messageId),
      remove: messageId => {
        const nextMessages = new Map(store.get(messagesAtom));
        nextMessages.delete(messageId);
        store.set(messagesAtom, nextMessages);
      },
      clear: () => store.set(messagesAtom, new Map()),
      ids: () => store.get(messageIdsAtom),
      setIds: ids => {
        store.set(messageIdsAtom, ids);
      },
    },
    parts: {
      get: messageId => partsMap.get(messageId),
      set: (messageId, arr) => {
        partsMap.set(messageId, arr);
      },
      has: messageId => partsMap.has(messageId),
      remove: messageId => {
        partsMap.delete(messageId);
      },
      messageIds: () => [...partsMap.keys()],
      clear: () => partsMap.clear(),
    },
    snapshot: partsSnapshot,
    evidence: partEvidence,
    subscribers,
    beforeStructuralChange: flushPendingDeltas,
    publishPartsRevision: bumpPartsRevision,
  };

  const storage: JotaiSessionStorage = {
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
        subscribers.notifyMessage(info.id);
      } else {
        store.set(messageIdsAtom, insertSortedBy(store.get(messageIdsAtom), info.id, messageIdKey));
        subscribers.notifyMessageIds();
      }
    },

    getMessageIds() {
      return [...store.get(messageIdsAtom)];
    },

    getMessageInfo(messageId) {
      return store.get(messagesAtom).get(messageId);
    },

    upsertPart(messageId, part, eventTime, authoritative) {
      flushPendingDeltas();
      const arr = partsMap.get(messageId) ?? [];
      const nextArr = upsertPartDroppingStaleSyntheticParts(
        arr,
        part,
        eventTime,
        partEvidence,
        authoritative
      );
      partsMap.set(messageId, nextArr);
      bumpPartsRevision();
      publishPartsChanged(partsSnapshot, subscribers, messageId);
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
      deletePartFromStorage(storage, containers, messageId, partId);
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

    subscribe: subscribers.subscribe,

    clear() {
      clearStorage(storage, containers);
    },

    deleteMessage(messageId) {
      deleteMessageFromStorage(storage, containers, messageId);
    },
  };
  return storage;
}

export { createJotaiStorage };
export type { JotaiSessionStorage, JotaiStore };
