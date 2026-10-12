import { and, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { cloud_agent_code_review_attempts, cloud_agent_code_reviews } from '@kilocode/db/schema';
import {
  CODE_REVIEW_BENIGN_TERMINAL_REASONS,
  CODE_REVIEW_TERMINAL_REASONS,
} from '@kilocode/db/schema-types';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  NON_TERMINAL_CODE_REVIEW_STATUSES,
  STALE_QUEUED_CODE_REVIEW_MINUTES,
  staleQueuedCodeReviewCutoffSql,
  staleRunningCodeReviewCutoffSql,
} from '@/lib/code-reviews/dispatch/dispatch-constants';

export const REVIEW_OUTCOME_METRIC = 'review_outcome';
export const REVIEW_REASON_METRIC = 'review_reason';
export const REVIEW_START_METRIC = 'review_start';
export const REVIEW_OPEN_METRIC = 'review_open';
export const REVIEW_PUBLICATION_METRIC = 'review_publication';
export const REVIEW_COLLECTION_METRIC = 'collection';

export const REVIEW_BUCKET_MINUTES = 5;
const REVIEW_BUCKET_MS = REVIEW_BUCKET_MINUTES * 60_000;
const REVIEW_REPORTING_DELAY_ALLOWANCE_MS = 2 * 60_000;

export type CodeReviewCollectionStatus = 'complete' | 'failed';
export type ReviewWindow = { start: string; end: string };
export type ReviewReasonClass = 'benign' | 'system' | 'unknown';

const TERMINAL_REVIEW_STATUSES = ['completed', 'failed', 'cancelled', 'interrupted'] as const;
type TerminalReviewStatus = (typeof TERMINAL_REVIEW_STATUSES)[number];

const KNOWN_REASON_SET: ReadonlySet<string> = new Set(CODE_REVIEW_TERMINAL_REASONS);
const BENIGN_REASON_SET: ReadonlySet<string> = new Set(CODE_REVIEW_BENIGN_TERMINAL_REASONS);

type StatusReasonRow = {
  status: string;
  terminalReason: string | null;
  rowCount: number;
  durationCount: number;
  durationMs: number;
};
type StartedLatencyRow = {
  startedSampleCount: number;
  startedWithinFiveMinutes: number;
  p95WaitMs: number | null;
};
type OpenCountsRow = {
  pendingCount: number;
  pendingOverFiveMinutes: number;
  oldestPendingAgeMs: number | null;
  staleQueuedClaimCount: number;
  runningOverNinetyMinutes: number;
};
type PublicationCountsRow = {
  missingPublication: number;
  coverageUnknown: number;
};

export type ReviewOutcomeHeadline = {
  completed: number;
  failed: number;
  cancelled: number;
  interrupted: number;
};

export type ReviewReasonRow = {
  reason: string;
  reasonClass: ReviewReasonClass;
  count: number;
};

type Database = typeof db;

const waitMsExpression = sql`(extract(epoch from (${cloud_agent_code_reviews.started_at} - ${cloud_agent_code_reviews.created_at})) * 1000)`;
const startedWithinFiveMinutesMs = STALE_QUEUED_CODE_REVIEW_MINUTES * 60_000;

const reviewEnvironment = () => process.env.VERCEL_ENV ?? null;

export function reviewOutcomeStatusQuery(database: Database, window: ReviewWindow) {
  return database
    .select({
      status: cloud_agent_code_reviews.status,
      terminalReason: cloud_agent_code_reviews.terminal_reason,
      rowCount: sql<number>`count(*)::int`,
      durationCount: sql<number>`(count(*) filter (where ${cloud_agent_code_reviews.status} = 'completed' and ${cloud_agent_code_reviews.started_at} is not null and ${cloud_agent_code_reviews.completed_at} >= ${cloud_agent_code_reviews.started_at}))::int`,
      durationMs: sql<number>`(coalesce(sum(extract(epoch from (${cloud_agent_code_reviews.completed_at} - ${cloud_agent_code_reviews.started_at})) * 1000) filter (where ${cloud_agent_code_reviews.status} = 'completed' and ${cloud_agent_code_reviews.started_at} is not null and ${cloud_agent_code_reviews.completed_at} >= ${cloud_agent_code_reviews.started_at}), 0))::double precision`,
    })
    .from(cloud_agent_code_reviews)
    .where(
      and(
        gte(cloud_agent_code_reviews.completed_at, window.start),
        lt(cloud_agent_code_reviews.completed_at, window.end)
      )
    )
    .groupBy(cloud_agent_code_reviews.status, cloud_agent_code_reviews.terminal_reason);
}

