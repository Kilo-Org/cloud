import { and, asc, sql } from 'drizzle-orm';

import { entities } from '../../db/sqlite-schema';
import {
  LIMITS,
  encodeCursor,
  jsonSchema,
  kindSchema,
  type Cursor,
  type Entity,
  type Page,
  type Principal,
} from '../../protocol';
import { live, raise, type Db } from './session';

type Row = typeof entities.$inferSelect;

function toEntity(row: Row): Entity {
  const kind = kindSchema.parse(row.kind);
  if (row.value !== null) {
    const value: unknown = JSON.parse(row.value);
    return { kind, id: row.id, revision: row.revision, value: jsonSchema.parse(value) };
  }
  if (row.blob_hash === null || row.blob_bytes === null) {
    throw new Error(`Stored entity ${row.kind}/${row.id} has neither a value nor a blob`);
  }
  return {
    kind,
    id: row.id,
    revision: row.revision,
    blob: { hash: row.blob_hash, bytes: row.blob_bytes },
  };
}

/**
 * Reads one page of current entities in (kind, id) order after `cursor`.
 * A reader that passes the revision of its first page gets `revision_changed`
 * instead of a page that mixes two revisions.
 */
export function read(
  db: Db,
  principal: Principal,
  sessionID: string,
  input: { cursor?: Cursor; limit: number; revision?: number }
): Page {
  const meta = live(db, principal, sessionID);
  if (input.revision !== undefined && input.revision !== meta.revision) {
    raise('revision_changed', 'The session changed after the first page; restart the read', {
      revision: meta.revision,
    });
  }

  const after = input.cursor;
  const rows = db
    .select({ kind: entities.kind, id: entities.id, inline_bytes: entities.inline_bytes })
    .from(entities)
    .where(
      after ? sql`(${entities.kind}, ${entities.id}) > (${after.kind}, ${after.id})` : undefined
    )
    .orderBy(asc(entities.kind), asc(entities.id))
    .limit(input.limit + 1)
    .all();

  const selected: typeof rows = [];
  let bytes = 0;
  for (const row of rows.slice(0, input.limit)) {
    if (selected.length > 0 && bytes + row.inline_bytes > LIMITS.pageBytes) break;
    bytes += row.inline_bytes;
    selected.push(row);
  }
  const end = selected.at(-1);
  const values = end
    ? db
        .select()
        .from(entities)
        .where(
          and(
            after
              ? sql`(${entities.kind}, ${entities.id}) > (${after.kind}, ${after.id})`
              : undefined,
            sql`(${entities.kind}, ${entities.id}) <= (${end.kind}, ${end.id})`
          )
        )
        .orderBy(asc(entities.kind), asc(entities.id))
        .all()
    : [];

  const last = selected.at(-1);
  return {
    version: 1,
    sessionID,
    revision: meta.revision,
    entities: values.map(toEntity),
    next:
      last && selected.length < rows.length
        ? encodeCursor({ kind: kindSchema.parse(last.kind), id: last.id })
        : null,
  };
}
