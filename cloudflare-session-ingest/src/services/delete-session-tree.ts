import { sql, eq, and } from 'drizzle-orm';
import { cli_sessions_v2 } from '@kilocode/db/schema';
import type { getWorkerDb } from '@kilocode/db/client';

/**
 * Recursively deletes a session and all its descendants (children-first)
 * to respect the RESTRICT FK on parent_session_id.
 *
 * Returns the ordered list of deleted session IDs (deepest children first).
 */
export async function deleteSessionTree(
  db: ReturnType<typeof getWorkerDb>,
  sessionId: string,
  kiloUserId: string
): Promise<string[]> {
  const treeResult = await db.execute<{ session_id: string }>(sql`
    WITH RECURSIVE tree AS (
      SELECT session_id, parent_session_id, kilo_user_id, 0 AS depth, ARRAY[session_id] AS path
      FROM ${cli_sessions_v2}
      WHERE session_id = ${sessionId} AND kilo_user_id = ${kiloUserId}
      UNION ALL
      SELECT c.session_id, c.parent_session_id, c.kilo_user_id, t.depth + 1, t.path || c.session_id
      FROM ${cli_sessions_v2} c
      INNER JOIN tree t ON c.parent_session_id = t.session_id AND c.kilo_user_id = t.kilo_user_id
      WHERE NOT (c.session_id = ANY(t.path)) AND t.depth < 10
    )
    SELECT session_id FROM tree ORDER BY depth DESC
  `);

  const treeRows = treeResult.rows;
  const orderedSessionIds = treeRows.length > 0 ? treeRows.map(r => r.session_id) : [sessionId];

  await db.transaction(async tx => {
    for (const id of orderedSessionIds) {
      await tx
        .delete(cli_sessions_v2)
        .where(
          and(eq(cli_sessions_v2.session_id, id), eq(cli_sessions_v2.kilo_user_id, kiloUserId))
        );
    }
  });

  return orderedSessionIds;
}
