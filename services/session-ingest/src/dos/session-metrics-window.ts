import { and, desc, inArray, lt, ne, sql } from 'drizzle-orm';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';

import { ingestItems } from '../db/sqlite-schema';

/**
 * Fixed read budget for the close-path metrics scan: at most the newest stored rows that fit
 * within the row and byte ceilings, so one emission costs a bounded amount of Durable Object
 * time and memory while the running cost total keeps the cost figure exact for any session
 * length.
 */
export const SESSION_METRICS_WINDOW_MAX_ROWS = 2000;
export const SESSION_METRICS_WINDOW_MAX_BYTES = 8 * 1024 * 1024;
/**
 * A body larger than this contributes nothing to the counted figures, and its row still counts
 * toward the row ceiling.
 */
export const SESSION_METRICS_WINDOW_MAX_ROW_BYTES = 1024 * 1024;
const SESSION_METRICS_WINDOW_BATCH_ROWS = 16;

/**
 * The single-row items that carry the metrics anchors: the session time window and the platform
 * and organization identity. The scan reads them by their unique item id, so a read that covers
 * only part of a session still reports them.
 */
const ANCHOR_ITEM_IDS = ['session', 'kilo_meta'] as const;

/**
 * The item types the aggregation counts: `computeSessionMetrics` derives every figure from
 * `message` and `part` rows.
 */
const COUNTED_ITEM_TYPES = ['message', 'part'] as const;

export type SessionMetricsWindowRow = { item_type: string; item_data: string };

export type SessionMetricsWindow = {
  /** Stored rows the aggregation reads, oldest first. */
  rows: SessionMetricsWindowRow[];
  /** Stored rows the scan visited. Zero means the session holds no item row to describe. */
  rowCount: number;
  /**
   * True when the read left stored rows out of the counted figures: it stopped at a ceiling,
   * or it never lifted a body the projection excludes. The counted figures then describe part
   * of the session only.
   */
  bounded: boolean;
};

type ScannedRow = {
  id: number;
  item_id: string;
  item_type: string;
  item_data: string;
};

/**
 * The scan projects a body to the empty string when it is R2-offloaded or larger than
 * `SESSION_METRICS_WINDOW_MAX_ROW_BYTES`; the isolate never receives such a body whole.
 */
function windowColumns() {
  return {
    id: ingestItems.id,
    item_id: ingestItems.item_id,
    item_type: ingestItems.item_type,
    item_data: sql<string>`CASE
      WHEN ${ingestItems.item_data_r2_key} IS NOT NULL
        OR length(CAST(${ingestItems.item_data} AS BLOB)) > ${SESSION_METRICS_WINDOW_MAX_ROW_BYTES} THEN ''
      ELSE ${ingestItems.item_data}
    END`,
  };
}

export function readSessionMetricsWindow(db: DrizzleSqliteDODatabase): SessionMetricsWindow {
  const encoder = new TextEncoder();
  const rows: ScannedRow[] = [];
  const seenItemIds = new Set<string>();
  let consumedBytes = 0;
  let rowsRead = 0;
  let droppedBody = false;
  let lastRowId: number | null = null;
  let stoppedForBudget = false;

  while (rowsRead < SESSION_METRICS_WINDOW_MAX_ROWS) {
    const limit = Math.min(
      SESSION_METRICS_WINDOW_BATCH_ROWS,
      SESSION_METRICS_WINDOW_MAX_ROWS - rowsRead
    );
    const page = db
      .select(windowColumns())
      .from(ingestItems)
      .where(
        and(
          ne(ingestItems.item_type, 'session_diff'),
          lastRowId === null ? undefined : lt(ingestItems.id, lastRowId)
        )
      )
      .orderBy(desc(ingestItems.id))
      .limit(limit)
      .all();
    if (page.length === 0) break;
    lastRowId = page[page.length - 1].id;

    for (const row of page) {
      rowsRead += 1;
      seenItemIds.add(row.item_id);
      // A body the projection blanked, or one that needs more bytes than the scan has left,
      // contributes nothing. It still consumed a row of the ceiling.
      if (row.item_data === '') {
        droppedBody = true;
        continue;
      }
      const rowBytes = encoder.encode(row.item_data).byteLength;
      if (rowBytes > SESSION_METRICS_WINDOW_MAX_ROW_BYTES) {
        droppedBody = true;
        continue;
      }
      if (consumedBytes + rowBytes > SESSION_METRICS_WINDOW_MAX_BYTES) {
        stoppedForBudget = true;
        break;
      }
      consumedBytes += rowBytes;
      rows.push(row);
    }
    if (stoppedForBudget) break;
    if (page.length < limit) break;
  }

  // A read leaves stored rows out of the counted figures when a ceiling stopped it with older
  // rows left behind, or when a body was projected away: the figures then describe part of the
  // session only, and the caller treats them as partial.
  const rowsBeyondCeiling =
    rowsRead >= SESSION_METRICS_WINDOW_MAX_ROWS &&
    lastRowId !== null &&
    hasOlderCountedRow(db, lastRowId);
  const bounded = stoppedForBudget || droppedBody || rowsBeyondCeiling;
  // The anchors sit at their original row ids, so a long session pushes them below the read's
  // window; reading them by item id keeps the session duration, platform and organization in
  // the record whatever the read covered. Rows the read counted are deduplicated by item id.
  for (const row of readAnchorRows(db, seenItemIds)) rows.push(row);

  rows.sort((left, right) => left.id - right.id);
  return {
    rows: rows.map(row => ({ item_type: row.item_type, item_data: row.item_data })),
    rowCount: rowsRead,
    bounded,
  };
}

/**
 * Whether a stored row the aggregation counts (`message` or `part`) still sits below the read's
 * cursor. Single-row metadata items (`session`, `kilo_meta`, `model`, lifecycle and status
 * items) are not counted figures: the scan reads them by their unique item id, so their age
 * never makes a read partial.
 */
function hasOlderCountedRow(db: DrizzleSqliteDODatabase, id: number): boolean {
  const row = db
    .select({ id: ingestItems.id })
    .from(ingestItems)
    .where(and(inArray(ingestItems.item_type, COUNTED_ITEM_TYPES), lt(ingestItems.id, id)))
    .limit(1)
    .get();
  return row !== undefined;
}

function readAnchorRows(db: DrizzleSqliteDODatabase, seenItemIds: Set<string>): ScannedRow[] {
  const rows = db
    .select(windowColumns())
    .from(ingestItems)
    .where(inArray(ingestItems.item_id, ANCHOR_ITEM_IDS))
    .all();
  return rows.filter(row => !seenItemIds.has(row.item_id) && row.item_data !== '');
}
