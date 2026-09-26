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
  COVERAGE_LABEL,
  EXPECTED_GENERATIONS,
  generationExpression,
  type OutcomeGeneration,
} from './outcome-aggregate.js';

export const OPEN_STOCK_METRIC = 'cloud_agent_open_stock';
export const OPEN_STOCK_CONTRACT_VERSION = 1;
export const OPEN_STOCK_LIMITATIONS = [
  'row_state_age_not_stall',
  'accepted_not_sandbox_alive',
  'lost_reports_undercount',
  'age_alerting_deferred',
] as const;

const OPEN_STOCK_SERVICE = 'cloud-agent-next';

export type OpenStockQueryRow = {
  generation: OutcomeGeneration;
  status: CloudAgentSessionRunStatus;
  turns: number;
  sessions: number;
  oldestQueuedEpochMs: number | null;
  oldestAcceptedEpochMs: number | null;
  queuedMissingAgeTurns: number;
  acceptedMissingAgeTurns: number;
};

export type GenerationOpenStock = {
  generation: OutcomeGeneration;
  queuedTurns: number;
  queuedSessions: number;
  acceptedTurns: number;
  acceptedSessions: number;
  oldestQueuedAgeMs: number | null;
  oldestAcceptedAgeMs: number | null;
  queuedMissingAgeTurns: number;
  acceptedMissingAgeTurns: number;
};

export async function readOpenStock(
  db: WorkerDb,
  input: { retentionCutoff: string }
): Promise<OpenStockQueryRow[]> {
  const generation = generationExpression(cloud_agent_session_runs.cloud_agent_session_id);
  return db
    .select({
      generation,
      status: cloud_agent_session_runs.status,
      turns: sql<number>`count(*)::int`,
      sessions: sql<number>`(count(distinct ${cloud_agent_session_runs.cloud_agent_session_id}))::int`,
      oldestQueuedEpochMs: sql<
        number | null
      >`(extract(epoch from (min(${cloud_agent_session_runs.queued_at}) filter (where ${cloud_agent_session_runs.status} = 'queued'))) * 1000)::double precision`,
      oldestAcceptedEpochMs: sql<
        number | null
      >`(extract(epoch from (min(${cloud_agent_session_runs.dispatch_accepted_at}) filter (where ${cloud_agent_session_runs.status} = 'accepted'))) * 1000)::double precision`,
      queuedMissingAgeTurns: sql<number>`(count(*) filter (where ${cloud_agent_session_runs.status} = 'queued' and ${cloud_agent_session_runs.queued_at} is null))::int`,
      acceptedMissingAgeTurns: sql<number>`(count(*) filter (where ${cloud_agent_session_runs.status} = 'accepted' and ${cloud_agent_session_runs.dispatch_accepted_at} is null))::int`,
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
    .groupBy(sql`1`, sql`2`);
}

export function assembleOpenStock(rows: OpenStockQueryRow[], now: string): GenerationOpenStock[] {
  const nowMs = Date.parse(now);
  return EXPECTED_GENERATIONS.map(generation => {
    const queued = rows.find(row => row.generation === generation && row.status === 'queued');
    const accepted = rows.find(row => row.generation === generation && row.status === 'accepted');
    const oldestQueuedEpochMs = queued?.oldestQueuedEpochMs ?? null;
    const oldestAcceptedEpochMs = accepted?.oldestAcceptedEpochMs ?? null;
    return {
      generation,
      queuedTurns: queued?.turns ?? 0,
      queuedSessions: queued?.sessions ?? 0,
      acceptedTurns: accepted?.turns ?? 0,
      acceptedSessions: accepted?.sessions ?? 0,
      oldestQueuedAgeMs: oldestQueuedEpochMs === null ? null : nowMs - oldestQueuedEpochMs,
      oldestAcceptedAgeMs: oldestAcceptedEpochMs === null ? null : nowMs - oldestAcceptedEpochMs,
      queuedMissingAgeTurns: queued?.queuedMissingAgeTurns ?? 0,
      acceptedMissingAgeTurns: accepted?.acceptedMissingAgeTurns ?? 0,
    };
  });
}

function openStockEnvelope(input: {
  collectionTimestamp: string;
  queryElapsedMs: number;
  retentionCutoff: string;
}): Record<string, unknown> {
  return {
    metric: OPEN_STOCK_METRIC,
    logTag: OPEN_STOCK_METRIC,
    contractVersion: OPEN_STOCK_CONTRACT_VERSION,
    service: OPEN_STOCK_SERVICE,
    environment: null,
    evaluationId: `${OPEN_STOCK_METRIC}:${input.collectionTimestamp}`,
    collectionTimestamp: input.collectionTimestamp,
    queryElapsedMs: input.queryElapsedMs,
    coverage: COVERAGE_LABEL,
    retentionCutoff: input.retentionCutoff,
    expectedGenerations: [...EXPECTED_GENERATIONS],
    limitations: [...OPEN_STOCK_LIMITATIONS],
  };
}

export async function runCloudAgentOpenStockCollection(env: Env, now = new Date()): Promise<void> {
  const collectionTimestamp = now.toISOString();
  const retentionCutoffIso = retentionCutoff(collectionTimestamp);
  const evaluatedAt = Date.now();

  try {
    const db = getPgDb(env);
    const rows = await readOpenStock(db, { retentionCutoff: retentionCutoffIso });
    logger
      .withFields({
        ...openStockEnvelope({
          collectionTimestamp,
          queryElapsedMs: Date.now() - evaluatedAt,
          retentionCutoff: retentionCutoffIso,
        }),
        collectionStatus: 'complete',
        generations: assembleOpenStock(rows, collectionTimestamp),
      })
      .info('Cloud Agent open stock');
  } catch {
    logger
      .withFields({
        ...openStockEnvelope({
          collectionTimestamp,
          queryElapsedMs: Date.now() - evaluatedAt,
          retentionCutoff: retentionCutoffIso,
        }),
        collectionStatus: 'failed',
        failureKind: 'db_query_failed',
      })
      .error('Cloud Agent open stock failed');
  }
}
