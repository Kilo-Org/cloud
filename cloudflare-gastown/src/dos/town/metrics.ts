/**
 * Metrics collection and timeseries queries for the Town DO.
 * Snapshots are recorded every alarm tick and stored in metrics_snapshots.
 * Usage data (tokens, cost) is reported by the container via reportUsage().
 */

import { z } from 'zod';
import { beads } from '../../db/tables/beads.table';
import { agent_metadata } from '../../db/tables/agent-metadata.table';
import { bead_events } from '../../db/tables/bead-events.table';
import {
  metrics_snapshots,
  MetricsSnapshotRecord,
  createTableMetricsSnapshots,
  getIndexesMetricsSnapshots,
} from '../../db/tables/metrics-snapshots.table';
import { query } from '../../util/query.util';

// ── Table initialization ────────────────────────────────────────────

export function initMetricsTables(sql: SqlStorage): void {
  query(sql, createTableMetricsSnapshots(), []);
  for (const idx of getIndexesMetricsSnapshots()) {
    query(sql, idx, []);
  }
}

// ── Usage accumulator ───────────────────────────────────────────────

/**
 * In-memory accumulator for token/cost usage reported by the container
 * between alarm ticks. Drained into the snapshot on each tick.
 */
export type UsageAccumulator = {
  inputTokens: number;
  outputTokens: number;
  costMicrodollars: number;
  /** Latest LOC additions snapshot from container (absolute, not delta) */
  locAdditions: number;
  /** Latest LOC deletions snapshot from container (absolute, not delta) */
  locDeletions: number;
};

export function createUsageAccumulator(): UsageAccumulator {
  return { inputTokens: 0, outputTokens: 0, costMicrodollars: 0, locAdditions: 0, locDeletions: 0 };
}

export function addUsage(acc: UsageAccumulator, input: number, output: number, cost: number): void {
  acc.inputTokens += input;
  acc.outputTokens += output;
  acc.costMicrodollars += cost;
}

/** Update the LOC snapshot (replaces, not accumulates — these are absolute totals) */
export function setLoc(acc: UsageAccumulator, additions: number, deletions: number): void {
  acc.locAdditions = additions;
  acc.locDeletions = deletions;
}

export function drainUsage(acc: UsageAccumulator): UsageAccumulator {
  const drained = { ...acc };
  acc.inputTokens = 0;
  acc.outputTokens = 0;
  acc.costMicrodollars = 0;
  // LOC values are NOT drained — they persist as the latest snapshot
  return drained;
}

// ── Snapshot collection ─────────────────────────────────────────────

/**
 * Collect a metrics snapshot from current DO state.
 * Called at the end of each alarm tick.
 */
