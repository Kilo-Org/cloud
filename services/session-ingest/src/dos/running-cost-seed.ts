import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';

import { ingestItems } from '../db/sqlite-schema';
import { storedMessageCostUsd } from './session-metrics';

/**
 * Bounded read of a session's stored running cost: at most this many message rows, and this
 * many pre-column bodies, per batch. The seed sums the same contributions a full recomputation
 * over stored rows would, one batch at a time, so a long transcript costs the ingest request a
 * bounded amount of Durable Object time and memory instead of one read of every stored body.
 */
export const RUNNING_COST_SEED_BATCH_ROWS = 16;
export const RUNNING_COST_SEED_BATCH_BYTES = 4 * 1024 * 1024;

const encoder = new TextEncoder();

/**
 * The read needs `cost_usd` for every row and the body only for a row without a stored
 * contribution: the projection returns the body for a NULL `cost_usd` row and null otherwise,
 * so the isolate never receives a body the total does not read.
 */
function seedColumns() {
  return {
    id: ingestItems.id,
    cost_usd: ingestItems.cost_usd,
    legacy_item_data: sql<string | null>`CASE
      WHEN ${ingestItems.cost_usd} IS NULL THEN ${ingestItems.item_data}
    END`,
  };
}

/**
 * The session's assistant cost summed over its stored inline message rows, read in row-id order
 * in bounded batches. The total equals a single-pass recomputation of the same rows: every row
 * is summed exactly once and in the same order. A batch that already holds a body ends before
 * a body that would exceed its byte ceiling, and the next batch resumes after the last row it
 * summed.
 */
export function readStoredRunningAssistantCostUsd(db: DrizzleSqliteDODatabase): number {
  let total = 0;
  let cursor: number | null = null;
  for (;;) {
    const batch = db
      .select(seedColumns())
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
    if (batch.length === 0) break;

    let summed = 0;
    let summedBytes = 0;
    for (const row of batch) {
      const body = row.legacy_item_data;
      const bodyBytes = body === null ? 0 : encoder.encode(body).byteLength;
      // One oversized body still arrives in a batch of its own; a later body waits for the
      // next batch, which starts after the last row this one summed.
      if (summed > 0 && summedBytes + bodyBytes > RUNNING_COST_SEED_BATCH_BYTES) break;
      total += storedMessageCostUsd({
        cost_usd: row.cost_usd,
        legacy_item_data: body,
        item_data_r2_key: null,
      });
      summedBytes += bodyBytes;
      summed += 1;
      cursor = row.id;
    }
    // A short batch with every row summed is the last page. A short batch the byte ceiling cut
    // ends is not: its remaining rows follow the cursor in the next batch.
    if (summed === batch.length && batch.length < RUNNING_COST_SEED_BATCH_ROWS) break;
  }
  return Math.max(0, total);
}
