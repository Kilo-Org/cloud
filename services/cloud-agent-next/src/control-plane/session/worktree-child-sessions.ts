import type { CloudAgentChildSessionLineage } from '@kilocode/session-ingest-contracts';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { events } from '../../db/sqlite-schema.js';
import { childSessionLineage } from '../../sandbox-session/control-plane-ingest.js';

/**
 * Child Kilo sessions discovered in one session's event log for a worktree
 * directory (legacy `getWorktreeChildSessions`). Reads the shared `events` table
 * the V2 Session DO already stores; the session's own Kilo session is excluded.
 * A child whose stored lineage disagrees with itself is a conflict, not a
 * silently dropped row.
 */
export function readWorktreeChildSessions(input: {
  db: DrizzleSqliteDODatabase;
  sessionId: string;
  ownKiloSessionId: string;
  directory: string;
}): CloudAgentChildSessionLineage[] {
  const rows = input.db
    .select({
      id: sql<unknown>`json_extract(${events.payload}, '$.properties.info.id')`,
      parentID: sql<unknown>`json_extract(${events.payload}, '$.properties.info.parentID')`,
      directory: sql<unknown>`json_extract(${events.payload}, '$.properties.info.directory')`,
    })
    .from(events)
    .where(
      and(
        eq(events.session_id, input.sessionId),
        eq(events.stream_event_type, 'kilocode'),
        inArray(sql<string>`json_extract(${events.payload}, '$.type')`, [
          'session.created',
          'session.updated',
        ])
      )
    )
    .orderBy(events.id)
    .all();
  const children = new Map<string, CloudAgentChildSessionLineage>();
  for (const row of rows) {
    const child = childSessionLineage(row, input.directory);
    if (!child || child.sessionId === input.ownKiloSessionId) continue;
    const existing = children.get(child.sessionId);
    if (existing && existing.parentSessionId !== child.parentSessionId) {
      throw new Error('worktree_child_lineage_conflict');
    }
    children.set(child.sessionId, child);
  }
  return [...children.values()];
}