export function collectSnapshot(
  sql: SqlStorage,
  lastSnapshotAt: string | null,
  usage: UsageAccumulator
): void {
  const capturedAt = new Date().toISOString();
  const snapshotId = crypto.randomUUID();

  // Agent counts by status
  const agentRows = [
    ...query(
      sql,
      /* sql */ `
        SELECT ${agent_metadata.status} AS status, COUNT(*) AS cnt
        FROM ${agent_metadata}
        GROUP BY ${agent_metadata.status}
      `,
      []
    ),
  ];
  let agentsWorking = 0;
  let agentsIdle = 0;
  let agentsTotal = 0;
  for (const row of agentRows) {
    const s = `${row.status as string}`;
    const c = Number(row.cnt);
    if (s === 'working') agentsWorking = c;
    else if (s === 'idle') agentsIdle = c;
    agentsTotal += c;
  }

  // Bead status counts (exclude agent and message types)
  const beadRows = [
    ...query(
      sql,
      /* sql */ `
        SELECT ${beads.status} AS status, COUNT(*) AS cnt
        FROM ${beads}
        WHERE ${beads.type} NOT IN ('agent', 'message')
        GROUP BY ${beads.status}
      `,
      []
    ),
  ];
  let beadsOpen = 0;
  let beadsInProgress = 0;
  let beadsInReview = 0;
  for (const row of beadRows) {
    const s = `${row.status as string}`;
    const c = Number(row.cnt);
    if (s === 'open') beadsOpen = c;
    else if (s === 'in_progress') beadsInProgress = c;
    else if (s === 'in_review') beadsInReview = c;
  }

  // Delta counts since last snapshot
  const sinceFilter = lastSnapshotAt ?? '1970-01-01T00:00:00.000Z';

  const eventsSinceRow = [
    ...query(
      sql,
      /* sql */ `
        SELECT COUNT(*) AS cnt
        FROM ${bead_events}
        WHERE ${bead_events.created_at} > ?
      `,
      [sinceFilter]
    ),
  ];
  const eventsSinceLast = Number(eventsSinceRow[0]?.cnt ?? 0);

  const createdSinceRow = [
    ...query(
      sql,
      /* sql */ `
        SELECT COUNT(*) AS cnt
        FROM ${bead_events}
        WHERE ${bead_events.event_type} = 'created'
          AND ${bead_events.created_at} > ?
      `,
      [sinceFilter]
    ),
  ];
  const beadsCreatedSinceLast = Number(createdSinceRow[0]?.cnt ?? 0);

  const closedSinceRow = [
    ...query(
      sql,
      /* sql */ `
        SELECT COUNT(*) AS cnt
        FROM ${bead_events}
        WHERE ${bead_events.event_type} = 'closed'
          AND ${bead_events.created_at} > ?
      `,
      [sinceFilter]
    ),
  ];
  const beadsClosedSinceLast = Number(closedSinceRow[0]?.cnt ?? 0);

  // Drain accumulated usage
  const drained = drainUsage(usage);

  query(
    sql,
    /* sql */ `
      INSERT INTO ${metrics_snapshots} (
        ${metrics_snapshots.columns.snapshot_id},
        ${metrics_snapshots.columns.captured_at},
        ${metrics_snapshots.columns.agents_working},
        ${metrics_snapshots.columns.agents_idle},
        ${metrics_snapshots.columns.agents_total},
        ${metrics_snapshots.columns.beads_open},
        ${metrics_snapshots.columns.beads_in_progress},
        ${metrics_snapshots.columns.beads_in_review},
        ${metrics_snapshots.columns.events_since_last},
        ${metrics_snapshots.columns.beads_created_since_last},
        ${metrics_snapshots.columns.beads_closed_since_last},
        ${metrics_snapshots.columns.input_tokens_since_last},
        ${metrics_snapshots.columns.output_tokens_since_last},
        ${metrics_snapshots.columns.cost_microdollars_since_last},
        ${metrics_snapshots.columns.loc_additions},
        ${metrics_snapshots.columns.loc_deletions}
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      snapshotId,
      capturedAt,
      agentsWorking,
      agentsIdle,
      agentsTotal,
      beadsOpen,
      beadsInProgress,
      beadsInReview,
      eventsSinceLast,
      beadsCreatedSinceLast,
      beadsClosedSinceLast,
      drained.inputTokens,
      drained.outputTokens,
      drained.costMicrodollars,
      usage.locAdditions,
      usage.locDeletions,
    ]
  );

  // Prune old snapshots — keep 7 days of data
  query(
    sql,
    /* sql */ `
      DELETE FROM ${metrics_snapshots}
      WHERE ${metrics_snapshots.captured_at} < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')
    `,
    []
  );
}

// ── Timeseries queries ──────────────────────────────────────────────

export const TimeseriesWindow = z.enum(['1h', '6h', '24h', '7d']);
export type TimeseriesWindow = z.infer<typeof TimeseriesWindow>;

function windowToSqlInterval(window: TimeseriesWindow): string {
  switch (window) {
    case '1h':
      return '-1 hour';
    case '6h':
      return '-6 hours';
    case '24h':
      return '-1 day';
    case '7d':
      return '-7 days';
  }
}

function windowToBucketSeconds(window: TimeseriesWindow): number {
  switch (window) {
    case '1h':
      return 5; // raw 5s snapshots
    case '6h':
      return 60; // 1-minute buckets
    case '24h':
      return 300; // 5-minute buckets
    case '7d':
      return 3600; // 1-hour buckets
  }
}

export const TimeseriesPointRecord = z.object({
  bucket: z.string(),
  agents_working: z.coerce.number(),
  agents_idle: z.coerce.number(),
  agents_total: z.coerce.number(),
  beads_open: z.coerce.number(),
  beads_in_progress: z.coerce.number(),
  beads_in_review: z.coerce.number(),
  events_count: z.coerce.number(),
  beads_created: z.coerce.number(),
  beads_closed: z.coerce.number(),
  input_tokens: z.coerce.number(),
  output_tokens: z.coerce.number(),
  cost_microdollars: z.coerce.number(),
  loc_additions: z.coerce.number(),
  loc_deletions: z.coerce.number(),
});

export type TimeseriesPointRecord = z.output<typeof TimeseriesPointRecord>;

/**
 * Query timeseries data for a given window, bucketed for chart display.
 * Gauge-type metrics (agent counts, bead counts) use AVG within each bucket.
 * Counter-type metrics (events, created, closed, tokens, cost) use SUM.
 */
export function queryTimeseries(
  sql: SqlStorage,
  window: TimeseriesWindow
): TimeseriesPointRecord[] {
  const interval = windowToSqlInterval(window);
  const bucketSec = windowToBucketSeconds(window);

  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT
          strftime('%Y-%m-%dT%H:%M:%SZ',
            (CAST(strftime('%s', ${metrics_snapshots.captured_at}) AS INTEGER) / ? * ?),
            'unixepoch'
          ) AS bucket,
          CAST(AVG(${metrics_snapshots.agents_working}) AS INTEGER) AS agents_working,
          CAST(AVG(${metrics_snapshots.agents_idle}) AS INTEGER) AS agents_idle,
          CAST(AVG(${metrics_snapshots.agents_total}) AS INTEGER) AS agents_total,
          CAST(AVG(${metrics_snapshots.beads_open}) AS INTEGER) AS beads_open,
          CAST(AVG(${metrics_snapshots.beads_in_progress}) AS INTEGER) AS beads_in_progress,
          CAST(AVG(${metrics_snapshots.beads_in_review}) AS INTEGER) AS beads_in_review,
          SUM(${metrics_snapshots.events_since_last}) AS events_count,
          SUM(${metrics_snapshots.beads_created_since_last}) AS beads_created,
          SUM(${metrics_snapshots.beads_closed_since_last}) AS beads_closed,
          SUM(${metrics_snapshots.input_tokens_since_last}) AS input_tokens,
          SUM(${metrics_snapshots.output_tokens_since_last}) AS output_tokens,
          SUM(${metrics_snapshots.cost_microdollars_since_last}) AS cost_microdollars,
          CAST(AVG(${metrics_snapshots.loc_additions}) AS INTEGER) AS loc_additions,
          CAST(AVG(${metrics_snapshots.loc_deletions}) AS INTEGER) AS loc_deletions
        FROM ${metrics_snapshots}
        WHERE ${metrics_snapshots.captured_at} >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
        GROUP BY bucket
        ORDER BY bucket ASC
      `,
      [bucketSec, bucketSec, interval]
    ),
  ];

  return TimeseriesPointRecord.array().parse(rows);
}

