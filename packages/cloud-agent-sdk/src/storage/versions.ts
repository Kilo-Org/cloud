import type { ChatEventVersion } from '../normalizer';
import type { SessionStorage } from './types';

type RowVersion = {
  version: ChatEventVersion;
  removed: boolean;
  messageId: string;
  sessionId: string;
};

const MAX_REMOVAL_VERSIONS = 512;
const storageVersions = new WeakMap<
  SessionStorage,
  {
    rows: Map<string, RowVersion>;
    messages: Map<string, ChatEventVersion>;
    removals: Map<string, RowVersion>;
    removalFloors: Map<string, Map<string, number>>;
  }
>();

function forgetMessageVersions(sessionStorage: SessionStorage, messageId: string): void {
  const versions = storageVersions.get(sessionStorage);
  if (!versions) return;
  for (const [key, row] of versions.rows) {
    if (row.messageId !== messageId) continue;
    versions.messages.delete(`${row.sessionId}\u0000${messageId}`);
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
      key === `${row.sessionId}\u0000${messageId}\u0000${partId}` &&
      !row.removed
    ) {
      versions.rows.delete(key);
      if (
        !sessionStorage.getMessageInfo(messageId) &&
        sessionStorage.getParts(messageId).every(part => part.id === partId)
      ) {
        versions.messages.delete(`${row.sessionId}\u0000${messageId}`);
      }
    }
  }
}

export { MAX_REMOVAL_VERSIONS, storageVersions, forgetMessageVersions, forgetPartVersion };
