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
  appendPartTextChunks,
  createPartViewCache,
  createReadonlyPartView,
  createSubscriberRegistry,
  insertSortedBy,
  isSupportedDeltaField,
  messageIdKey,
  publishPartsChanged,
  readPartsSnapshot,
  upsertPartDroppingStaleSyntheticParts,
} from './helpers';

function createMemoryStorage(): SessionStorage {
  const messages = new Map<string, MessageInfo>();
  let messageIds: string[] = [];

  const parts = new Map<string, Part[]>();
  const partsSnapshot: PartsSnapshot = new Map<string, readonly ReadonlyPart[] | null>();
  // Immutable views of the stored parts, per message and kept across snapshot
  // rebuilds so a rebuild reuses the view of every part that did not change.
  const partViews = createPartViewCache();
  // Ordering evidence of the last accepted update per part, owned next to the
  // parts it describes (see `upsertPartDroppingStaleSyntheticParts`).
  const partEvidence = new Map<string, number>();

  const subscribers = createSubscriberRegistry();

  const containers: StorageContainers = {
    messages: {
      has: messageId => messages.has(messageId),
      remove: messageId => {
        messages.delete(messageId);
      },
      clear: () => messages.clear(),
      ids: () => messageIds,
      setIds: ids => {
        messageIds = ids;
      },
    },
    parts: {
      get: messageId => parts.get(messageId),
      set: (messageId, arr) => {
        parts.set(messageId, arr);
      },
      has: messageId => parts.has(messageId),
      remove: messageId => {
        parts.delete(messageId);
      },
      messageIds: () => [...parts.keys()],
      clear: () => parts.clear(),
    },
    snapshot: partsSnapshot,
    views: partViews,
    evidence: partEvidence,
    subscribers,
    beforeStructuralChange: () => {},
    publishPartsRevision: () => {},
    publishMessagesRevision: () => {},
  };

  const storage: SessionStorage = {
    upsertMessage(info) {
      const existing = messages.get(info.id);
      messages.set(info.id, info);
      if (existing) {
        subscribers.notifyMessage(info.id);
      } else {
        messageIds = insertSortedBy(messageIds, info.id, messageIdKey);
        subscribers.notifyMessageIds();
      }
    },

    getMessageIds() {
      return [...messageIds];
    },

    getMessageInfo(messageId) {
      return messages.get(messageId);
    },

    upsertPart(messageId, part, eventTime, authoritative) {
      const arr = parts.get(messageId) ?? [];
      parts.set(
        messageId,
        upsertPartDroppingStaleSyntheticParts(
          messageId,
          arr,
          part,
          eventTime,
          partEvidence,
          authoritative
        )
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
      deletePartFromStorage(storage, containers, messageId, partId);
    },

    getParts(messageId) {
      return readPartsSnapshot(messageId, parts.get(messageId), partsSnapshot, partViews);
    },

    getPart(messageId, partId) {
      const part = parts.get(messageId)?.find(item => item.id === partId);
      return part ? createReadonlyPartView(part) : undefined;
    },

    getPartIds(messageId) {
      return (parts.get(messageId) ?? []).map(p => p.id);
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

export { createMemoryStorage };
