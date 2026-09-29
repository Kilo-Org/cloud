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
import { retentionCutoff } from './report-store.js';

// Provisional: not yet measured against production reporting lag.
export const REPORTING_DELAY_ALLOWANCE_MS = 2 * 60 * 1000;
export const OUTCOME_BUCKET_MINUTES = 5;
const OUTCOME_BUCKET_MS = OUTCOME_BUCKET_MINUTES * 60 * 1000;

export const EXPECTED_GENERATIONS = ['legacy', 'control'] as const;
export const EXPECTED_ROLES = ['initial', 'follow_up'] as const;
export const PRODUCT_ORIGINS = ['code-review', 'other', 'unknown'] as const;

export const AGENT_EXECUTION_METRIC = 'agent_execution';
export const AGENT_FAILURE_METRIC = 'agent_failure';
export const AGENT_SETUP_FAILURE_METRIC = 'agent_setup_failure';
export const AGENT_OPEN_METRIC = 'agent_open';
export const COLLECTION_METRIC = 'collection';

export type OutcomeGeneration = (typeof EXPECTED_GENERATIONS)[number];
export type OutcomeRole = (typeof EXPECTED_ROLES)[number];
export type ProductOrigin = (typeof PRODUCT_ORIGINS)[number];
export type FailureResponsibility = 'platform' | 'provider' | 'user' | 'unknown';

export type OutcomeWindow = { start: string; end: string };

export type RunCountRow = {
  generation: OutcomeGeneration;
  role: OutcomeRole;
  origin: ProductOrigin;
  status: CloudAgentSessionRunStatus;
  responsibility: FailureResponsibility;
  failureStage: string;
  failureCode: string;
  failureReason: string;
  runCount: number;
};

export type SessionSetupFailureRow = {
  generation: OutcomeGeneration;
  origin: ProductOrigin;
  failureStage: string;
  failureCode: string;
  failureCount: number;
};

export type OutcomeAggregate = {
  runCounts: RunCountRow[];
  sessionSetupFailures: SessionSetupFailureRow[];
};

export type AgentExecutionHeadline = {
  generation: OutcomeGeneration;
  role: OutcomeRole;
  productOrigin: ProductOrigin;
  completed: number;
  platformFailed: number;
  providerFailed: number;
  userFailed: number;
  unknownFailed: number;
  interrupted: number;
};

export type AgentFailureRow = {
  generation: OutcomeGeneration;
  role: OutcomeRole;
  productOrigin: ProductOrigin;
  responsibility: FailureResponsibility;
  stage: string;
  code: string;
  reason: string;
  count: number;
};

export type AgentSetupFailureRecord = {
  generation: OutcomeGeneration;
  productOrigin: ProductOrigin;
  stage: string;
  code: string;
  count: number;
};

type DatabaseTransaction = Parameters<Parameters<WorkerDb['transaction']>[0]>[0];

export const originBucketExpression: SQL<ProductOrigin> = sql<ProductOrigin>`case when ${cloud_agent_sessions.product_origin} = 'code-review' then 'code-review' when ${cloud_agent_sessions.product_origin} = 'other' then 'other' else 'unknown' end`;

const unknownResponsibilityCondition: SQL = sql`(${cloud_agent_session_runs.failure_responsibility} is null or ${cloud_agent_session_runs.failure_responsibility} not in ('platform', 'provider', 'user'))`;

export function generationExpression(sessionId: AnyColumn): SQL<OutcomeGeneration> {
  return sql<OutcomeGeneration>`case when left(${sessionId}, ${CONTROL_PLANE_SESSION_PREFIX.length}) = ${CONTROL_PLANE_SESSION_PREFIX} then 'control' else 'legacy' end`;
}

const roleExpression: SQL<OutcomeRole> = sql<OutcomeRole>`case when ${cloud_agent_session_runs.message_id} = ${cloud_agent_sessions.initial_message_id} then 'initial' else 'follow_up' end`;

