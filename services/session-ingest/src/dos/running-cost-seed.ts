import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';

import { ingestItems } from '../db/sqlite-schema';
import { clampAssistantCostUsd, storedMessageCostUsd } from './session-metrics';

/**
 * Bounded read of a session's stored running cost: at most this many message rows per batch,
 * and at most this many bytes of pre-column bodies per batch. The seed sums the same
 * contributions a recomputation over the stored rows yields, one batch at a time, so a long
 * transcript costs the ingest request a bounded amount of Durable Object time and memory.
 */
export const RUNNING_COST_SEED_BATCH_ROWS = 16;
export const RUNNING_COST_SEED_BATCH_BYTES = 4 * 1024 * 1024;

type SeedRow = { id: number; cost_usd: number | null; body_bytes: number };

/**
 * A batch step reads each row's stored contribution and the size of the body a row without one
 * would need; the body itself arrives in a second read that the byte ceiling sizes. A stored
 * contribution carries no body, so its size reads as zero.
 */
function seedPageColumns() {
  return {
    id: ingestItems.id,
    cost_usd: ingestItems.cost_usd,
    body_bytes: sql<number>`CASE
      WHEN ${ingestItems.cost_usd} IS NULL
        THEN length(CAST(${ingestItems.item_data} AS BLOB))
      ELSE 0
    END`,
  };
}

/**
 * The session's assistant cost summed over its inline message rows, read in row-id order in
 * bounded batches. Every row is summed exactly once and in the same order, so the total equals
 * a single-pass recomputation of the stored rows.
 */
export function readStoredRunningAssistantCostUsd(db: DrizzleSqliteDODatabase): number {
  let total = 0;
  let cursor: number | null = null;
  for (;;) {
    const page = db
      .select(seedPageColumns())
      .from(ingestItems)
      .where(
        and(
          eq(ingestItems.item_type, 'message'),
          isNull(ingestItems.item_data_r2_key),
          cursor === null ? undefined : gt(ingestItems.id, cursor)
        )
      )
      .orderBy(asc(ingestItems.id))
      .limit(RUNNING_COST_SEED_BATCH_ROWS)
      .all();
    if (page.length === 0) break;

    const batch: SeedRow[] = [];
    let batchBodyBytes = 0;
    for (const row of page) {
      // The first row of a batch is always summed, so a body above the ceiling still belongs to
      // a batch of its own and the cursor always moves forward.
      if (
        batch.length > 0 &&
        row.cost_usd === null &&
        batchBodyBytes + row.body_bytes > RUNNING_COST_SEED_BATCH_BYTES
      ) {
        break;
      }
      if (row.cost_usd === null) batchBodyBytes += row.body_bytes;
      batch.push(row);
      cursor = row.id;
    }

    const bodies = new Map<number, string>();
    const bodyIds = batch.filter(row => row.cost_usd === null).map(row => row.id);
    if (bodyIds.length > 0) {
      const rows = db
        .select({ id: ingestItems.id, item_data: ingestItems.item_data })
        .from(ingestItems)
        .where(inArray(ingestItems.id, bodyIds))
        .all();
      for (const row of rows) bodies.set(row.id, row.item_data);
    }

    for (const row of batch) {
      total += clampAssistantCostUsd(
        storedMessageCostUsd({
          cost_usd: row.cost_usd,
          legacy_item_data: row.cost_usd === null ? (bodies.get(row.id) ?? null) : null,
          item_data_r2_key: null,
        })
      );
    }
    // A short batch with every row summed is the last page. A short batch the byte ceiling cut
    // ends is not: its remaining rows follow the cursor in the next batch.
    if (batch.length === page.length && page.length < RUNNING_COST_SEED_BATCH_ROWS) break;
  }
  return Math.max(0, total);
}
