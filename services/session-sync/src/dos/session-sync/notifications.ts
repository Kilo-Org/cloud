import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { entities, sessionStatus } from '../../db/sqlite-schema';
import type { SessionNotification } from '../../notifications/protocol';
import type { statusRequestSchema, Principal, SessionStatus } from '../../protocol';
import { KEY, load, raise, readStatus, update, writable, type Db } from './session';

export function setStatus(
  db: Db,
  principal: Principal,
  sessionID: string,
  request: z.infer<typeof statusRequestSchema>,
  now: number
): { status: SessionStatus; notification?: SessionNotification } {
  const meta = writable(db, principal, sessionID);
  if (meta.source_id !== request.sourceID)
    raise('source_conflict', 'The session source does not match');
  const previous = readStatus(db);
  const version = previous?.version ?? 0;
  // A lost response can retry the same transition, but an older transition cannot replace a newer one.
  if (previous && request.after === version - 1 && request.status === previous.value) {
    return { status: previous };
  }
  if (request.after !== version) {
    raise('position_conflict', 'The session status version changed', { version });
  }
  if (previous?.value === request.status) return { status: previous };
  const status = { value: request.status, version: version + 1, updatedAt: now };
  db.insert(sessionStatus)
    .values({ key: KEY, value: status.value, version: status.version, updated_at: now })
    .onConflictDoUpdate({
      target: sessionStatus.key,
      set: {
        value: status.value,
        version: status.version,
        updated_at: now,
      },
    })
    .run();
  update(db, { updated_at: now, last_write_at: now });
  return { status, notification: snapshot(db, 'session.status.updated', now) };
}

const titleSchema = z.object({ title: z.string().nullable().optional() });

export function snapshot(
  db: Db,
  type: SessionNotification['type'],
  changedAt: number
): SessionNotification {
  const meta = load(db);
  if (!meta) throw new Error('Notification requires a stored session');
  const entity = db
    .select({ value: entities.value })
    .from(entities)
    .where(and(eq(entities.kind, 'session'), eq(entities.id, meta.session_id)))
    .get();
  let title: string | null | undefined = meta.deleted_at === null ? undefined : null;
  if (entity?.value !== null && entity?.value !== undefined) {
    const parsed = titleSchema.safeParse(JSON.parse(entity.value));
    if (parsed.success)
      title = parsed.data.title?.slice(0, 1024).replace(/[\uD800-\uDBFF]$/, '') ?? null;
  }
  return {
    version: 1,
    type,
    session: {
      sessionID: meta.session_id,
      tenant: { type: meta.tenant_type, id: meta.tenant_id },
      revision: meta.revision,
      position: meta.position,
      ...(title === undefined ? {} : { title }),
      status: meta.deleted_at === null ? readStatus(db) : null,
      createdAt: meta.created_at,
      updatedAt: meta.updated_at,
      deletedAt: meta.deleted_at,
    },
    changedAt,
  };
}
