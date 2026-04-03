import { query } from '../../util/query.util';
import {
  wasteland_wanted_cache,
  WantedCacheRecord,
} from '../../db/tables/wanted-cache.table';

/** Item shape from DoltHub that gets cached locally. */
export type WantedItem = {
  item_id: string;
  title: string;
  description: string | null;
  bounty: number | null;
  status: string;
  claimed_by: string | null;
  claim_id: string | null;
  evidence: string | null;
  created_at: string | null;
  updated_at: string | null;
};

/** Upsert items into the wanted cache. Replaces existing rows by item_id. */
export function cacheWantedItems(sql: SqlStorage, items: WantedItem[]): void {
  const now = new Date().toISOString();
  for (const item of items) {
    query(
      sql,
      /* sql */ `
        INSERT OR REPLACE INTO ${wasteland_wanted_cache} (
          ${wasteland_wanted_cache.columns.item_id},
          ${wasteland_wanted_cache.columns.title},
          ${wasteland_wanted_cache.columns.description},
          ${wasteland_wanted_cache.columns.bounty},
          ${wasteland_wanted_cache.columns.status},
          ${wasteland_wanted_cache.columns.claimed_by},
          ${wasteland_wanted_cache.columns.claim_id},
          ${wasteland_wanted_cache.columns.evidence},
          ${wasteland_wanted_cache.columns.created_at},
          ${wasteland_wanted_cache.columns.updated_at},
          ${wasteland_wanted_cache.columns.cached_at}
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        item.item_id,
        item.title,
        item.description,
        item.bounty,
        item.status,
        item.claimed_by,
        item.claim_id,
        item.evidence,
        item.created_at,
        item.updated_at,
        now,
      ]
    );
  }
}

/** Read all cached wanted items, ordered by created_at descending. */
export function getCachedWantedItems(sql: SqlStorage): WantedCacheRecord[] {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${wasteland_wanted_cache}
        ORDER BY ${wasteland_wanted_cache.created_at} DESC
      `,
      []
    ),
  ];
  return WantedCacheRecord.array().parse(rows);
}

/** Read a single cached wanted item by item_id. */
export function getCachedWantedItem(
  sql: SqlStorage,
  itemId: string
): WantedCacheRecord | null {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${wasteland_wanted_cache}
        WHERE ${wasteland_wanted_cache.item_id} = ?
      `,
      [itemId]
    ),
  ];
  if (rows.length === 0) return null;
  return WantedCacheRecord.parse(rows[0]);
}

/** Clear all cached wanted items. */
export function clearCache(sql: SqlStorage): void {
  query(sql, /* sql */ `DELETE FROM ${wasteland_wanted_cache}`, []);
}
