import type { ChatEventVersion } from '../normalizer';
import type { SessionStorage } from './types';

type RowVersion = {
  version: ChatEventVersion;
  removed: boolean;
  messageId: string;
  sessionId: string;
};

export type StorageVersions = {
  rows: Map<string, RowVersion>;
  messages: Map<string, ChatEventVersion>;
  removals: Map<string, RowVersion>;
  removalFloors: Map<string, Map<string, number>>;
};

const MAX_REMOVAL_VERSIONS = 512;
const storageVersions = new WeakMap<SessionStorage, StorageVersions>();

// This module owns the row-key grammar, so callers never hand-build the keys.
export function messageVersionKey(sessionId: string, messageId: string): string {
  return `${sessionId}\u0000${messageId}`;
}

export function rowVersionKey(messageKey: string, partId: string | undefined): string {
  return partId === undefined ? messageKey : `${messageKey}\u0000${partId}`;
}

function forgetMessageVersions(sessionStorage: SessionStorage, messageId: string): void {
  const versions = storageVersions.get(sessionStorage);
  if (!versions) return;
  for (const [key, row] of versions.rows) {
    if (row.messageId !== messageId) continue;
    versions.messages.delete(messageVersionKey(row.sessionId, messageId));
    if (!row.removed) versions.rows.delete(key);
  }
}

function forgetPartVersion(
  sessionStorage: SessionStorage,
  messageId: string,
  partId: string
): void {
  const versions = storageVersions.get(sessionStorage);
  if (!versions) return;
  for (const [key, row] of versions.rows) {
    if (
      row.messageId === messageId &&
      key === rowVersionKey(messageVersionKey(row.sessionId, messageId), partId) &&
      !row.removed
    ) {
      versions.rows.delete(key);
      // The part row is still in storage here, so `partId` itself is among the
      // ids: any other id means the message keeps another part.
      if (
        !sessionStorage.getMessageInfo(messageId) &&
        !sessionStorage.getPartIds(messageId).some(id => id !== partId)
      ) {
        versions.messages.delete(messageVersionKey(row.sessionId, messageId));
      }
    }
  }
}

/**
 * Evicts the oldest removal tombstone once the removal map exceeds
 * `MAX_REMOVAL_VERSIONS`. The evicted message's stored version is dropped only
 * when no row key names that message, and the per-source floor advances so an
 * older page cannot resurrect it.
 */
export function evictOldestRemoval(versions: StorageVersions): void {
  const oldest = versions.removals.entries().next().value;
  if (!oldest) return;
  const [oldKey, oldRow] = oldest;
  versions.removals.delete(oldKey);
  versions.rows.delete(oldKey);
  const oldMessageKey = messageVersionKey(oldRow.sessionId, oldRow.messageId);
  if (
    ![...versions.rows.keys()].some(
      rowKey => rowKey === oldMessageKey || rowKey.startsWith(`${oldMessageKey}\u0000`)
    )
  ) {
    versions.messages.delete(oldMessageKey);
  }
  let sourceFloors = versions.removalFloors.get(oldRow.sessionId);
  if (!sourceFloors) {
    sourceFloors = new Map();
    versions.removalFloors.set(oldRow.sessionId, sourceFloors);
  }
  sourceFloors.set(
    oldRow.version.sourceId,
    Math.max(sourceFloors.get(oldRow.version.sourceId) ?? 0, oldRow.version.cursor)
  );
}

export { MAX_REMOVAL_VERSIONS, storageVersions, forgetMessageVersions, forgetPartVersion };