async function selectStatusReasonRows(
  database: Database,
  window: ReviewWindow
): Promise<StatusReasonRow[]> {
  return reviewOutcomeStatusQuery(database, window);
}

export function reviewStartedLatencyQuery(database: Database, window: ReviewWindow) {
  return database
    .select({
      startedSampleCount: sql<number>`(count(*) filter (where ${cloud_agent_code_reviews.started_at} >= ${cloud_agent_code_reviews.created_at}))::int`,
      startedWithinFiveMinutes: sql<number>`(count(*) filter (where ${cloud_agent_code_reviews.started_at} >= ${cloud_agent_code_reviews.created_at} and ${waitMsExpression} <= ${startedWithinFiveMinutesMs}))::int`,
      p95WaitMs: sql<
        number | null
      >`(percentile_cont(0.95) within group (order by ${waitMsExpression}) filter (where ${cloud_agent_code_reviews.started_at} >= ${cloud_agent_code_reviews.created_at}))::double precision`,
    })
    .from(cloud_agent_code_reviews)
    .where(
      and(
        gte(cloud_agent_code_reviews.started_at, window.start),
        lt(cloud_agent_code_reviews.started_at, window.end)
      )
    );
}

async function selectStartedLatency(
  database: Database,
  window: ReviewWindow
): Promise<StartedLatencyRow> {
  const [row] = await reviewStartedLatencyQuery(database, window);
  return {
    startedSampleCount: row?.startedSampleCount ?? 0,
    startedWithinFiveMinutes: row?.startedWithinFiveMinutes ?? 0,
    p95WaitMs: row?.p95WaitMs ?? null,
  };
}

export function reviewOpenCountsQuery(database: Database) {
  return database
    .select({
      pendingCount: sql<number>`(count(*) filter (where ${cloud_agent_code_reviews.status} = 'pending'))::int`,
      pendingOverFiveMinutes: sql<number>`(count(*) filter (where ${cloud_agent_code_reviews.status} = 'pending' and ${cloud_agent_code_reviews.created_at} < ${staleQueuedCodeReviewCutoffSql()}))::int`,
      oldestPendingAgeMs: sql<
        number | null
      >`(extract(epoch from (now() - (min(${cloud_agent_code_reviews.created_at}) filter (where ${cloud_agent_code_reviews.status} = 'pending')))) * 1000)::double precision`,
      staleQueuedClaimCount: sql<number>`(count(*) filter (where ${cloud_agent_code_reviews.status} = 'queued' and ${cloud_agent_code_reviews.updated_at} < ${staleQueuedCodeReviewCutoffSql()}))::int`,
      runningOverNinetyMinutes: sql<number>`(count(*) filter (where ${cloud_agent_code_reviews.status} = 'running' and coalesce(${cloud_agent_code_reviews.started_at}, ${cloud_agent_code_reviews.updated_at}, ${cloud_agent_code_reviews.created_at}) < ${staleRunningCodeReviewCutoffSql()}))::int`,
    })
    .from(cloud_agent_code_reviews)
    .where(inArray(cloud_agent_code_reviews.status, [...NON_TERMINAL_CODE_REVIEW_STATUSES]));
}

async function selectOpenCounts(database: Database): Promise<OpenCountsRow> {
  const [row] = await reviewOpenCountsQuery(database);
  return {
    pendingCount: row?.pendingCount ?? 0,
    pendingOverFiveMinutes: row?.pendingOverFiveMinutes ?? 0,
    oldestPendingAgeMs: row?.oldestPendingAgeMs ?? null,
    staleQueuedClaimCount: row?.staleQueuedClaimCount ?? 0,
    runningOverNinetyMinutes: row?.runningOverNinetyMinutes ?? 0,
  };
}

export function reviewTerminalMissingOutcomeTimeQuery(database: Database) {
  return database
    .select({ terminalMissingOutcomeTime: sql<number>`count(*)::int` })
    .from(cloud_agent_code_reviews)
    .where(
      and(
        inArray(cloud_agent_code_reviews.status, [...TERMINAL_REVIEW_STATUSES]),
        isNull(cloud_agent_code_reviews.completed_at)
      )
    );
}