// ── Throughput computation ──────────────────────────────────────────

export type ThroughputGauges = {
  /** Tokens per second (rolling 5-minute average) */
  tokensPerSec: number;
  /** Cost in microdollars per second (rolling 5-minute average) */
  costPerSec: number;
  /** Total active (working) agents */
  activeAgents: number;
  /** Total agents */
  totalAgents: number;
  /** Current total LOC additions across all agents */
  locAdditions: number;
  /** Current total LOC deletions across all agents */
  locDeletions: number;
};

/**
 * Compute current throughput gauges from recent snapshots.
 * Uses a 5-minute rolling window for rate metrics.
 */
export function computeThroughput(sql: SqlStorage): ThroughputGauges {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT
          SUM(${metrics_snapshots.input_tokens_since_last} + ${metrics_snapshots.output_tokens_since_last}) AS total_tokens,
          SUM(${metrics_snapshots.cost_microdollars_since_last}) AS total_cost,
          MIN(${metrics_snapshots.captured_at}) AS earliest,
          MAX(${metrics_snapshots.captured_at}) AS latest,
          COUNT(*) AS num_snapshots
        FROM ${metrics_snapshots}
        WHERE ${metrics_snapshots.captured_at} >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5 minutes')
      `,
      []
    ),
  ];

  const row = rows[0];
  const totalTokens = Number(row?.total_tokens ?? 0);
  const totalCost = Number(row?.total_cost ?? 0);
  const earliest = row?.earliest ? String(row.earliest) : null;
  const latest = row?.latest ? String(row.latest) : null;

  let windowSec = 300; // default to 5 minutes
  if (earliest && latest) {
    const diff = (new Date(latest).getTime() - new Date(earliest).getTime()) / 1000;
    if (diff > 0) windowSec = diff;
  }

  // Current agent counts (latest snapshot is most accurate)
  const agentRow = [
    ...query(
      sql,
      /* sql */ `
        SELECT ${metrics_snapshots.agents_working}, ${metrics_snapshots.agents_total},
               ${metrics_snapshots.loc_additions}, ${metrics_snapshots.loc_deletions}
        FROM ${metrics_snapshots}
        ORDER BY ${metrics_snapshots.captured_at} DESC
        LIMIT 1
      `,
      []
    ),
  ];

  return {
    tokensPerSec: windowSec > 0 ? Math.round((totalTokens / windowSec) * 10) / 10 : 0,
    costPerSec: windowSec > 0 ? Math.round((totalCost / windowSec) * 10) / 10 : 0,
    activeAgents: Number(agentRow[0]?.agents_working ?? 0),
    totalAgents: Number(agentRow[0]?.agents_total ?? 0),
    locAdditions: Number(agentRow[0]?.loc_additions ?? 0),
    locDeletions: Number(agentRow[0]?.loc_deletions ?? 0),
  };
}
