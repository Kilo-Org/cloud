import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';
import { query } from '../../util/query.util';

// ── Schema & Table ──────────────────────────────────────────────────────

export const WantedItemRecord = z.object({
  item_id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  bounty: z.number().int().nullable(),
  status: z.string().nullable(),
  claimed_by: z.string().nullable(),
  claim_id: z.string().nullable(),
  evidence: z.string().nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
  cached_at: z.string(),
});

export type WantedItemRecord = z.output<typeof WantedItemRecord>;

export const wasteland_wanted_cache = getTableFromZodSchema(
  'wasteland_wanted_cache',
  WantedItemRecord
);

export function createTableWastelandWantedCache(): string {
  return getCreateTableQueryFromTable(wasteland_wanted_cache, {
    item_id: `TEXT PRIMARY KEY`,
    title: `TEXT NOT NULL`,
    description: `TEXT`,
    bounty: `INTEGER`,
    status: `TEXT`,
    claimed_by: `TEXT`,
    claim_id: `TEXT`,
    evidence: `TEXT`,
    created_at: `TEXT`,
    updated_at: `TEXT`,
    cached_at: `TEXT NOT NULL DEFAULT (datetime('now'))`,
  });
}

// ── Operations ──────────────────────────────────────────────────────────

/**
 * Upsert wanted items into the cache. Uses INSERT OR REPLACE to handle
 * both new items and updates to existing ones.
 */
export function cacheWantedItems(sql: SqlStorage, items: WantedItem[]): void {
  const timestamp = new Date().toISOString();
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
        item.description ?? null,
        item.bounty ?? null,
        item.status ?? null,
        item.claimed_by ?? null,
        item.claim_id ?? null,
        item.evidence ?? null,
        item.created_at ?? null,
        item.updated_at ?? null,
        timestamp,
      ]
    );
  }
}

/** Read all cached wanted items, ordered by created_at descending. */
export function getCachedWantedItems(sql: SqlStorage): WantedItemRecord[] {
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
  return WantedItemRecord.array().parse(rows);
}

/** Read a single cached wanted item by ID. */
export function getCachedWantedItem(
  sql: SqlStorage,
  itemId: string
): WantedItemRecord | null {
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
  return WantedItemRecord.parse(rows[0]);
}

/** Delete all cached wanted items. */
export function clearCache(sql: SqlStorage): void {
  query(
    sql,
    /* sql */ `DELETE FROM ${wasteland_wanted_cache}`,
    []
  );
}

// ── Public types ────────────────────────────────────────────────────────

/** Input shape from DoltHub API (before caching). */
export type WantedItem = {
  item_id: string;
  title: string;
  description?: string | null;
  bounty?: number | null;
  status?: string | null;
  claimed_by?: string | null;
  claim_id?: string | null;
  evidence?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};