async function selectTerminalMissingOutcomeTime(database: Database): Promise<number> {
  const [row] = await reviewTerminalMissingOutcomeTimeQuery(database);
  return row?.terminalMissingOutcomeTime ?? 0;
}

export function reviewPublicationQuery(database: Database, window: ReviewWindow) {
  return database
    .select({
      missingPublication: sql<number>`(count(*) filter (where ${cloud_agent_code_review_attempts.publication_status} = 'missing'))::int`,
      coverageUnknown: sql<number>`(count(*) filter (where ${cloud_agent_code_review_attempts.id} is null or ${cloud_agent_code_review_attempts.publication_status} is null or ${cloud_agent_code_review_attempts.publication_status} = 'unknown'))::int`,
    })
    .from(cloud_agent_code_reviews)
    .leftJoin(
      cloud_agent_code_review_attempts,
      sql`${cloud_agent_code_review_attempts.code_review_id} = ${cloud_agent_code_reviews.id} and ${cloud_agent_code_review_attempts.attempt_number} = (select max(latest_attempt.attempt_number) from cloud_agent_code_review_attempts latest_attempt where latest_attempt.code_review_id = ${cloud_agent_code_reviews.id})`
    )
    .where(
      and(
        eq(cloud_agent_code_reviews.status, 'completed'),
        gte(cloud_agent_code_reviews.completed_at, window.start),
        lt(cloud_agent_code_reviews.completed_at, window.end)
      )
    );
}

async function selectPublicationCounts(
  database: Database,
  window: ReviewWindow
): Promise<PublicationCountsRow> {
  const [row] = await reviewPublicationQuery(database, window);
  return {
    missingPublication: row?.missingPublication ?? 0,
    coverageUnknown: row?.coverageUnknown ?? 0,
  };
}

function isTerminalStatus(status: string): status is TerminalReviewStatus {
  return (TERMINAL_REVIEW_STATUSES as readonly string[]).includes(status);
}

export function classifyReviewReason(reason: string): ReviewReasonClass {
  if (BENIGN_REASON_SET.has(reason)) return 'benign';
  if (reason === 'unknown' || reason === 'unrecognized') return 'unknown';
  return 'system';
}

export function assembleReviewOutcome(rows: StatusReasonRow[]): {
  headline: ReviewOutcomeHeadline;
  reasons: ReviewReasonRow[];
  durationCount: number;
  durationMs: number;
} {
  const headline: ReviewOutcomeHeadline = {
    completed: 0,
    failed: 0,
    cancelled: 0,
    interrupted: 0,
  };
  let unrecognizedCount = 0;
  let durationCount = 0;
  let durationMs = 0;
  const reasonTallies = new Map<string, number>();

  for (const row of rows) {
    if (!isTerminalStatus(row.status)) continue;
    headline[row.status] += row.rowCount;
    durationCount += Number(row.durationCount);
    durationMs += Number(row.durationMs);
    if (row.status === 'completed') continue;
    if (row.terminalReason === null || !KNOWN_REASON_SET.has(row.terminalReason)) {
      unrecognizedCount += row.rowCount;
    } else {
      reasonTallies.set(
        row.terminalReason,
        (reasonTallies.get(row.terminalReason) ?? 0) + row.rowCount
      );
    }
  }

  const reasons: ReviewReasonRow[] = [];
  for (const [reason, count] of reasonTallies) {
    if (count > 0) reasons.push({ reason, reasonClass: classifyReviewReason(reason), count });
  }
  if (unrecognizedCount > 0) {
    reasons.push({ reason: 'unrecognized', reasonClass: 'unknown', count: unrecognizedCount });
  }
  reasons.sort((left, right) =>
    left.reason < right.reason ? -1 : left.reason > right.reason ? 1 : 0
  );

  return { headline, reasons, durationCount, durationMs };
}

export function reviewWindow(now: Date): ReviewWindow {
  const endMs =
    Math.floor((now.getTime() - REVIEW_REPORTING_DELAY_ALLOWANCE_MS) / REVIEW_BUCKET_MS) *
    REVIEW_BUCKET_MS;
  return {
    start: new Date(endMs - REVIEW_BUCKET_MS).toISOString(),
    end: new Date(endMs).toISOString(),
  };
}