const responsibilityBucketExpression: SQL<FailureResponsibility> = sql<FailureResponsibility>`case when ${unknownResponsibilityCondition} then 'unknown' else ${cloud_agent_session_runs.failure_responsibility} end`;

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

function readRunCounts(
  tx: DatabaseTransaction,
  window: OutcomeWindow,
  retentionCutoffIso: string
): Promise<RunCountRow[]> {
  return tx
    .select({
      generation: generationExpression(cloud_agent_session_runs.cloud_agent_session_id),
      role: roleExpression,
      origin: originBucketExpression,
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
    .groupBy(sql`1`, sql`2`, sql`3`, sql`4`, sql`5`, sql`6`, sql`7`, sql`8`);
}

function readSessionSetupFailures(
  tx: DatabaseTransaction,
  window: OutcomeWindow,
  retentionCutoffIso: string
): Promise<SessionSetupFailureRow[]> {
  return tx
    .select({
      generation: generationExpression(cloud_agent_sessions.cloud_agent_session_id),
      origin: originBucketExpression,
      failureStage: sessionFailureStageExpression,
      failureCode: sessionFailureCodeExpression,
      failureCount: sql<number>`count(*)::int`,
    })
    .from(cloud_agent_sessions)
    .where(retainedWindow(cloud_agent_sessions.failure_at, window, retentionCutoffIso))
    .groupBy(sql`1`, sql`2`, sql`3`, sql`4`);
}

export function executionOutcomeWindow(now: Date): OutcomeWindow {
  const endMs =
    Math.floor((now.getTime() - REPORTING_DELAY_ALLOWANCE_MS) / OUTCOME_BUCKET_MS) *
    OUTCOME_BUCKET_MS;
  return {
    start: new Date(endMs - OUTCOME_BUCKET_MS).toISOString(),
    end: new Date(endMs).toISOString(),
  };
}

export function assembleExecutionHeadlines(runCounts: RunCountRow[]): AgentExecutionHeadline[] {
  const headlines: AgentExecutionHeadline[] = [];
  for (const generation of EXPECTED_GENERATIONS) {
    for (const role of EXPECTED_ROLES) {
      for (const productOrigin of PRODUCT_ORIGINS) {
        const headline: AgentExecutionHeadline = {
          generation,
          role,
          productOrigin,
          completed: 0,
          platformFailed: 0,
          providerFailed: 0,
          userFailed: 0,
          unknownFailed: 0,
          interrupted: 0,
        };
        for (const row of runCounts) {
          if (row.generation !== generation || row.role !== role || row.origin !== productOrigin) {
            continue;
          }
          if (row.status === 'completed') headline.completed += row.runCount;
          else if (row.status === 'interrupted') headline.interrupted += row.runCount;
          else if (row.status === 'failed') {
            if (row.responsibility === 'platform') headline.platformFailed += row.runCount;
            else if (row.responsibility === 'provider') headline.providerFailed += row.runCount;
            else if (row.responsibility === 'user') headline.userFailed += row.runCount;
            else headline.unknownFailed += row.runCount;
          }
        }
        headlines.push(headline);
      }
    }
  }
  return headlines;
}

function compareByOrigin(
  left: { generation: string; productOrigin: string },
  right: { generation: string; productOrigin: string }
): number {
  const byGeneration =
    left.generation < right.generation ? -1 : left.generation > right.generation ? 1 : 0;
  if (byGeneration !== 0) return byGeneration;
  const leftOrigin = PRODUCT_ORIGINS.indexOf(left.productOrigin as ProductOrigin);
  const rightOrigin = PRODUCT_ORIGINS.indexOf(right.productOrigin as ProductOrigin);
  return leftOrigin - rightOrigin;
}

export function assembleFailureRows(runCounts: RunCountRow[]): AgentFailureRow[] {
  return runCounts
    .filter(row => row.status === 'failed' && row.runCount > 0)
    .map(row => ({
      generation: row.generation,
      role: row.role,
      productOrigin: row.origin,
      responsibility: row.responsibility,
      stage: row.failureStage,
      code: row.failureCode,
      reason: row.failureReason,
      count: row.runCount,
    }))
    .sort((left, right) => {
      const byOrigin = compareByOrigin(left, right);
      if (byOrigin !== 0) return byOrigin;
      if (left.role !== right.role) return left.role < right.role ? -1 : 1;
      if (left.responsibility !== right.responsibility) {
        return left.responsibility < right.responsibility ? -1 : 1;
      }
      if (left.stage !== right.stage) return left.stage < right.stage ? -1 : 1;
      if (left.code !== right.code) return left.code < right.code ? -1 : 1;
      return left.reason < right.reason ? -1 : left.reason > right.reason ? 1 : 0;
    });
}

export function assembleSetupFailureRows(
  rows: SessionSetupFailureRow[]
): AgentSetupFailureRecord[] {
  return rows
    .filter(row => row.failureCount > 0)
    .map(row => ({
      generation: row.generation,
      productOrigin: row.origin,
      stage: row.failureStage,
      code: row.failureCode,
      count: row.failureCount,
    }))
    .sort((left, right) => {
      const byOrigin = compareByOrigin(left, right);
      if (byOrigin !== 0) return byOrigin;
      if (left.stage !== right.stage) return left.stage < right.stage ? -1 : 1;
      return left.code < right.code ? -1 : left.code > right.code ? 1 : 0;
    });
}

export function readOutcomeAggregate(
  db: WorkerDb,
  input: { window: OutcomeWindow; retentionCutoff: string }
): Promise<OutcomeAggregate> {
  return db.transaction(
    async tx => {
      const runCounts = await readRunCounts(tx, input.window, input.retentionCutoff);
      const sessionSetupFailures = await readSessionSetupFailures(
        tx,
        input.window,
        input.retentionCutoff
      );
      return { runCounts, sessionSetupFailures };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' }
  );
}

function emitExecutionAggregate(
  aggregate: OutcomeAggregate,
  observedAt: string,
  window: OutcomeWindow
): void {
  for (const headline of assembleExecutionHeadlines(aggregate.runCounts)) {
    logger
      .withFields({
        metric: AGENT_EXECUTION_METRIC,
        observedAt,
        windowStart: window.start,
        windowEnd: window.end,
        ...headline,
      })
      .info('Cloud Agent execution outcome');
  }
  for (const row of assembleFailureRows(aggregate.runCounts)) {
    logger
      .withFields({
        metric: AGENT_FAILURE_METRIC,
        observedAt,
        windowStart: window.start,
        windowEnd: window.end,
        ...row,
      })
      .info('Cloud Agent execution failure');
  }
  for (const row of assembleSetupFailureRows(aggregate.sessionSetupFailures)) {
    logger
      .withFields({
        metric: AGENT_SETUP_FAILURE_METRIC,
        observedAt,
        windowStart: window.start,
        windowEnd: window.end,
        ...row,
      })
      .info('Cloud Agent session setup failure');
  }
}

export async function runCloudAgentOutcomeCollection(
  env: Env,
  now = new Date(),
  scheduledTime?: number
): Promise<void> {
  const observedAt = now.toISOString();
  const retentionCutoffIso = retentionCutoff(observedAt);
  const window = executionOutcomeWindow(new Date(scheduledTime ?? now.getTime()));

  try {
    const aggregate = await readOutcomeAggregate(getPgDb(env), {
      window,
      retentionCutoff: retentionCutoffIso,
    });
    emitExecutionAggregate(aggregate, observedAt, window);
  } catch {
    logger
      .withFields({
        metric: COLLECTION_METRIC,
        collector: AGENT_EXECUTION_METRIC,
        observedAt,
        status: 'failed',
      })
      .error('Cloud Agent execution outcome collection failed');
  }
}
