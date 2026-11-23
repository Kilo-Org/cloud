import { eq } from 'drizzle-orm';

import { listMetadata } from '../../db/sqlite-schema';
import { sessionListMetadataSchema, type SessionListMetadata } from '../../protocol';
import { KEY, type Db } from './session';

/** First retry delay after a refused index push; doubles up to the cap. */
export const LIST_METADATA_RETRY_MS = 5_000;
export const LIST_METADATA_RETRY_MAX_MS = 10 * 60_000;

type Row = typeof listMetadata.$inferSelect;

function read(db: Db): Row | undefined {
  return db.select().from(listMetadata).where(eq(listMetadata.key, KEY)).get();
}

function parse(text: string | null): SessionListMetadata | undefined {
  if (text === null) return undefined;
  try {
    const parsed = sessionListMetadataSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function put(
  db: Db,
  values: { owed: string | null; pushed?: string | null; retry_at: number; attempts?: number }
): void {
  const row = {
    owed: values.owed,
    pushed: values.pushed ?? null,
    retry_at: values.retry_at,
    attempts: values.attempts ?? 0,
  };
  db.insert(listMetadata)
    .values({ key: KEY, ...row })
    .onConflictDoUpdate({ target: listMetadata.key, set: row })
    .run();
}

/**
 * Records the metadata an accepted batch owes the creator index in the batch's
 * own transaction. Metadata the index already holds is not owed again, so a
 * repeated session put costs no tenant call.
 */
export function stage(db: Db, metadata: SessionListMetadata, now: number): void {
  const value = JSON.stringify(metadata);
  const row = read(db);
  if (row?.pushed === value) {
    put(db, { owed: null, pushed: row.pushed, retry_at: now, attempts: 0 });
    return;
  }
  put(db, {
    owed: value,
    pushed: row?.pushed ?? null,
    retry_at: now,
    attempts: row?.attempts ?? 0,
  });
}

export function owed(
  db: Db,
  now: number
): { value: string; metadata: SessionListMetadata; retryAt: number } | undefined {
  const row = read(db);
  if (!row?.owed) return undefined;
  const metadata = parse(row.owed);
  if (metadata) return { value: row.owed, metadata, retryAt: row.retry_at };
  // An unreadable debt still describes a session that changed; push the field
  // that always resolves instead of dropping the entry silently.
  const value = JSON.stringify({ updatedAt: now });
  put(db, { owed: value, pushed: row.pushed, retry_at: now, attempts: row.attempts });
  return { value, metadata: { updatedAt: now }, retryAt: now };
}

/**
 * The index accepted `value`; it becomes the record later puts compare with.
 * A newer value staged meanwhile stays owed, so its own push still happens.
 */
export function succeeded(db: Db, value: string): void {
  const row = read(db);
  put(db, {
    owed: row?.owed === value ? null : (row?.owed ?? null),
    pushed: value,
    retry_at: row?.owed === value ? 0 : (row?.retry_at ?? 0),
    attempts: row?.owed === value ? 0 : (row?.attempts ?? 0),
  });
}

/** Defers the owed push: bounded exponential backoff, never sooner than a retry hint. */
export function refused(db: Db, now: number, hint?: number): number {
  const row = read(db);
  const attempts = (row?.attempts ?? 0) + 1;
  const backoff = Math.min(
    LIST_METADATA_RETRY_MAX_MS,
    LIST_METADATA_RETRY_MS * 2 ** Math.min(attempts - 1, 16)
  );
  const retryAt = Math.max(now + backoff, hint ?? 0);
  put(db, {
    owed: row?.owed ?? null,
    pushed: row?.pushed ?? null,
    retry_at: retryAt,
    attempts,
  });
  return retryAt;
}

/** A tombstone leaves every list, so nothing stays owed. */
export function clear(db: Db): void {
  const row = read(db);
  if (row) put(db, { owed: null, pushed: row.pushed, retry_at: 0, attempts: 0 });
}
