import type { Part, TextPart } from '@/types/opencode.gen';
import type { MessageInfo } from '../types';
import type { SessionStorage } from './types';

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
      const idx = arr.findIndex(p => p.id === part.id);
      const nextPart = clonePart(part);
      if (idx >= 0) {
        const nextArr = [...arr];
        nextArr[idx] = nextPart;
        parts.set(messageId, nextArr);
      } else {
        parts.set(messageId, insertPartSorted(arr, nextPart));
      }
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
      if (idx < 0) {
        // Part not yet known for this message — create it with the delta as seed
        parts.set(messageId, insertPartSorted(arr, createSeedTextPart(messageId, partId, delta)));
        partsSnapshot.set(messageId, null);
        notify(subscribers, `parts:${messageId}`);
        return;
      }

      const updatedPart = applyTextDelta(arr[idx], delta);
      if (updatedPart === arr[idx]) {
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
  };
}

export { createMemoryStorage };
