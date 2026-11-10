import { asc, and, eq } from 'drizzle-orm';

import { blobs, entities, receipts } from '../../db/sqlite-schema';
import { LIMITS, utf8Bytes, type BatchRequest, type Principal, type Receipt } from '../../protocol';
import { raise, toReceipt, update, writable, type Db, type ReceiptRow } from './session';
type BatchWork = { pruneMs: number; pruneAttempts: number; pruneError?: unknown };

/**
 * Applies one batch, records its receipt, and advances the source position.
 * Call inside a storage transaction: any failure must roll back every write.
 * `digest` is the SHA-256 of the exact request body, so a retry must repeat the
 * packet byte for byte.
 *
 * A retry of a recorded batch returns its receipt unchanged. Once a receipt
 * leaves the bounded tail, the committed position already covers the batch,
 * so the predecessor check refuses it instead of applying it again.
 */
export function apply(
  db: Db,
  principal: Principal,
  sessionID: string,
  batch: BatchRequest,
  digest: string,
  now: number,
  work?: BatchWork
): Receipt {
  const meta = writable(db, principal, sessionID);
  if (meta.source_id !== batch.sourceID) {
    raise('source_conflict', 'The session is bound to another source');
  }

  const prior = db.select().from(receipts).where(eq(receipts.batch_id, batch.batchID)).get();
  if (prior) {
    if (prior.digest !== digest) {
      raise('batch_conflict', 'The batch ID was already committed with different content');
    }
    return toReceipt(sessionID, prior);
  }

  if (batch.after !== meta.position) {
    if (batch.through <= meta.position) {
      raise('batch_superseded', 'The committed position already covers this batch', {
        position: meta.position,
      });
    }
    raise('position_conflict', '`after` does not match the committed position', {
      position: meta.position,
    });
  }

  const revision = meta.revision + 1;
  let entityCount = meta.entity_count;
  let inlineBytes = meta.inline_bytes;
  const touched = new Set<string>();

  for (const change of batch.changes) {
    const key = and(eq(entities.kind, change.kind), eq(entities.id, change.id));
    const prev = db
      .select({ inline: entities.inline_bytes, hash: entities.blob_hash })
      .from(entities)
      .where(key)
      .get();
    if (prev?.hash) touched.add(prev.hash);

    if (change.op === 'remove') {
      if (!prev) continue;
      db.delete(entities).where(key).run();
      entityCount -= 1;
      inlineBytes -= prev.inline;
      continue;
    }

    let row: Pick<
      typeof entities.$inferInsert,
      'value' | 'blob_hash' | 'blob_bytes' | 'inline_bytes'
    >;
    if ('blob' in change) {
      const blob = db.select().from(blobs).where(eq(blobs.hash, change.blob.hash)).get();
      if (!blob || (blob.state !== 'ready' && blob.state !== 'unreferenced')) {
        raise('blob_missing', 'Upload the blob before referencing it', { hash: change.blob.hash });
      }
      if (blob.bytes !== change.blob.bytes) {
        raise('invalid_request', 'The blob size does not match the stored blob', {
          hash: change.blob.hash,
          bytes: blob.bytes,
        });
      }
      row = { value: null, blob_hash: blob.hash, blob_bytes: blob.bytes, inline_bytes: 0 };
      touched.add(blob.hash);
    } else {
      const value = JSON.stringify(change.value);
      row = { value, blob_hash: null, blob_bytes: null, inline_bytes: utf8Bytes(value) };
    }

    db.insert(entities)
      .values({ kind: change.kind, id: change.id, revision, ...row })
      .onConflictDoUpdate({ target: [entities.kind, entities.id], set: { revision, ...row } })
      .run();
    if (!prev) entityCount += 1;
    inlineBytes += row.inline_bytes - (prev?.inline ?? 0);
  }

  if (entityCount > LIMITS.sessionEntities || inlineBytes > LIMITS.sessionInlineBytes) {
    raise('storage_budget_exceeded', 'The batch exceeds the session storage budget', {
      entities: LIMITS.sessionEntities,
      inlineBytes: LIMITS.sessionInlineBytes,
    });
  }
  for (const hash of touched) {
    const referenced = db
      .select({ id: entities.id })
      .from(entities)
      .where(eq(entities.blob_hash, hash))
      .limit(1)
      .get();
    db.update(blobs)
      .set({
        state: referenced ? 'ready' : 'unreferenced',
        deadline: now,
      })
      .where(eq(blobs.hash, hash))
      .run();
  }

  update(db, {
    position: batch.through,
    revision,
    batches: meta.batches + 1,
    entity_count: entityCount,
    inline_bytes: inlineBytes,
    updated_at: now,
    last_write_at: now,
  });

  const receipt: ReceiptRow = {
    batch_id: batch.batchID,
    digest,
    after: batch.after,
    through: batch.through,
    revision,
    changes: batch.changes.length,
    committed_at: now,
  };
  db.insert(receipts).values(receipt).run();
  prune(db, meta.batches + 1, work);
  return toReceipt(sessionID, receipt);
}

/** One accepted batch inserts one receipt; positions strictly order that tail. */
function prune(db: Db, accepted: number, work?: BatchWork): void {
  if (accepted <= LIMITS.receipts) return;
  const started = work ? performance.now() : 0;
  if (work) work.pruneAttempts++;
  try {
    const oldest = db
      .select({ through: receipts.through })
      .from(receipts)
      .orderBy(asc(receipts.through))
      .limit(1)
      .get();
    if (oldest) db.delete(receipts).where(eq(receipts.through, oldest.through)).run();
  } catch (error) {
    if (work) work.pruneError = error;
    throw error;
  } finally {
    if (work) work.pruneMs += performance.now() - started;
  }
}
