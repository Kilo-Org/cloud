import type { Part } from '@kilocode/app-shared/opencode';
import type { ReadonlyPart } from '../types';
import { forgetPartUpdateTime, publishPartsChanged } from './helpers';
import type { PartOrderingEvidence, PartsSnapshot, SubscriberRegistry } from './helpers';
import type { SessionStorage } from './types';
import { forgetMessageVersions, forgetPartVersion, storageVersions } from './versions';

/** Message rows a backend keeps: presence, the row itself, and the ordered id list. */
type MessageRows = {
  has(messageId: string): boolean;
  remove(messageId: string): void;
  clear(): void;
  ids(): readonly string[];
  setIds(ids: string[]): void;
};

/** Parts a backend keeps per message, plus their bulk removal. */
type MessageParts = {
  get(messageId: string): Part[] | undefined;
  set(messageId: string, parts: Part[]): void;
  has(messageId: string): boolean;
  remove(messageId: string): void;
  messageIds(): string[];
  clear(): void;
};

/**
 * The containers and hooks a lifecycle step reads and writes. The step owns
 * the order in which state is forgotten, published and notified; the backend
 * owns how each container is stored (plain maps vs Jotai atoms) and supplies:
 * `beforeStructuralChange` (Jotai flushes its coalesced deltas; memory runs
 * nothing) and `publishPartsRevision` (Jotai bumps its revision atom; memory
 * runs nothing).
 */
type StorageContainers = {
  messages: MessageRows;
  parts: MessageParts;
  snapshot: PartsSnapshot;
  evidence: PartOrderingEvidence;
  subscribers: SubscriberRegistry;
  beforeStructuralChange(): void;
  publishPartsRevision(): void;
};

/** Drop one part and republish its parts channel. */
function deletePartFromStorage(
  storage: SessionStorage,
  containers: StorageContainers,
  messageId: string,
  partId: string
): void {
  forgetPartVersion(storage, messageId, partId);
  containers.beforeStructuralChange();
  const arr = containers.parts.get(messageId);
  if (!arr) return;
  containers.parts.set(
    messageId,
    arr.filter(p => p.id !== partId)
  );
  forgetPartUpdateTime(containers.evidence, messageId, partId);
  containers.publishPartsRevision();
  publishPartsChanged(containers.snapshot, containers.subscribers, messageId);
}

/** Remove one message row, its parts, and notify every affected channel. */
function deleteMessageFromStorage(
  storage: SessionStorage,
  containers: StorageContainers,
  messageId: string
): void {
  forgetMessageVersions(storage, messageId);
  containers.beforeStructuralChange();
  // A part delta can create parts before the message row (see `applyPartDelta`),
  // so part state is dropped regardless of the row.
  const hadMessage = containers.messages.has(messageId);
  if (hadMessage) {
    containers.messages.remove(messageId);
    containers.messages.setIds(containers.messages.ids().filter(id => id !== messageId));
  }

  const hadParts = containers.parts.has(messageId);
  for (const part of containers.parts.get(messageId) ?? []) {
    forgetPartUpdateTime(containers.evidence, messageId, part.id);
  }
  containers.parts.remove(messageId);
  containers.snapshot.delete(messageId);
  if (hadParts) {
    containers.publishPartsRevision();
    containers.subscribers.notifyParts(messageId);
  }

  if (!hadMessage) return;
  containers.subscribers.notifyMessage(messageId);
  containers.subscribers.notifyMessageIds();
}

/** Drop the whole session and notify every affected channel. */
function clearStorage(storage: SessionStorage, containers: StorageContainers): void {
  storageVersions.delete(storage);
  containers.beforeStructuralChange();
  const existingMessageIds = [...containers.messages.ids()];
  const existingPartMessageIds = containers.parts.messageIds();

  containers.messages.clear();
  containers.messages.setIds([]);
  containers.parts.clear();
  containers.publishPartsRevision();
  containers.snapshot.clear();
  containers.evidence.clear();

  for (const messageId of existingMessageIds) {
    containers.subscribers.notifyMessage(messageId);
  }
  for (const messageId of existingPartMessageIds) {
    containers.subscribers.notifyParts(messageId);
  }
  containers.subscribers.notifyMessageIds();
}

export type { StorageContainers };
export { deletePartFromStorage, deleteMessageFromStorage, clearStorage };
