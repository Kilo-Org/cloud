import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

/**
 * Periodic metrics snapshots collected by the alarm handler.
 * One row per alarm tick (~5s when active, ~60s when idle).
 * Used for timeseries charts on the observability tab.
 */
export const MetricsSnapshotRecord = z.object({
  snapshot_id: z.string(),
  /** ISO timestamp of when the snapshot was taken */
  captured_at: z.string(),
  /** Number of agents in 'working' status */
  agents_working: z.coerce.number(),
  /** Number of agents in 'idle' status */
  agents_idle: z.coerce.number(),
  /** Total registered agents */
  agents_total: z.coerce.number(),
  /** Beads currently open */
  beads_open: z.coerce.number(),
  /** Beads currently in_progress */
  beads_in_progress: z.coerce.number(),
  /** Beads currently in_review */
  beads_in_review: z.coerce.number(),
  /** Bead events recorded since last snapshot */
  events_since_last: z.coerce.number(),
  /** Beads created since last snapshot */
  beads_created_since_last: z.coerce.number(),
  /** Beads closed since last snapshot */
  beads_closed_since_last: z.coerce.number(),
  /** Accumulated input tokens since last snapshot */
  input_tokens_since_last: z.coerce.number(),
  /** Accumulated output tokens since last snapshot */
  output_tokens_since_last: z.coerce.number(),
  /** Accumulated cost in microdollars since last snapshot */
  cost_microdollars_since_last: z.coerce.number(),
  /** Total LOC additions across all agents (absolute snapshot, not delta) */
  loc_additions: z.coerce.number(),
  /** Total LOC deletions across all agents (absolute snapshot, not delta) */
  loc_deletions: z.coerce.number(),
});

export type MetricsSnapshotRecord = z.output<typeof MetricsSnapshotRecord>;

export const metrics_snapshots = getTableFromZodSchema('metrics_snapshots', MetricsSnapshotRecord);

export function createTableMetricsSnapshots(): string {
  return getCreateTableQueryFromTable(metrics_snapshots, {
    snapshot_id: 'text primary key',
    captured_at: 'text not null',
    agents_working: 'integer not null default 0',
    agents_idle: 'integer not null default 0',
    agents_total: 'integer not null default 0',
    beads_open: 'integer not null default 0',
    beads_in_progress: 'integer not null default 0',
    beads_in_review: 'integer not null default 0',
    events_since_last: 'integer not null default 0',
    beads_created_since_last: 'integer not null default 0',
    beads_closed_since_last: 'integer not null default 0',
    input_tokens_since_last: 'integer not null default 0',
    output_tokens_since_last: 'integer not null default 0',
    cost_microdollars_since_last: 'integer not null default 0',
    loc_additions: 'integer not null default 0',
    loc_deletions: 'integer not null default 0',
  });
}

export function getIndexesMetricsSnapshots(): string[] {
  return [
    `CREATE INDEX IF NOT EXISTS idx_metrics_snapshots_captured ON ${metrics_snapshots}(${metrics_snapshots.columns.captured_at})`,
  ];
}
