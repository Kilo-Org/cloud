import { desc, eq } from 'drizzle-orm';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';

import { receipts, session } from '../../db/sqlite-schema';
import type { ErrorCode, Principal, Receipt, SessionState, SyncError } from '../../protocol';

export type Db = DrizzleSqliteDODatabase;
export type Meta = typeof session.$inferSelect;

/** The only row key of the `session` table. */
export const KEY = 1;

/** Thrown inside a storage transaction to roll it back with a client-visible error. */
export class SyncFailure extends Error {
  constructor(readonly error: SyncError) {
    super(error.message);
    this.name = 'SyncFailure';
  }
}

export function raise(code: ErrorCode, message: string, details?: SyncError['details']): never {
  throw new SyncFailure(details ? { code, message, details } : { code, message });
}

export function load(db: Db): Meta | undefined {
  return db.select().from(session).where(eq(session.key, KEY)).get();
}

function belongs(meta: Meta, principal: Principal, sessionID: string): boolean {
  return (
    meta.session_id === sessionID &&
    meta.tenant_type === principal.tenant.type &&
    meta.tenant_id === principal.tenant.id
  );
}

/** Returns the registered session, including its tombstone. */
export function visible(db: Db, principal: Principal, sessionID: string): Meta {
  const meta = load(db);
  if (!meta || !belongs(meta, principal, sessionID)) {
    raise('session_not_found', 'The session is not registered');
  }
  return meta;
}

/** Returns a registered session that was not deleted. Any tenant member can read it. */
export function live(db: Db, principal: Principal, sessionID: string): Meta {
  const meta = visible(db, principal, sessionID);
  if (meta.deleted_at !== null) raise('session_deleted', 'The session was deleted from the cloud');
  return meta;
}

/** Returns a live session that the principal created. Only the creator can change it. */
export function writable(db: Db, principal: Principal, sessionID: string): Meta {
  const meta = live(db, principal, sessionID);
  requireCreator(meta, principal);
  return meta;
}

function requireCreator(meta: Meta, principal: Principal): void {
  if (meta.creator_id !== principal.userID) {
    raise('creator_mismatch', 'Only the session creator can change this session');
  }
}

export type ReceiptRow = typeof receipts.$inferSelect;

export function toReceipt(sessionID: string, row: ReceiptRow): Receipt {
  return {
    version: 1,
    sessionID,
    batchID: row.batch_id,
    after: row.after,
    through: row.through,
    revision: row.revision,
    changes: row.changes,
    digest: row.digest,
    committedAt: row.committed_at,
  };
}

/** Reads the state a producer needs to recover; `lastReceipt` is the newest receipt. */
export function toState(db: Db, meta: Meta): SessionState {
  const tenant =
    meta.tenant_type === 'user'
      ? { type: 'user' as const, id: meta.tenant_id }
      : { type: 'organization' as const, id: meta.tenant_id };
  if (meta.deleted_at !== null) {
    return {
      version: 1,
      sessionID: meta.session_id,
      tenant,
      deleted: true,
      deletedAt: meta.deleted_at,
    };
  }
  const last = db.select().from(receipts).orderBy(desc(receipts.through)).limit(1).get();
  return {
    version: 1,
    sessionID: meta.session_id,
    tenant,
    deleted: false,
    creatorID: meta.creator_id,
    sourceID: meta.source_id,
    position: meta.position,
    revision: meta.revision,
    batches: meta.batches,
    lastReceipt: last ? toReceipt(meta.session_id, last) : null,
    usage: {
      entities: meta.entity_count,
      inlineBytes: meta.inline_bytes,
      blobBytes: meta.blob_bytes,
    },
    createdAt: meta.created_at,
    updatedAt: meta.updated_at,
  };
}

/**
 * Binds the session to its creator and source. A repeated registration by the
 * same creator and source is a no-op; it never replaces an existing binding.
 */
export function register(
  db: Db,
  principal: Principal,
  sessionID: string,
  sourceID: string,
  now: number
): { created: boolean; state: SessionState } {
  const existing = load(db);
  if (existing) {
    const meta = visible(db, principal, sessionID);
    if (meta.deleted_at !== null) {
      raise('session_deleted', 'A deleted session cannot be registered again');
    }
    requireCreator(meta, principal);
    if (meta.source_id !== sourceID) {
      raise('source_conflict', 'The session is bound to another source');
    }
    return { created: false, state: toState(db, meta) };
  }
  const row = {
    key: KEY,
    session_id: sessionID,
    tenant_type: principal.tenant.type,
    tenant_id: principal.tenant.id,
    creator_id: principal.userID,
    source_id: sourceID,
    position: 0,
    revision: 0,
    batches: 0,
    entity_count: 0,
    inline_bytes: 0,
    blob_bytes: 0,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  db.insert(session).values(row).run();
  return { created: true, state: toState(db, row) };
}

/** Updates counters and position. The binding columns are immutable after registration. */
export function update(
  db: Db,
  values: Partial<
    Omit<Meta, 'key' | 'session_id' | 'tenant_type' | 'tenant_id' | 'creator_id' | 'source_id'>
  >
): void {
  db.update(session).set(values).where(eq(session.key, KEY)).run();
}