async function collectReviewOutcome(
  observedAt: string,
  window: ReviewWindow,
  database: Database
): Promise<CodeReviewCollectionStatus> {
  try {
    const rows = await selectStatusReasonRows(database, window);
    const { headline, reasons, durationCount, durationMs } = assembleReviewOutcome(rows);
    console.log(
      JSON.stringify({
        metric: REVIEW_OUTCOME_METRIC,
        environment: reviewEnvironment(),
        observedAt,
        windowStart: window.start,
        windowEnd: window.end,
        ...headline,
        durationCount,
        durationMs,
      })
    );
    for (const reason of reasons) {
      console.log(
        JSON.stringify({
          metric: REVIEW_REASON_METRIC,
          environment: reviewEnvironment(),
          observedAt,
          windowStart: window.start,
          windowEnd: window.end,
          ...reason,
        })
      );
    }
    return 'complete';
  } catch {
    console.error(
      JSON.stringify({
        metric: REVIEW_COLLECTION_METRIC,
        collector: REVIEW_OUTCOME_METRIC,
        environment: reviewEnvironment(),
        observedAt,
        status: 'failed',
      })
    );
    return 'failed';
  }
}

async function collectReviewStart(
  observedAt: string,
  window: ReviewWindow,
  database: Database
): Promise<CodeReviewCollectionStatus> {
  try {
    const latency = await selectStartedLatency(database, window);
    console.log(
      JSON.stringify({
        metric: REVIEW_START_METRIC,
        environment: reviewEnvironment(),
        observedAt,
        windowStart: window.start,
        windowEnd: window.end,
        started: latency.startedSampleCount,
        startedWithinFiveMinutes: latency.startedWithinFiveMinutes,
        p95WaitMs: latency.p95WaitMs,
      })
    );
    return 'complete';
  } catch {
    console.error(
      JSON.stringify({
        metric: REVIEW_COLLECTION_METRIC,
        collector: REVIEW_START_METRIC,
        environment: reviewEnvironment(),
        observedAt,
        status: 'failed',
      })
    );
    return 'failed';
  }
}

async function collectReviewPublication(
  observedAt: string,
  window: ReviewWindow,
  database: Database
): Promise<CodeReviewCollectionStatus> {
  try {
    const counts = await selectPublicationCounts(database, window);
    console.log(
      JSON.stringify({
        metric: REVIEW_PUBLICATION_METRIC,
        environment: reviewEnvironment(),
        observedAt,
        windowStart: window.start,
        windowEnd: window.end,
        missingPublication: counts.missingPublication,
        coverageUnknown: counts.coverageUnknown,
      })
    );
    return 'complete';
  } catch {
    console.error(
      JSON.stringify({
        metric: REVIEW_COLLECTION_METRIC,
        collector: REVIEW_PUBLICATION_METRIC,
        environment: reviewEnvironment(),
        observedAt,
        status: 'failed',
      })
    );
    return 'failed';
  }
}

export async function collectCodeReviewOutcome(
  now = new Date(),
  database: Database = db
): Promise<CodeReviewCollectionStatus> {
  const observedAt = now.toISOString();
  const window = reviewWindow(now);
  const outcomeStatus = await collectReviewOutcome(observedAt, window, database);
  const startStatus = await collectReviewStart(observedAt, window, database);
  const publicationStatus = await collectReviewPublication(observedAt, window, database);
  return outcomeStatus === 'complete' &&
    startStatus === 'complete' &&
    publicationStatus === 'complete'
    ? 'complete'
    : 'failed';
}

export async function collectCodeReviewOpenStock(
  now = new Date(),
  database: Database = db
): Promise<CodeReviewCollectionStatus> {
  const observedAt = now.toISOString();
  try {
    const counts = await selectOpenCounts(database);
    const missingCompletedAt = await selectTerminalMissingOutcomeTime(database);
    console.log(
      JSON.stringify({
        metric: REVIEW_OPEN_METRIC,
        environment: reviewEnvironment(),
        observedAt,
        pending: counts.pendingCount,
        pendingOverFiveMinutes: counts.pendingOverFiveMinutes,
        oldestPendingAgeMs: counts.oldestPendingAgeMs,
        staleQueued: counts.staleQueuedClaimCount,
        runningOverNinetyMinutes: counts.runningOverNinetyMinutes,
        missingCompletedAt,
      })
    );
    return 'complete';
  } catch {
    console.error(
      JSON.stringify({
        metric: REVIEW_COLLECTION_METRIC,
        collector: REVIEW_OPEN_METRIC,
        environment: reviewEnvironment(),
        observedAt,
        status: 'failed',
      })
    );
    return 'failed';
  }
}
