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

function createMemoryStorage(): SessionStorage {
  const messages = new Map<string, MessageInfo>();
  let messageIds: string[] = [];

  const parts = new Map<string, Part[]>();
  const partsSnapshot = new Map<string, Part[] | null>();

  const subscribers = new Map<string, Set<() => void>>();

  return {
    upsertMessage(info) {
      const existing = messages.get(info.id);
      messages.set(info.id, info);
      if (existing) {
        notify(subscribers, `message:${info.id}`);
      } else {
        messageIds = insertSorted(messageIds, info.id);
        notify(subscribers, 'messageIds');
      }
    },

    getMessageIds() {
      return [...messageIds];
    },

    getMessageInfo(messageId) {
      return messages.get(messageId);
    },

    upsertPart(messageId, part) {
      const arr = parts.get(messageId) ?? [];
      parts.set(messageId, upsertPartDroppingStaleSyntheticTextParts(arr, part));
      partsSnapshot.set(messageId, null);
      notify(subscribers, `parts:${messageId}`);
    },

    applyPartDelta(messageId, partId, field, delta) {
      if (!isSupportedDeltaField(field)) {
        return;
      }

      const arr = parts.get(messageId);

      if (!arr) {
        // First delta for this message — bootstrap a minimal text part
        parts.set(messageId, [createSeedTextPart(messageId, partId, delta)]);
        partsSnapshot.set(messageId, null);
        notify(subscribers, `parts:${messageId}`);
        return;
      }
      const idx = arr.findIndex(p => p.id === partId);
      const existing = idx >= 0 ? arr[idx] : undefined;
      if (!existing) {
        // Part not yet known for this message — create it with the delta as seed
        parts.set(messageId, insertPartSorted(arr, createSeedTextPart(messageId, partId, delta)));
        partsSnapshot.set(messageId, null);
        notify(subscribers, `parts:${messageId}`);
        return;
      }

      const updatedPart = applyTextDelta(existing, delta);
      if (updatedPart === existing) {
        return;
      }
      const nextArr = [...arr];
      nextArr[idx] = updatedPart;
      parts.set(messageId, nextArr);
      partsSnapshot.set(messageId, null);
      notify(subscribers, `parts:${messageId}`);
    },

    deletePart(messageId, partId) {
      const arr = parts.get(messageId);
      if (!arr) return;
      const filtered = arr.filter(p => p.id !== partId);
      parts.set(messageId, filtered);
      partsSnapshot.set(messageId, null);
      notify(subscribers, `parts:${messageId}`);
    },

    getParts(messageId) {
      const cached = partsSnapshot.get(messageId);
      if (cached) return cached;

      const arr = parts.get(messageId);
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
      const existingMessageIds = [...messageIds];
      const existingPartMessageIds = [...parts.keys()];

      messages.clear();
      messageIds = [];
      parts.clear();
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
      if (!messages.has(messageId)) return;

      messages.delete(messageId);
      messageIds = messageIds.filter(id => id !== messageId);

      if (parts.has(messageId)) {
        parts.delete(messageId);
        partsSnapshot.delete(messageId);
        notify(subscribers, `parts:${messageId}`);
      }

      notify(subscribers, `message:${messageId}`);
      notify(subscribers, 'messageIds');
    },
  };
}

export { createMemoryStorage };
