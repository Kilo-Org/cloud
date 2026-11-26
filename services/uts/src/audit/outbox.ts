import { z } from 'zod';
import type { IdentityStore } from '../db/client';
import { AuditEventRowSchema } from '../db/rows';
import type { AuditOutbox, OutboxRead, ShardWatermark } from './relay';

/**
 * The relay's read for one shard: rows past the shard's watermark whose transaction is below the
 * oldest open transaction, in (`txid`, `id`) order, each with the watermark it was read against.
 * The watermark drives the inner query, so the row comparison is the index condition on every
 * partition's (`shard`, `txid`, `id`) index and the read never touches a relayed row
 * (`test/db/audit-maintenance.test.ts` checks the plan).
 *
 * A row whose transaction is below the horizon is final, and every row that commits later has a
 * transaction id at or above that horizon, so no later row can sort before a row this read
 * returned. A repeated read past the same watermark therefore starts with the same rows.
 */
export const RELAY_READ = `SELECT watermark.last_seq AS watermark_seq, event.*
  FROM uts.audit_relay_watermarks AS watermark
  CROSS JOIN LATERAL (
    SELECT candidate.*
    FROM uts.audit_events AS candidate
    WHERE candidate.shard = watermark.shard
      AND (candidate.txid, candidate.id) > (watermark.last_txid, watermark.last_id)
      AND candidate.txid < pg_snapshot_xmin(pg_current_snapshot())
    ORDER BY candidate.txid, candidate.id
    LIMIT $2
  ) AS event
  WHERE watermark.shard = $1
  ORDER BY event.txid, event.id`;

export const RelayReadRowSchema = AuditEventRowSchema.extend({ watermark_seq: z.bigint() });

/**
 * Moves one shard's watermark only from the sequence number the relay read it at, so a second
 * runner of the same shard (an overlapping deploy) can never move it back or skip a range.
 */
const ADVANCE_WATERMARK = `UPDATE uts.audit_relay_watermarks
  SET last_txid = $3::xid8, last_id = $4, last_seq = $5, updated_at = now()
  WHERE shard = $1 AND last_seq = $2
  RETURNING shard`;

/**
 * Each shard's first unrelayed row by (`txid`, `id`), committed or held back behind the horizon,
 * and its age. One index probe per shard, like the partition check. The first row in that order
 * is the one the relay waits for, so its age is how long the shard has been held up.
 */
const UNRELAYED_AGE = `SELECT watermark.shard,
    extract(epoch FROM now() - first_unrelayed.created_at)::float8 AS age_seconds
  FROM uts.audit_relay_watermarks AS watermark
  CROSS JOIN LATERAL (
    SELECT candidate.created_at
    FROM uts.audit_events AS candidate
    WHERE candidate.shard = watermark.shard
      AND (candidate.txid, candidate.id) > (watermark.last_txid, watermark.last_id)
    ORDER BY candidate.txid, candidate.id
    LIMIT 1
  ) AS first_unrelayed
  ORDER BY watermark.shard`;

const MAINTAIN_AUDIT_PARTITIONS =
  'SELECT action, partition_name FROM uts.maintain_audit_partitions()';

/** How many of the partitions for today and the next 7 UTC days exist. */
const PARTITION_RUNWAY = `SELECT count(*)::integer AS days
  FROM generate_series(0, 7) AS ahead
  WHERE to_regclass(format(
    'uts.%I',
    'audit_events_' || to_char((now() AT TIME ZONE 'UTC')::date + ahead, 'YYYYMMDD')
  )) IS NOT NULL`;

const MAINTAIN_OAUTH_ROWS = 'SELECT kind, deleted FROM uts.maintain_oauth_rows()';

const ShardAgeSchema = z.strictObject({
  shard: z.number().int().min(0).max(7),
  age_seconds: z.number(),
});
const PartitionStepSchema = z.strictObject({
  action: z.enum(['created', 'truncated', 'dropped', 'kept_unrelayed']),
  partition_name: z.string(),
});
const RunwaySchema = z.strictObject({ days: z.number().int() });
const OAuthStepSchema = z.strictObject({ kind: z.string(), deleted: z.number().int() });
const ShardRowSchema = z.strictObject({ shard: z.number().int() });

export type PartitionStep = z.output<typeof PartitionStepSchema>;
export type OAuthStep = z.output<typeof OAuthStepSchema>;
export type ShardAge = { shard: number; ageSeconds: number };

/** The relay's outbox port over the identity store; one statement per call. */
export function identityStoreOutbox(store: IdentityStore): AuditOutbox {
  return {
    async read(shard: number, limit: number): Promise<OutboxRead> {
      const rows = await store.rows(
        { text: RELAY_READ, values: [shard, limit] },
        RelayReadRowSchema
      );
      if (rows.length === 0) return { status: 'empty' };
      return {
        status: 'rows',
        watermarkSeq: rows[0].watermark_seq,
        rows: rows.map(row => ({
          txid: row.txid,
          id: row.id,
          event: row.event,
        })),
      };
    },
    async advance(shard: number, fromSeq: bigint, to: ShardWatermark): Promise<boolean> {
      const moved = await store.maybeOne(
        {
          text: ADVANCE_WATERMARK,
          values: [
            shard,
            fromSeq.toString(),
            to.txid.toString(),
            to.id.toString(),
            to.seq.toString(),
          ],
        },
        ShardRowSchema
      );
      return moved !== null;
    },
  };
}

export async function unrelayedAges(store: IdentityStore): Promise<ShardAge[]> {
  const rows = await store.rows({ text: UNRELAYED_AGE, values: [] }, ShardAgeSchema);
  return rows.map(row => ({ shard: row.shard, ageSeconds: row.age_seconds }));
}

export async function maintainAuditPartitions(store: IdentityStore): Promise<PartitionStep[]> {
  return await store.rows({ text: MAINTAIN_AUDIT_PARTITIONS, values: [] }, PartitionStepSchema);
}

export async function partitionRunwayDays(store: IdentityStore): Promise<number> {
  const rows = await store.rows({ text: PARTITION_RUNWAY, values: [] }, RunwaySchema);
  return rows[0]?.days ?? 0;
}

export async function maintainOAuthRows(store: IdentityStore): Promise<OAuthStep[]> {
  return await store.rows({ text: MAINTAIN_OAUTH_ROWS, values: [] }, OAuthStepSchema);
}
