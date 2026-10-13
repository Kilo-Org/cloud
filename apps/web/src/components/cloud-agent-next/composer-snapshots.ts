import type { CloudAgentAttachmentFile } from '@/hooks/useCloudAgentAttachmentUpload';

export type ComposerSnapshot = {
  text: string;
  attachments: CloudAgentAttachmentFile[];
};

/** Drafts kept for conversations the composer is not showing. */
export const COMPOSER_SNAPSHOT_LIMIT = 10;

/**
 * Store a conversation's draft as the newest entry, drop it when empty, and
 * evict the oldest drafts beyond the limit. The saved key and protected keys
 * (the shown conversation, a conversation with a send in flight) are never
 * evicted, because their attachments are still in use. Returns the evicted
 * drafts so the caller can free their preview URLs.
 */
export function saveComposerSnapshot(
  snapshots: Map<string, ComposerSnapshot>,
  key: string,
  snapshot: ComposerSnapshot,
  isProtected: (key: string) => boolean
): ComposerSnapshot[] {
  snapshots.delete(key);
  if (snapshot.text !== '' || snapshot.attachments.length > 0) snapshots.set(key, snapshot);

  const evicted: ComposerSnapshot[] = [];
  for (const [candidateKey, candidate] of snapshots) {
    if (snapshots.size <= COMPOSER_SNAPSHOT_LIMIT) break;
    if (candidateKey === key || isProtected(candidateKey)) continue;
    snapshots.delete(candidateKey);
    evicted.push(candidate);
  }
  return evicted;
}

/** Take a conversation's draft out of the store; the live composer owns it from here. */
export function takeComposerSnapshot(
  snapshots: Map<string, ComposerSnapshot>,
  key: string
): ComposerSnapshot | undefined {
  const snapshot = snapshots.get(key);
  snapshots.delete(key);
  return snapshot;
}

export function revokeComposerSnapshotPreviews(snapshots: Iterable<ComposerSnapshot>): void {
  for (const snapshot of snapshots) {
    for (const attachment of snapshot.attachments) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }
  }
}
