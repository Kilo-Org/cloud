import { atom } from 'jotai';
import type { Atom } from 'jotai';
import type { createStore } from 'jotai';
import type { Part, TextPart } from '@/types/opencode.gen';
import type { MessageInfo } from '../types';
import type { SessionStorage } from './types';

type JotaiStore = ReturnType<typeof createStore>;

// --- Helpers (same as memory.ts) ---

function insertSorted(arr: string[], id: string): string[] {
  const result = [...arr];
  let low = 0,
    high = result.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (result[mid] < id) low = mid + 1;
    else high = mid;
  }
  result.splice(low, 0, id);
  return result;
}

function insertPartSorted(arr: Part[], part: Part): Part[] {
  const result = [...arr];
  let low = 0,
    high = result.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (result[mid].id < part.id) low = mid + 1;
    else high = mid;
  }
  result.splice(low, 0, part);
  return result;
}

const STRUCTURAL_PART_FIELDS = new Set(['id', 'messageID', 'sessionID', 'type']);
const SUPPORTED_DELTA_FIELDS = new Set(['text']);

function isSupportedDeltaField(field: string): boolean {
  return SUPPORTED_DELTA_FIELDS.has(field) && !STRUCTURAL_PART_FIELDS.has(field);
}

function clonePart(part: Part): Part {
  return structuredClone(part);
}

function createReadonlyPartView(part: Part): Part {
  return new Proxy(part, {
    set() {
      return true;
    },
    deleteProperty() {
      return true;
    },
    defineProperty() {
      return true;
    },
  });
}

function applyTextDelta(part: Part, delta: string): Part {
  if (!('text' in part) || typeof part.text !== 'string') {
    return part;
  }
  return { ...part, text: part.text + delta };
}

function createSeedTextPart(messageId: string, partId: string, text: string): TextPart {
  return {
    id: partId,
    sessionID: '',
    messageID: messageId,
    type: 'text',
    text,
  };
}

function notify(subscribers: Map<string, Set<() => void>>, key: string): void {
  const subs = subscribers.get(key);
  if (subs) {
    for (const cb of subs) cb();
  }
}

const EMPTY_PARTS: readonly Part[] = Object.freeze([]);

// --- Main ---

type JotaiSessionStorage = SessionStorage & {
  atoms: {
    messageIds: Atom<string[]>;
    messages: Atom<Map<string, MessageInfo>>;
    parts: Atom<Map<string, Part[]>>;
  };
};

function createJotaiStorage(store: JotaiStore): JotaiSessionStorage {
  const messageIdsAtom = atom<string[]>([]);
  const messagesAtom = atom<Map<string, MessageInfo>>(new Map());
  const partsAtom = atom<Map<string, Part[]>>(new Map());

  const partsSnapshot = new Map<string, Part[] | null>();
  const subscribers = new Map<string, Set<() => void>>();

  return {
    atoms: {
      messageIds: messageIdsAtom,
      messages: messagesAtom,
      parts: partsAtom,
    },

    upsertMessage(info) {
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
      const allParts = store.get(partsAtom);
      const arr = allParts.get(messageId) ?? [];
      const idx = arr.findIndex(p => p.id === part.id);
      const nextPart = clonePart(part);
      let nextArr: Part[];
      if (idx >= 0) {
        nextArr = [...arr];
        nextArr[idx] = nextPart;
      } else {
        nextArr = insertPartSorted(arr, nextPart);
      }
      const next = new Map(allParts);
      next.set(messageId, nextArr);
      store.set(partsAtom, next);
      partsSnapshot.set(messageId, null);
      notify(subscribers, `parts:${messageId}`);
    },

    applyPartDelta(messageId, partId, field, delta) {
      if (!isSupportedDeltaField(field)) {
        return;
      }

      const allParts = store.get(partsAtom);
      const arr = allParts.get(messageId);

      const next = new Map(allParts);
      if (!arr) {
        next.set(messageId, [createSeedTextPart(messageId, partId, delta)]);
      } else {
        const idx = arr.findIndex(p => p.id === partId);
        if (idx < 0) {
          next.set(messageId, insertPartSorted(arr, createSeedTextPart(messageId, partId, delta)));
        } else {
          const updatedPart = applyTextDelta(arr[idx], delta);
          if (updatedPart === arr[idx]) {
            return;
          }
          const nextArr = [...arr];
          nextArr[idx] = updatedPart;
          next.set(messageId, nextArr);
        }
      }
      store.set(partsAtom, next);
      partsSnapshot.set(messageId, null);
      notify(subscribers, `parts:${messageId}`);
    },

    deletePart(messageId, partId) {
      const allParts = store.get(partsAtom);
      const arr = allParts.get(messageId);
      if (!arr) return;
      const filtered = arr.filter(p => p.id !== partId);
      const next = new Map(allParts);
      next.set(messageId, filtered);
      store.set(partsAtom, next);
      partsSnapshot.set(messageId, null);
      notify(subscribers, `parts:${messageId}`);
    },

    getParts(messageId) {
      const cached = partsSnapshot.get(messageId);
      if (cached) return cached;

      const arr = store.get(partsAtom).get(messageId);
      if (!arr || arr.length === 0) return EMPTY_PARTS as Part[];

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
      const existingMessageIds = store.get(messageIdsAtom);
      const existingPartMessageIds = [...store.get(partsAtom).keys()];

      store.set(messagesAtom, new Map());
      store.set(messageIdsAtom, []);
      store.set(partsAtom, new Map());
      partsSnapshot.clear();

      for (const messageId of existingMessageIds) {
        notify(subscribers, `message:${messageId}`);
      }
      for (const messageId of existingPartMessageIds) {
        notify(subscribers, `parts:${messageId}`);
      }
      notify(subscribers, 'messageIds');
    },
  };
}

export { createJotaiStorage };
export type { JotaiSessionStorage, JotaiStore };
