import { and, asc, count, eq, lte, ne } from 'drizzle-orm';

import { blobs } from '../../db/sqlite-schema';
import { LIMITS, type BlobAck, type BlobRef, type Principal } from '../../protocol';
import { live, load, raise, update, visible, writable, type Db, type Meta } from './session';

/** Includes the last R2 write and clock skew between the Worker and object. */
export const SWEEP_MARGIN_MS = 60_000;
/** Limits each alarm to a bounded set of SQL rows and R2 keys. */
export const CLEANUP_ITEMS = 64;

export type Upload = { status: 'upload'; attempt: string; key: string; deadline: number };
export type Begin = { status: 'ready' } | Upload;
export type Cleanup = { hash: string; attempt: string; key: string };

/** R2 prefix that holds every private object of one session. */
export function prefix(meta: Meta): string {
  const segments = [meta.tenant_type, meta.tenant_id, meta.session_id].map(encodeURIComponent);
  return `sessions/${segments.join('/')}/blobs/`;
}

export function key(meta: Meta, hash: string, attempt: string): string {
  return `${prefix(meta)}${hash}/${attempt}`;
}

/**
 * Admits exactly one upload per hash. A second caller cannot refresh another
 * attempt's deadline, abort it, or PUT to its physical object key.
 */
export function begin(
  db: Db,
  principal: Principal,
  sessionID: string,
  ref: BlobRef,
  now: number
): Begin {
  const meta = writable(db, principal, sessionID);
  const row = db.select().from(blobs).where(eq(blobs.hash, ref.hash)).get();
  if (row) {
    if (row.bytes !== ref.bytes) {
      raise('blob_hash_mismatch', 'The size differs from the stored blob with this hash', {
        bytes: row.bytes,
      });
    }
    if (row.state === 'ready') return { status: 'ready' };
    raise(
      'upload_in_progress',
      'Another upload or cleanup owns this hash; retry after its deadline',
      {
        retryAt: row.deadline + SWEEP_MARGIN_MS,
      }
    );
  }
  const total = meta.blob_bytes + ref.bytes;
  const usage = db.select({ count: count() }).from(blobs).get();
  if (total > LIMITS.sessionBlobBytes || (usage?.count ?? 0) >= LIMITS.sessionBlobs) {
    raise('storage_budget_exceeded', 'The blob exceeds the session storage budget', {
      blobBytes: LIMITS.sessionBlobBytes,
      blobs: LIMITS.sessionBlobs,
    });
  }
  const attempt = crypto.randomUUID();
  const deadline = now + LIMITS.uploadMs;
  db.insert(blobs)
    .values({
      hash: ref.hash,
      attempt,
      bytes: ref.bytes,
      state: 'pending',
      deadline,
      created_at: now,
    })
    .run();
  update(db, { blob_bytes: total, updated_at: now });
  return { status: 'upload', attempt, key: key(meta, ref.hash, attempt), deadline };
}

/**
 * Fences only the failing attempt. Keep its deadline and reservation until the
 * sweep, so even a disconnected PUT that finishes late has a cleanup record.
 * An old abort is harmless after either a successful commit or a new attempt.
 */
export function abort(
  db: Db,
  principal: Principal,
  sessionID: string,
  hash: string,
  attempt: string
): void {
  const meta = visible(db, principal, sessionID);
  if (meta.creator_id !== principal.userID) {
    raise('creator_mismatch', 'Only the session creator can change this session');
  }
  db.update(blobs)
    .set({ state: 'cleaning' })
    .where(and(eq(blobs.hash, hash), eq(blobs.attempt, attempt), eq(blobs.state, 'pending')))
    .run();
}

