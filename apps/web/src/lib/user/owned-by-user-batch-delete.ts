import { sql } from 'drizzle-orm';
import type { DrizzleTransaction } from '@/lib/drizzle';

export const OWNED_BY_USER_DELETE_PAGE_SIZE = 200;

export const OWNED_BY_USER_DELETE_TABLES = ['webhook_events', 'cloud_agent_code_reviews'] as const;

export type OwnedByUserDeleteTable = (typeof OWNED_BY_USER_DELETE_TABLES)[number];

function tableSql(table: OwnedByUserDeleteTable) {
  switch (table) {
    case 'webhook_events':
      return sql.raw('webhook_events');
    case 'cloud_agent_code_reviews':
      return sql.raw('cloud_agent_code_reviews');
  }
}

export async function deleteOwnedByUserIdPage(
  tx: DrizzleTransaction,
  table: OwnedByUserDeleteTable,
  userId: string,
  limit: number
): Promise<number> {
  const result = await tx.execute<{ id: string }>(sql`
    DELETE FROM ${tableSql(table)}
    WHERE id IN (
      SELECT id FROM ${tableSql(table)}
      WHERE owned_by_user_id = ${userId}
      LIMIT ${sql.raw(String(limit))}
    )
    RETURNING id
  `);
  return result.rows.length;
}

export async function deleteAllOwnedByUserIdPages(
  tx: DrizzleTransaction,
  table: OwnedByUserDeleteTable,
  userId: string,
  limit: number
): Promise<void> {
  while ((await deleteOwnedByUserIdPage(tx, table, userId, limit)) > 0) {
    // Drain remaining rows one page at a time so each statement stays bounded.
  }
}
