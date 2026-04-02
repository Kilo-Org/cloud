/**
 * Wanted board cache operations for WastelandDO.
 *
 * Stores DoltHub-sourced wanted board items in DO-local SQLite for
 * fast reads without polling DoltHub on every request.
 */
import { query } from '../../util/query.util';
import {
  createTableWantedCache,
  wasteland_wanted_cache,
  WantedCacheRecord,
} from '../../db/tables/wasteland-wanted-cache.table';

export type WantedItem = {
  item_id: string;
  title: string;
  description: string | null;
  bounty: number | null;
  status: 'open' | 'claimed' | 'done';
  priority: 'low' | 'medium' | 'high' | 'critical';
  type: 'feature' | 'bug' | 'docs' | 'other';
  claimed_by: string | null;
  claim_id: string | null;
  evidence: string | null;
  created_at: string | null;
  updated_at: string | null;
};

/** Create the wasteland_wanted_cache table if it doesn't exist. */
export function initWantedCacheTable(sql: SqlStorage): void {
  query(sql, createTableWantedCache(), []);
}

/** Upsert wanted items into the local SQLite cache. */
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
          ${wasteland_wanted_cache.columns.priority},
          ${wasteland_wanted_cache.columns.type},
          ${wasteland_wanted_cache.columns.claimed_by},
          ${wasteland_wanted_cache.columns.claim_id},
          ${wasteland_wanted_cache.columns.evidence},
          ${wasteland_wanted_cache.columns.created_at},
          ${wasteland_wanted_cache.columns.updated_at},
          ${wasteland_wanted_cache.columns.cached_at}
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        item.item_id,
        item.title,
        item.description,
        item.bounty,
        item.status,
        item.priority,
        item.type,
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

/** Read all cached wanted items, ordered by created_at DESC. */
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

/** Read a single cached wanted item by ID, or null if not found. */
export function getCachedWantedItem(sql: SqlStorage, itemId: string): WantedCacheRecord | null {
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
  const parsed = WantedCacheRecord.array().parse(rows);
  return parsed[0] ?? null;
}

/** Delete all rows from the wanted cache. */
export function clearCache(sql: SqlStorage): void {
  query(sql, /* sql */ `DELETE FROM ${wasteland_wanted_cache}`, []);
}