/** A verified object becomes readable only while its original reservation remains pending. */
export function commit(
  db: Db,
  principal: Principal,
  sessionID: string,
  ref: BlobRef,
  attempt: string,
  now: number
): BlobAck {
  writable(db, principal, sessionID);
  const row = db.select().from(blobs).where(eq(blobs.hash, ref.hash)).get();
  if (!row || row.attempt !== attempt || row.state === 'cleaning') {
    raise('upload_timeout', 'The upload attempt no longer owns its reservation', {
      hash: ref.hash,
    });
  }
  if (row.bytes !== ref.bytes) raise('blob_hash_mismatch', 'The upload size does not match');
  if (row.state === 'ready')
    return { version: 1, hash: ref.hash, bytes: ref.bytes, created: false };
  if (row.deadline + SWEEP_MARGIN_MS <= now) {
    raise('upload_timeout', 'The upload reservation expired; upload the blob again', {
      hash: ref.hash,
    });
  }
  db.update(blobs)
    .set({ state: 'ready' })
    .where(and(eq(blobs.hash, ref.hash), eq(blobs.attempt, attempt)))
    .run();
  return { version: 1, hash: ref.hash, bytes: ref.bytes, created: true };
}

/** Derives only this attempt's key, even after deletion or replacement of its row. */
export function target(
  db: Db,
  principal: Principal,
  sessionID: string,
  hash: string,
  attempt: string
) {
  const meta = visible(db, principal, sessionID);
  if (meta.creator_id !== principal.userID) {
    raise('creator_mismatch', 'Only the session creator can change this session');
  }
  return { key: key(meta, hash, attempt), deleted: meta.deleted_at !== null };
}

/** Returns the physical object of a verified blob that any tenant member can read. */
export function locate(db: Db, principal: Principal, sessionID: string, hash: string) {
  const meta = live(db, principal, sessionID);
  const row = db
    .select({ bytes: blobs.bytes, attempt: blobs.attempt })
    .from(blobs)
    .where(and(eq(blobs.hash, hash), eq(blobs.state, 'ready')))
    .get();
  if (!row) raise('blob_not_found', 'The blob is not stored for this session', { hash });
  return { key: key(meta, hash, row.attempt), bytes: row.bytes };
}

/** Claims expired attempts before yielding to R2; a claim prevents any later commit. */
export function claim(db: Db, meta: Meta, now: number): Cleanup[] {
  const rows = db
    .select({ hash: blobs.hash, attempt: blobs.attempt })
    .from(blobs)
    .where(and(ne(blobs.state, 'ready'), lte(blobs.deadline, now - SWEEP_MARGIN_MS)))
    .orderBy(asc(blobs.deadline), asc(blobs.hash))
    .limit(CLEANUP_ITEMS)
    .all();
  for (const row of rows) {
    db.update(blobs)
      .set({ state: 'cleaning' })
      .where(and(eq(blobs.hash, row.hash), eq(blobs.attempt, row.attempt)))
      .run();
  }
  return rows.map(row => ({ ...row, key: key(meta, row.hash, row.attempt) }));
}

/** Releases only completed claims; no stale cleanup can remove a replacement attempt. */
export function finish(db: Db, claimed: Cleanup[], now: number): void {
  let released = 0;
  for (const item of claimed) {
    const rows = db
      .delete(blobs)
      .where(
        and(eq(blobs.hash, item.hash), eq(blobs.attempt, item.attempt), eq(blobs.state, 'cleaning'))
      )
      .returning({ bytes: blobs.bytes })
      .all();
    for (const row of rows) released += row.bytes;
  }
  const meta = load(db);
  if (meta && meta.deleted_at === null && released > 0) {
    update(db, { blob_bytes: meta.blob_bytes - released, updated_at: now });
  }
}

/** Earliest non-ready attempt's cleanup time, or null when every blob is ready. */
export function nextSweep(db: Db): number | null {
  const oldest = db
    .select({ deadline: blobs.deadline })
    .from(blobs)
    .where(ne(blobs.state, 'ready'))
    .orderBy(asc(blobs.deadline))
    .limit(1)
    .get();
  return oldest ? oldest.deadline + SWEEP_MARGIN_MS : null;
}
