import { eq } from 'drizzle-orm';

import { listMetadata } from '../../db/sqlite-schema';
import { sessionListMetadataSchema, type SessionListMetadata } from '../../protocol';
import { KEY, type Db } from './session';

/** How long a refused index push waits before its next attempt. */
export const LIST_METADATA_RETRY_MS = 5_000;

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
  values: { owed: string | null; pushed?: string | null; retry_at: number }
): void {
  db.insert(listMetadata)
    .values({
      key: KEY,
      owed: values.owed,
      pushed: values.pushed ?? null,
      retry_at: values.retry_at,
    })
    .onConflictDoUpdate({ target: listMetadata.key, set: values })
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
    // The index already shows this record.
    put(db, { owed: null, retry_at: now });
    return;
  }
  put(db, { owed: value, retry_at: now });
}

export function owed(
  db: Db
): { value: string; metadata: SessionListMetadata; retryAt: number } | undefined {
  const row = read(db);
  if (!row?.owed) return undefined;
  const metadata = parse(row.owed);
  if (!metadata) {
    put(db, { owed: null, pushed: row.pushed, retry_at: row.retry_at });
    return undefined;
  }
  return { value: row.owed, metadata, retryAt: row.retry_at };
}

/** The index accepted `value`; it becomes the record later puts compare with. */
export function succeeded(db: Db, value: string): void {
  put(db, { owed: null, pushed: value, retry_at: 0 });
}

export function refused(db: Db, retryAt: number): void {
  const row = read(db);
  put(db, { owed: row?.owed ?? null, pushed: row?.pushed ?? null, retry_at: retryAt });
}

/** A tombstone leaves every list, so nothing stays owed. */
export function clear(db: Db): void {
  const row = read(db);
  if (row) put(db, { owed: null, pushed: row.pushed, retry_at: 0 });
}
