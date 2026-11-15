import { inArray, isNotNull } from 'drizzle-orm';

import { blobs, entities, receipts, sessionStatus } from '../../db/sqlite-schema';
import type { SessionNotification } from '../../notifications/protocol';
import type { Principal, SessionState } from '../../protocol';
import { toState, update, visible, type Db, type Meta } from './session';
import { SWEEP_MARGIN_MS } from './blob';
import { snapshot } from './notifications';

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
): { state: SessionState; meta: Meta; created: boolean; notification?: SessionNotification } {
  const meta = visible(db, principal, sessionID);
  if (meta.deleted_at !== null) return { state: toState(db, meta), meta, created: false };

  // Primary key columns are never null, so these predicates select every row.
  db.delete(entities).where(isNotNull(entities.kind)).run();
  db.delete(receipts).where(isNotNull(receipts.batch_id)).run();
  db.delete(sessionStatus).where(isNotNull(sessionStatus.key)).run();
  // Preserve every physical key until cleanup completes. A committed upload
  // has finished its PUT, so its object is eligible for immediate cleanup.
  db.update(blobs)
    .set({ state: 'cleaning', deadline: now - SWEEP_MARGIN_MS })
    .where(inArray(blobs.state, ['ready', 'unreferenced']))
    .run();
  update(db, {
    entity_count: 0,
    inline_bytes: 0,
    blob_bytes: 0,
    updated_at: now,
    deleted_at: now,
  });

  const deleted = { ...meta, deleted_at: now };
  return {
    state: toState(db, deleted),
    meta: deleted,
    created: true,
    notification: snapshot(db, 'session.deleted', now),
  };
}
