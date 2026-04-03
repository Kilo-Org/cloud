import { query } from '../../util/query.util';
import {
  wasteland_wanted_cache,
  WastelandWantedItemRecord,
} from '../../db/tables/wasteland-wanted-cache.table';

export function getWantedBoard(sql: SqlStorage): WastelandWantedItemRecord[] {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${wasteland_wanted_cache}
        ORDER BY ${wasteland_wanted_cache.updated_at} DESC
      `,
      []
    ),
  ];
  return WastelandWantedItemRecord.array().parse(rows);
}

/**
 * Replace the entire wanted board cache with fresh items.
 * Called after fetching from DoltHub upstream.
 */
export function replaceWantedBoard(
  sql: SqlStorage,
  items: WastelandWantedItemRecord[]
): void {
  query(sql, /* sql */ `DELETE FROM ${wasteland_wanted_cache}`, []);

  for (const item of items) {
    query(
      sql,
      /* sql */ `
        INSERT INTO ${wasteland_wanted_cache} (
          ${wasteland_wanted_cache.columns.item_id},
          ${wasteland_wanted_cache.columns.title},
          ${wasteland_wanted_cache.columns.description},
          ${wasteland_wanted_cache.columns.status},
          ${wasteland_wanted_cache.columns.priority},
          ${wasteland_wanted_cache.columns.type},
          ${wasteland_wanted_cache.columns.claimed_by},
          ${wasteland_wanted_cache.columns.evidence},
          ${wasteland_wanted_cache.columns.created_at},
          ${wasteland_wanted_cache.columns.updated_at}
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        item.item_id,
        item.title,
        item.description,
        item.status,
        item.priority,
        item.type,
        item.claimed_by,
        item.evidence,
        item.created_at,
        item.updated_at,
      ]
    );
  }
}
