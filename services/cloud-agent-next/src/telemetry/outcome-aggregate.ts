import { and, eq, gt, gte, lt, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { WorkerDb } from '@kilocode/db/client';
import {
  cloud_agent_session_runs,
  cloud_agent_sessions,
  type CloudAgentSessionRunStatus,
} from '@kilocode/db/schema';
import { getPgDb } from '../db/pg.js';
import type { Env } from '../types.js';
import { logger } from '../logger.js';
import { CONTROL_PLANE_SESSION_PREFIX } from '../session-plane.js';
import { CLOUD_AGENT_REPORT_RETENTION_DAYS, retentionCutoff } from './report-store.js';

export const OUTCOME_WINDOW_MINUTES = [5, 15, 60] as const;
// Provisional: not yet measured against production reporting lag.
export const REPORTING_DELAY_ALLOWANCE_MS = 2 * 60 * 1000;
export const COVERAGE_LABEL = `retained_reporting_population_${CLOUD_AGENT_REPORT_RETENTION_DAYS}d`;
export const AGGREGATE_CONTRACT_VERSION = 1;
export const AGGREGATE_METRIC = 'cloud_agent_outcome_aggregate';
export const EXPECTED_GENERATIONS = ['legacy', 'control'] as const;
export const OUTCOME_AGGREGATE_LIMITATIONS = [
  'reported_categories_only',
  'pre_dispatch_not_proof_of_model_reach',
  'post_dispatch_no_activity_does_not_establish_prior_activity',
  'unknown_includes_wrapper_reasons',
  'provider_includes_user_model_selection_errors',
  'no_provider_or_region',
] as const;

const AGGREGATE_SERVICE = 'cloud-agent-next';

export type OutcomeGeneration = (typeof EXPECTED_GENERATIONS)[number];
export type OutcomeRole = 'initial' | 'follow_up';

export type FailureStageCount = { stage: string; count: number };
export type FailureStageCodeCount = {
  stage: string;
  code: string;
  responsibility: string;
  reason: string;
  count: number;
};
export type SessionSetupFailureCount = { stage: string; code: string; count: number };

export type RoleOutcome = {
  completed: number;
  platformFailed: number;
  providerFailed: number;
  userFailed: number;
  unknownFailed: number;
  interrupted: number;
  settled: number;
  allFailed: number;
  platformFailureShare: number | null;
  unknownClassificationShare: number | null;
  unknownSettledShare: number | null;
  failureStages: FailureStageCount[];
  failureStageCodes: FailureStageCodeCount[];
};

export type GenerationOutcome = {
  generation: OutcomeGeneration;
  runRowsObserved: boolean;
  initial: RoleOutcome;
  followUp: RoleOutcome;
  totals: RoleOutcome;
  distinctPlatformAffectedSessions: number;
  distinctProviderAffectedSessions: number;
  distinctUnknownAffectedSessions: number;
  sessionSetupFailures: SessionSetupFailureCount[];
  sessionSetupFailureCount: number;
};

export type OutcomeWindow = { windowMinutes: number; start: string; end: string };

type RunCountRow = {
  generation: OutcomeGeneration;
  role: OutcomeRole;
  status: CloudAgentSessionRunStatus;
  responsibility: string;
  failureStage: string;
  failureCode: string;
  failureReason: string;
  runCount: number;
};

type DistinctAffectedRow = {
  generation: OutcomeGeneration;
  distinctPlatformAffectedSessions: number;
  distinctProviderAffectedSessions: number;
  distinctUnknownAffectedSessions: number;
};

type SessionSetupFailureRow = {
  generation: OutcomeGeneration;
  failureStage: string;
  failureCode: string;
  failureCount: number;
};

type DatabaseTransaction = Parameters<Parameters<WorkerDb['transaction']>[0]>[0];

const unknownResponsibilityCondition: SQL = sql`(${cloud_agent_session_runs.failure_responsibility} is null or ${cloud_agent_session_runs.failure_responsibility} not in ('platform', 'provider', 'user'))`;

export function generationExpression(sessionId: AnyColumn): SQL<OutcomeGeneration> {
  return sql<OutcomeGeneration>`case when left(${sessionId}, ${CONTROL_PLANE_SESSION_PREFIX.length}) = ${CONTROL_PLANE_SESSION_PREFIX} then 'control' else 'legacy' end`;
}

const roleExpression: SQL<OutcomeRole> = sql<OutcomeRole>`case when ${cloud_agent_session_runs.message_id} = ${cloud_agent_sessions.initial_message_id} then 'initial' else 'follow_up' end`;

const responsibilityBucketExpression: SQL<string> = sql<string>`case when ${unknownResponsibilityCondition} then 'unknown' else ${cloud_agent_session_runs.failure_responsibility} end`;

const runFailureStageExpression: SQL<string> = sql<string>`coalesce(${cloud_agent_session_runs.failure_stage}, 'unknown')`;
const runFailureCodeExpression: SQL<string> = sql<string>`coalesce(${cloud_agent_session_runs.failure_code}, 'unclassified')`;
const runFailureReasonExpression: SQL<string> = sql<string>`coalesce(${cloud_agent_session_runs.failure_reason}, 'unclassified')`;
const sessionFailureStageExpression: SQL<string> = sql<string>`coalesce(${cloud_agent_sessions.failure_stage}, 'unknown')`;
const sessionFailureCodeExpression: SQL<string> = sql<string>`coalesce(${cloud_agent_sessions.failure_code}, 'unclassified')`;

function retainedWindow(
  timeColumn: AnyColumn,
  window: OutcomeWindow,
  retentionCutoffIso: string
): SQL {
  return (
    and(
      gte(timeColumn, window.start),
      lt(timeColumn, window.end),
      gt(cloud_agent_sessions.created_at, retentionCutoffIso)
    ) ?? sql`true`
  );
}

async function readRunCounts(
  tx: DatabaseTransaction,
  window: OutcomeWindow,
  retentionCutoffIso: string
): Promise<RunCountRow[]> {
  const generation = generationExpression(cloud_agent_session_runs.cloud_agent_session_id);
  return tx
    .select({
      generation,
      role: roleExpression,
      status: cloud_agent_session_runs.status,
      responsibility: responsibilityBucketExpression,
      failureStage: runFailureStageExpression,
      failureCode: runFailureCodeExpression,
      failureReason: runFailureReasonExpression,
      runCount: sql<number>`count(*)::int`,
    })
    .from(cloud_agent_session_runs)
    .innerJoin(
      cloud_agent_sessions,
      eq(
        cloud_agent_sessions.cloud_agent_session_id,
        cloud_agent_session_runs.cloud_agent_session_id
      )
    )
    .where(retainedWindow(cloud_agent_session_runs.terminal_at, window, retentionCutoffIso))
    .groupBy(sql`1`, sql`2`, sql`3`, sql`4`, sql`5`, sql`6`, sql`7`);
}

async function readDistinctAffectedSessions(
  tx: DatabaseTransaction,
  window: OutcomeWindow,
  retentionCutoffIso: string
): Promise<DistinctAffectedRow[]> {
  return tx
    .select({
      generation: generationExpression(cloud_agent_session_runs.cloud_agent_session_id),
      distinctPlatformAffectedSessions: sql<number>`(count(distinct ${cloud_agent_session_runs.cloud_agent_session_id}) filter (where ${cloud_agent_session_runs.failure_responsibility} = 'platform'))::int`,
      distinctProviderAffectedSessions: sql<number>`(count(distinct ${cloud_agent_session_runs.cloud_agent_session_id}) filter (where ${cloud_agent_session_runs.failure_responsibility} = 'provider'))::int`,
      distinctUnknownAffectedSessions: sql<number>`(count(distinct ${cloud_agent_session_runs.cloud_agent_session_id}) filter (where ${unknownResponsibilityCondition}))::int`,
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
        eq(cloud_agent_session_runs.status, 'failed'),
        retainedWindow(cloud_agent_session_runs.terminal_at, window, retentionCutoffIso)
      )
    )
    .groupBy(sql`1`);
}

async function readSessionSetupFailures(
  tx: DatabaseTransaction,
  window: OutcomeWindow,
  retentionCutoffIso: string
): Promise<SessionSetupFailureRow[]> {
  const generation = generationExpression(cloud_agent_sessions.cloud_agent_session_id);
  return tx
    .select({
      generation,
      failureStage: sessionFailureStageExpression,
      failureCode: sessionFailureCodeExpression,
      failureCount: sql<number>`count(*)::int`,
    })
    .from(cloud_agent_sessions)
    .where(retainedWindow(cloud_agent_sessions.failure_at, window, retentionCutoffIso))
    .groupBy(sql`1`, sql`2`, sql`3`);
}

function compareByStage(left: { stage: string }, right: { stage: string }): number {
  return left.stage < right.stage ? -1 : left.stage > right.stage ? 1 : 0;
}

function compareByStageCode(
  left: { stage: string; code: string },
  right: { stage: string; code: string }
): number {
  const byStage = compareByStage(left, right);
  if (byStage !== 0) return byStage;
  return left.code < right.code ? -1 : left.code > right.code ? 1 : 0;
}

function compareByStageCodeResponsibility(
  left: FailureStageCodeCount,
  right: FailureStageCodeCount
): number {
  const byStageCode = compareByStageCode(left, right);
  if (byStageCode !== 0) return byStageCode;
  if (left.responsibility !== right.responsibility) {
    return left.responsibility < right.responsibility ? -1 : 1;
  }
  return left.reason < right.reason ? -1 : left.reason > right.reason ? 1 : 0;
}

function roleOutcome(rows: RunCountRow[]): RoleOutcome {
  let completed = 0;
  let interrupted = 0;
  let platformFailed = 0;
  let providerFailed = 0;
  let userFailed = 0;
  let unknownFailed = 0;
  const stageTotals = new Map<string, number>();
  const stageCodes = new Map<string, FailureStageCodeCount>();

  for (const row of rows) {
    if (row.status === 'completed') {
      completed += row.runCount;
      continue;
    }
    if (row.status === 'interrupted') {
      interrupted += row.runCount;
      continue;
    }
    if (row.status !== 'failed') continue;

    if (row.responsibility === 'platform') platformFailed += row.runCount;
    else if (row.responsibility === 'provider') providerFailed += row.runCount;
    else if (row.responsibility === 'user') userFailed += row.runCount;
    else unknownFailed += row.runCount;

    stageTotals.set(row.failureStage, (stageTotals.get(row.failureStage) ?? 0) + row.runCount);
    const key = `${row.failureStage}\u0000${row.failureCode}\u0000${row.responsibility}\u0000${row.failureReason}`;
    const existing = stageCodes.get(key);
    if (existing) existing.count += row.runCount;
    else
      stageCodes.set(key, {
        stage: row.failureStage,
        code: row.failureCode,
        responsibility: row.responsibility,
        reason: row.failureReason,
        count: row.runCount,
      });
  }

  const allFailed = platformFailed + providerFailed + userFailed + unknownFailed;
  const settled = completed + allFailed;

  return {
    completed,
    platformFailed,
    providerFailed,
    userFailed,
    unknownFailed,
    interrupted,
    settled,
    allFailed,
    platformFailureShare: settled > 0 ? platformFailed / settled : null,
    unknownClassificationShare: allFailed > 0 ? unknownFailed / allFailed : null,
    unknownSettledShare: settled > 0 ? unknownFailed / settled : null,
    failureStages: [...stageTotals]
      .map(([stage, count]) => ({ stage, count }))
      .sort(compareByStage),
    failureStageCodes: [...stageCodes.values()].sort(compareByStageCodeResponsibility),
  };
}

export function assembleGenerationAggregates(
  runCounts: RunCountRow[],
  distinctAffectedSessions: DistinctAffectedRow[],
  sessionSetupFailures: SessionSetupFailureRow[]
): GenerationOutcome[] {
  return EXPECTED_GENERATIONS.map(generation => {
    const generationRuns = runCounts.filter(row => row.generation === generation);
    const distinct = distinctAffectedSessions.find(row => row.generation === generation);
    const setupFailures = sessionSetupFailures
      .filter(row => row.generation === generation)
      .map(row => ({ stage: row.failureStage, code: row.failureCode, count: row.failureCount }))
      .sort(compareByStageCode);
    return {
      generation,
      runRowsObserved: generationRuns.length > 0,
      initial: roleOutcome(generationRuns.filter(row => row.role === 'initial')),
      followUp: roleOutcome(generationRuns.filter(row => row.role === 'follow_up')),
      totals: roleOutcome(generationRuns),
      distinctPlatformAffectedSessions: distinct?.distinctPlatformAffectedSessions ?? 0,
      distinctProviderAffectedSessions: distinct?.distinctProviderAffectedSessions ?? 0,
      distinctUnknownAffectedSessions: distinct?.distinctUnknownAffectedSessions ?? 0,
      sessionSetupFailures: setupFailures,
      sessionSetupFailureCount: setupFailures.reduce((sum, row) => sum + row.count, 0),
    };
  });
}

export async function readOutcomeAggregate(
  db: WorkerDb,
  input: { window: OutcomeWindow; retentionCutoff: string }
): Promise<GenerationOutcome[]> {
  return db.transaction(
    async tx => {
      const runCounts = await readRunCounts(tx, input.window, input.retentionCutoff);
      const distinctAffectedSessions = await readDistinctAffectedSessions(
        tx,
        input.window,
        input.retentionCutoff
      );
      const sessionSetupFailures = await readSessionSetupFailures(
        tx,
        input.window,
        input.retentionCutoff
      );
      return assembleGenerationAggregates(
        runCounts,
        distinctAffectedSessions,
        sessionSetupFailures
      );
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' }
  );
}

function evaluationEnvelope(input: {
  window: OutcomeWindow;
  collectionTimestamp: string;
  queryElapsedMs: number;
  retentionCutoff: string;
}): Record<string, unknown> {
  return {
    metric: AGGREGATE_METRIC,
    logTag: AGGREGATE_METRIC,
    contractVersion: AGGREGATE_CONTRACT_VERSION,
    service: AGGREGATE_SERVICE,
    environment: null,
    evaluationId: `${AGGREGATE_METRIC}:${input.window.windowMinutes}:${input.window.end}`,
    collectionTimestamp: input.collectionTimestamp,
    queryElapsedMs: input.queryElapsedMs,
    windowStart: input.window.start,
    windowEnd: input.window.end,
    windowMinutes: input.window.windowMinutes,
    reportingDelayMs: REPORTING_DELAY_ALLOWANCE_MS,
    coverage: COVERAGE_LABEL,
    retentionCutoff: input.retentionCutoff,
    expectedGenerations: [...EXPECTED_GENERATIONS],
    limitations: [...OUTCOME_AGGREGATE_LIMITATIONS],
  };
}

export async function runCloudAgentOutcomeCollection(env: Env, now = new Date()): Promise<void> {
  const db = getPgDb(env);
  const collectionTimestamp = now.toISOString();
  const retentionCutoffIso = retentionCutoff(collectionTimestamp);
  const windowEnd = new Date(now.getTime() - REPORTING_DELAY_ALLOWANCE_MS).toISOString();

  for (const windowMinutes of OUTCOME_WINDOW_MINUTES) {
    const window: OutcomeWindow = {
      windowMinutes,
      start: new Date(Date.parse(windowEnd) - windowMinutes * 60_000).toISOString(),
      end: windowEnd,
    };
    const evaluatedAt = Date.now();
    try {
      const generations = await readOutcomeAggregate(db, {
        window,
        retentionCutoff: retentionCutoffIso,
      });
      logger
        .withFields({
          ...evaluationEnvelope({
            window,
            collectionTimestamp,
            queryElapsedMs: Date.now() - evaluatedAt,
            retentionCutoff: retentionCutoffIso,
          }),
          collectionStatus: 'complete',
          generations,
        })
        .info('Cloud Agent outcome aggregate');
    } catch {
      logger
        .withFields({
          ...evaluationEnvelope({
            window,
            collectionTimestamp,
            queryElapsedMs: Date.now() - evaluatedAt,
            retentionCutoff: retentionCutoffIso,
          }),
          collectionStatus: 'failed',
          failureKind: 'db_query_failed',
        })
        .error('Cloud Agent outcome aggregate failed');
      return;
    }
  }
}
