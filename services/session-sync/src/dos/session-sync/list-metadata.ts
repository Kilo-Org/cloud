import { eq } from 'drizzle-orm';

import { pendingListMetadata } from '../../db/sqlite-schema';
import { sessionListMetadataSchema, type SessionListMetadata } from '../../protocol';
import { KEY, type Db } from './session';

/** How long a refused index push waits before its next attempt. */
export const LIST_METADATA_RETRY_MS = 5_000;

/**
 * Records the metadata an accepted batch owes the creator index in the same
 * transaction as the batch, so a refused tenant call is retried instead of
 * leaving the list stale until the next session put.
 */
export function stage(db: Db, metadata: SessionListMetadata, now: number): void {
  const value = JSON.stringify(metadata);
  db.insert(pendingListMetadata)
    .values({ key: KEY, value, retry_at: now })
    .onConflictDoUpdate({ target: pendingListMetadata.key, set: { value, retry_at: now } })
    .run();
}

export function pending(db: Db): { metadata: SessionListMetadata; retryAt: number } | undefined {
  const row = db.select().from(pendingListMetadata).where(eq(pendingListMetadata.key, KEY)).get();
  if (!row) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(row.value);
  } catch {
    clear(db);
    return undefined;
  }
  const parsed = sessionListMetadataSchema.safeParse(value);
  if (!parsed.success) {
    clear(db);
    return undefined;
  }
  return { metadata: parsed.data, retryAt: row.retry_at };
}

export function clear(db: Db): void {
  db.delete(pendingListMetadata).where(eq(pendingListMetadata.key, KEY)).run();
}

export function defer(db: Db, retryAt: number): void {
  db.update(pendingListMetadata)
    .set({ retry_at: retryAt })
    .where(eq(pendingListMetadata.key, KEY))
    .run();
}
