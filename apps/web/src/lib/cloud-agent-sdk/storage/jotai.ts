import { atom } from 'jotai';
import type { Atom } from 'jotai';
import type { createStore } from 'jotai';
import type { Part } from '@/types/opencode.gen';
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
      const nextArr = upsertPartDroppingStaleSyntheticTextParts(arr, part);
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
        const existing = idx >= 0 ? arr[idx] : undefined;
        if (!existing) {
          next.set(messageId, insertPartSorted(arr, createSeedTextPart(messageId, partId, delta)));
        } else {
          const updatedPart = applyTextDelta(existing, delta);
          if (updatedPart === existing) {
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

    deleteMessage(messageId) {
      const messages = store.get(messagesAtom);
      if (!messages.has(messageId)) return;

      const nextMessages = new Map(messages);
      nextMessages.delete(messageId);
      store.set(messagesAtom, nextMessages);

      const messageIds = store.get(messageIdsAtom);
      const nextMessageIds = messageIds.filter(id => id !== messageId);
      store.set(messageIdsAtom, nextMessageIds);

      const allParts = store.get(partsAtom);
      if (allParts.has(messageId)) {
        const nextParts = new Map(allParts);
        nextParts.delete(messageId);
        store.set(partsAtom, nextParts);
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
