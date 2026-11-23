import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { entities, sessionStatus } from '../../db/sqlite-schema';
import type { SessionNotification } from '../../notifications/protocol';
import type {
  statusRequestSchema,
  Principal,
  SessionListMetadata,
  SessionStatus,
} from '../../protocol';
import {
  KEY,
  isJoined,
  load,
  raise,
  readStatus,
  update,
  writable,
  type Db,
  type Meta,
} from './session';

export function setStatus(
  db: Db,
  principal: Principal,
  sessionID: string,
  request: z.infer<typeof statusRequestSchema>,
  now: number
): { status: SessionStatus; notification?: SessionNotification } {
  const meta = writable(db, principal, sessionID);
  if (!isJoined(db, meta, request.sourceID))
    raise('source_conflict', 'The session source is not registered');
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
  return {
    status,
    notification: snapshot(
      db,
      'session.status.updated',
      now,
      { ...meta, updated_at: now, last_write_at: now },
      status
    ),
  };
}

/** Case- and accent-insensitive form used by the list's title search. */
export function foldTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function cleanTitle(title: string): string {
  return title.slice(0, 1024).replace(/[\uD800-\uDBFF]$/, '');
}

const titleSchema = z.object({ title: z.string().nullable().optional() });

const listMetadataSchema = z.looseObject({
  title: z.string().nullable().optional().catch(undefined),
  origin: z
    .looseObject({ directory: z.string().optional().catch(undefined) })
    .optional()
    .catch(undefined),
  time: z
    .looseObject({
      updated: z.number().finite().nonnegative().optional().catch(undefined),
      archived: z.unknown().optional(),
    })
    .optional()
    .catch(undefined),
});

/**
 * Extracts creator-index metadata from a `session` entity value. A field that
 * does not parse is left out so the indexed value stays; `updatedAt` always
 * resolves, to the batch commit time when `time.updated` is unusable.
 */
export function listMetadata(value: unknown, committedAt: number): SessionListMetadata {
  const parsed = listMetadataSchema.safeParse(value);
  if (!parsed.success) return { updatedAt: committedAt };
  const { title, origin, time } = parsed.data;
  return {
    ...(title !== undefined ? { title: title === null ? null : cleanTitle(title) } : {}),
    ...(origin?.directory !== undefined
      ? { directory: origin.directory === '' ? null : origin.directory }
      : {}),
    updatedAt:
      time?.updated !== undefined && Number.isSafeInteger(Math.trunc(time.updated))
        ? Math.trunc(time.updated)
        : committedAt,
    ...(time !== undefined
      ? { archived: time.archived !== undefined && time.archived !== null }
      : {}),
  };
}

export function snapshot(
  db: Db,
  type: SessionNotification['type'],
  changedAt: number,
  meta: Meta | undefined = load(db),
  status: SessionStatus | null = meta?.deleted_at === null ? readStatus(db) : null
): SessionNotification {
  if (!meta) throw new Error('Notification requires a stored session');
  const entity = db
    .select({ value: entities.value })
    .from(entities)
    .where(and(eq(entities.kind, 'session'), eq(entities.id, meta.session_id)))
    .get();
  let title: string | null | undefined = meta.deleted_at === null ? undefined : null;
  if (entity?.value !== null && entity?.value !== undefined) {
    const parsed = titleSchema.safeParse(JSON.parse(entity.value));
    if (parsed.success) title = parsed.data.title == null ? null : cleanTitle(parsed.data.title);
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
      status,
      createdAt: meta.created_at,
      updatedAt: meta.updated_at,
      deletedAt: meta.deleted_at,
    },
    changedAt,
  };
}
