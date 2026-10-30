import { eq, isNotNull } from 'drizzle-orm';

import { blobs, entities, receipts } from '../../db/sqlite-schema';
import type { Principal, SessionState } from '../../protocol';
import { raise, toState, update, visible, type Db, type Meta } from './session';
import { SWEEP_MARGIN_MS } from './blob';

/**
 * Records the permanent tombstone and removes portable content. Ready blob
 * rows become immediate cleanup claims; unfinished attempts keep their deadline.
 * Only completed R2 cleanup removes blob rows. Repeated deletion is idempotent.
 */
export function tombstone(
  db: Db,
  principal: Principal,
  sessionID: string,
  now: number
): { state: SessionState; meta: Meta; created: boolean } {
  const meta = visible(db, principal, sessionID);
  if (meta.deleted_at !== null) return { state: toState(db, meta), meta, created: false };
  if (meta.creator_id !== principal.userID) {
    raise('creator_mismatch', 'Only the session creator can delete this session');
  }

  // Primary key columns are never null, so these predicates select every row.
  db.delete(entities).where(isNotNull(entities.kind)).run();
  db.delete(receipts).where(isNotNull(receipts.batch_id)).run();
  // Preserve every physical key until cleanup completes. A committed upload
  // has finished its PUT, so its object is eligible for immediate cleanup.
  db.update(blobs)
    .set({ state: 'cleaning', deadline: now - SWEEP_MARGIN_MS })
    .where(eq(blobs.state, 'ready'))
    .run();
  update(db, {
    entity_count: 0,
    inline_bytes: 0,
    blob_bytes: 0,
    updated_at: now,
    deleted_at: now,
  });

  const deleted = { ...meta, deleted_at: now };
  return { state: toState(db, deleted), meta: deleted, created: true };
}
