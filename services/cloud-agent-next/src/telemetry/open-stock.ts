import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { WorkerDb } from '@kilocode/db/client';
import {
  cloud_agent_session_runs,
  cloud_agent_sessions,
  type CloudAgentSessionRunStatus,
} from '@kilocode/db/schema';
import { getPgDb } from '../db/pg.js';
import type { Env } from '../types.js';
import { logger } from '../logger.js';
import { retentionCutoff } from './report-store.js';
import {
  AGENT_OPEN_METRIC,
  COLLECTION_METRIC,
  EXPECTED_GENERATIONS,
  PRODUCT_ORIGINS,
  generationExpression,
  originBucketExpression,
  type OutcomeGeneration,
  type ProductOrigin,
} from './outcome-aggregate.js';

export type OpenStockQueryRow = {
  generation: OutcomeGeneration;
  status: CloudAgentSessionRunStatus;
  origin: ProductOrigin;
  turns: number;
  oldestQueuedEpochMs: number | null;
  oldestAcceptedEpochMs: number | null;
};

export type OpenStockCell = {
  generation: OutcomeGeneration;
  productOrigin: ProductOrigin;
  queuedTurns: number;
  acceptedTurns: number;
  oldestQueuedAgeMs: number | null;
  oldestAcceptedAgeMs: number | null;
};

export function readOpenStock(
  db: WorkerDb,
  input: { retentionCutoff: string }
): Promise<OpenStockQueryRow[]> {
  const generation = generationExpression(cloud_agent_session_runs.cloud_agent_session_id);
  return db
    .select({
      generation,
      status: cloud_agent_session_runs.status,
      origin: originBucketExpression,
      turns: sql<number>`count(*)::int`,
      oldestQueuedEpochMs: sql<
        number | null
      >`(extract(epoch from (min(${cloud_agent_session_runs.queued_at}) filter (where ${cloud_agent_session_runs.status} = 'queued'))) * 1000)::double precision`,
      oldestAcceptedEpochMs: sql<
        number | null
      >`(extract(epoch from (min(${cloud_agent_session_runs.dispatch_accepted_at}) filter (where ${cloud_agent_session_runs.status} = 'accepted'))) * 1000)::double precision`,
    })
    .from(cloud_agent_session_runs)
    .innerJoin(
      cloud_agent_sessions,
      eq(
        cloud_agent_sessions.cloud_agent_session_id,
        cloud_agent_session_runs.cloud_agent_session_id
      )
    )
    .where(
      and(
        inArray(cloud_agent_session_runs.status, ['queued', 'accepted']),
        isNull(cloud_agent_session_runs.terminal_at),
        gt(cloud_agent_sessions.created_at, input.retentionCutoff)
      )
    )
    .groupBy(sql`1`, sql`2`, sql`3`);
}

function minimumNonNull(values: (number | null)[]): number | null {
  let minimum: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    if (minimum === null || value < minimum) minimum = value;
  }
  return minimum;
}

export function assembleOpenStock(rows: OpenStockQueryRow[], observedAt: string): OpenStockCell[] {
  const observedMs = Date.parse(observedAt);
  const cells: OpenStockCell[] = [];
  for (const generation of EXPECTED_GENERATIONS) {
    for (const productOrigin of PRODUCT_ORIGINS) {
      const cellRows = rows.filter(
        row => row.generation === generation && row.origin === productOrigin
      );
      const queued = cellRows.filter(row => row.status === 'queued');
      const accepted = cellRows.filter(row => row.status === 'accepted');
      const oldestQueuedEpochMs = minimumNonNull(queued.map(row => row.oldestQueuedEpochMs));
      const oldestAcceptedEpochMs = minimumNonNull(accepted.map(row => row.oldestAcceptedEpochMs));
      cells.push({
        generation,
        productOrigin,
        queuedTurns: queued.reduce((sum, row) => sum + row.turns, 0),
        acceptedTurns: accepted.reduce((sum, row) => sum + row.turns, 0),
        oldestQueuedAgeMs: oldestQueuedEpochMs === null ? null : observedMs - oldestQueuedEpochMs,
        oldestAcceptedAgeMs:
          oldestAcceptedEpochMs === null ? null : observedMs - oldestAcceptedEpochMs,
      });
    }
  }
  return cells;
}

export async function runCloudAgentOpenStockCollection(env: Env, now = new Date()): Promise<void> {
  const observedAt = now.toISOString();
  const retentionCutoffIso = retentionCutoff(observedAt);

  try {
    const rows = await readOpenStock(getPgDb(env), { retentionCutoff: retentionCutoffIso });
    for (const cell of assembleOpenStock(rows, observedAt)) {
      logger
        .withFields({
          metric: AGENT_OPEN_METRIC,
          observedAt,
          ...cell,
        })
        .info('Cloud Agent open stock');
    }
  } catch {
    logger
      .withFields({
        metric: COLLECTION_METRIC,
        collector: AGENT_OPEN_METRIC,
        observedAt,
        status: 'failed',
      })
      .error('Cloud Agent open stock collection failed');
  }
}
