import type { Part } from '@kilocode/app-shared/opencode';
import type { MessageInfo } from '../types';
import type { SessionStorage } from './types';
import {
  EMPTY_PARTS,
  appendPartTextChunks,
  clonePart,
  createReadonlyPartView,
  forgetPartUpdateTime,
  insertSorted,
  isSupportedDeltaField,
  notify,
  publishPartsChanged,
  upsertPartDroppingStaleSyntheticParts,
} from './helpers';

function createMemoryStorage(): SessionStorage {
  const messages = new Map<string, MessageInfo>();
  let messageIds: string[] = [];

  const parts = new Map<string, Part[]>();
  const partsSnapshot = new Map<string, Part[] | null>();
  // Ordering evidence of the last accepted update per part, owned next to the
  // parts it describes (see `upsertPartDroppingStaleSyntheticParts`).
  const partEvidence = new Map<string, number>();

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

    upsertPart(messageId, part, eventTime) {
      const arr = parts.get(messageId) ?? [];
      parts.set(
        messageId,
        upsertPartDroppingStaleSyntheticParts(arr, part, eventTime, partEvidence)
      );
      publishPartsChanged(partsSnapshot, subscribers, messageId);
    },

    applyPartDelta(messageId, partId, field, delta) {
      if (!isSupportedDeltaField(field)) {
        return;
      }

      const arr = parts.get(messageId);
      const nextArr = appendPartTextChunks(arr, messageId, partId, [delta]);
      if (nextArr === arr) {
        return;
      }
      parts.set(messageId, nextArr);
      publishPartsChanged(partsSnapshot, subscribers, messageId);
    },

    deletePart(messageId, partId) {
      const arr = parts.get(messageId);
      if (!arr) return;
      parts.set(
        messageId,
        arr.filter(p => p.id !== partId)
      );
      forgetPartUpdateTime(partEvidence, messageId, partId);
      publishPartsChanged(partsSnapshot, subscribers, messageId);
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
      partEvidence.clear();

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
        for (const part of parts.get(messageId) ?? []) {
          forgetPartUpdateTime(partEvidence, messageId, part.id);
        }
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
