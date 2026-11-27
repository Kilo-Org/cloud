import { and, gte, lte, sql } from 'drizzle-orm';

import { leaderboard_usage_hourly, leaderboard_usage_hours } from '@kilocode/db/schema';
import type { DrizzleDatabase } from '@kilocode/web-shared/lib/drizzle';
import { errorExceptInTest, logExceptInTest } from '@kilocode/web-shared/lib/utils.server';

/**
 * How long after an hour ends before it is built. Usage-ingest queue retries
 * can write a row ~20 minutes after its `created_at`, so building earlier would
 * publish an hour that is visibly short. Rows later than this are not counted.
 */
export const HOUR_SETTLE_MS = 60 * 60 * 1000;

/**
 * Only hours that ended this recently are built. Recent usage is still in
 * memory on the primary, while older rows are scattered over cold pages and
 * cost a random read each. An hour missed for this long is left unbuilt, and
 * its day stays off the leaderboard.
 */
export const HOUR_LOOKBACK_MS = 4 * 60 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;
const INSERT_BATCH_SIZE = 1_000;

// A busy hour is ~800k usage rows, so a 5-minute slice reads ~70k and takes
// about 0.2s warm. Slicing keeps each statement short on the primary.
const SLICE_MS = 5 * 60 * 1000;
// A warm hour takes a few seconds. Capping each hour at half the run's budget
// keeps one slow hour, which a later run would restart from scratch, from
// using the whole run and starving the newer, warmer hours after it.
export const HOUR_BUDGET_MS = 100_000;
const SLICE_STATEMENT_TIMEOUT_MS = 60_000;
// The default 32MB spills the usage-side hash join to disk at a busy hour.
const SLICE_WORK_MEM = '128MB';

/**
 * Per-day usage of the complete UTC days in the leaderboard window, the seven
 * days before today, summed from the hourly rows with the same columns plus
 * `usage_date`. Readers filter these day rows, so a per-row filter such as
 * `output_tokens > 0` drops a whole day of a dimension, never single hours.
 * A day is complete once all 24 of its hours are recorded in
 * `leaderboard_usage_hours`, so a day with a missing hour is left out rather
 * than shown short.
 */
export const LEADERBOARD_WINDOW_USAGE_SQL = sql`(
  select
      (hourly.hour_start at time zone 'UTC')::date as usage_date
      , hourly.provider
      , hourly.requested_model
      , hourly.model
      , hourly.inference_provider
      , hourly.mode
      , hourly.is_user_byok
      , sum(hourly.input_tokens) as input_tokens
      , sum(hourly.output_tokens) as output_tokens
      , sum(hourly.cache_hit_tokens) as cache_hit_tokens
      , sum(hourly.cost_microdollars) as cost_microdollars
      , sum(hourly.request_count) as request_count
      , sum(hourly.error_count) as error_count
  from leaderboard_usage_hourly as hourly
  where
      hourly.hour_start >= ((now() at time zone 'UTC')::date - 7)::timestamp at time zone 'UTC'
      and hourly.hour_start < ((now() at time zone 'UTC')::date)::timestamp at time zone 'UTC'
      and (hourly.hour_start at time zone 'UTC')::date in (
          select (hours.hour_start at time zone 'UTC')::date
          from leaderboard_usage_hours as hours
          where
              hours.hour_start >= ((now() at time zone 'UTC')::date - 7)::timestamp at time zone 'UTC'
              and hours.hour_start < ((now() at time zone 'UTC')::date)::timestamp at time zone 'UTC'
          group by 1
          having count(*) = 24
      )
  group by 1, 2, 3, 4, 5, 6, 7
)`;

type LeaderboardUsageKey = {
  provider: string | null;
  requested_model: string | null;
  model: string | null;
  inference_provider: string | null;
  mode: string | null;
  is_user_byok: boolean;
};

type LeaderboardUsageRow = LeaderboardUsageKey & {
  input_tokens: number;
  output_tokens: number;
  cache_hit_tokens: number;
  cost_microdollars: number;
  request_count: number;
  error_count: number;
};

type SliceAggregateRow = LeaderboardUsageKey & {
  input_tokens: string;
  output_tokens: string;
  cache_hit_tokens: string;
  cost_microdollars: string;
  request_count: string;
  error_count: string;
};

/**
 * The hours that may be built at `now`, oldest first, as ISO strings: each has
 * settled for `HOUR_SETTLE_MS` and ended within `HOUR_LOOKBACK_MS`.
 */
export function eligibleLeaderboardUsageHours(now: Date): string[] {
  const latestEndMs = Math.floor((now.getTime() - HOUR_SETTLE_MS) / HOUR_MS) * HOUR_MS;
  const earliestEndMs = now.getTime() - HOUR_LOOKBACK_MS;
  const hours: string[] = [];
  for (let endMs = latestEndMs; endMs >= earliestEndMs; endMs -= HOUR_MS) {
    hours.unshift(new Date(endMs - HOUR_MS).toISOString());
  }
  return hours;
}

async function aggregateSlice(
  db: DrizzleDatabase,
  start: string,
  end: string
): Promise<SliceAggregateRow[]> {
  // The metadata row is written in the same statement as its usage row with the
  // same `created_at`, so bounding both sides by the slice lets the planner range
  // scan each `created_at` index instead of probing metadata by id.
  return await db.transaction(async tx => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${SLICE_STATEMENT_TIMEOUT_MS}'`));
    await tx.execute(sql.raw(`SET LOCAL work_mem = '${SLICE_WORK_MEM}'`));
    const result = await tx.execute<SliceAggregateRow>(sql`
      SELECT
        mu.provider,
        mu.requested_model,
        mu.model,
        mu.inference_provider,
        md.mode,
        COALESCE(meta.is_user_byok, false) AS is_user_byok,
        SUM(mu.input_tokens)::text AS input_tokens,
        SUM(mu.output_tokens)::text AS output_tokens,
        SUM(mu.cache_hit_tokens)::text AS cache_hit_tokens,
        SUM(mu.cost)::text AS cost_microdollars,
        COUNT(*)::text AS request_count,
        COUNT(*) FILTER (WHERE mu.has_error)::text AS error_count
      FROM microdollar_usage mu
      LEFT JOIN microdollar_usage_metadata meta
        ON meta.id = mu.id
        AND meta.created_at >= ${start}
        AND meta.created_at < ${end}
      LEFT JOIN mode md ON md.mode_id = meta.mode_id
      WHERE mu.created_at >= ${start}
        AND mu.created_at < ${end}
      GROUP BY 1, 2, 3, 4, 5, 6
    `);
    return result.rows;
  });
}

function keyOf(row: LeaderboardUsageKey): string {
  return JSON.stringify([
    row.provider,
    row.requested_model,
    row.model,
    row.inference_provider,
    row.mode,
    row.is_user_byok,
  ]);
}

function mergeSlice(rows: Map<string, LeaderboardUsageRow>, aggregates: SliceAggregateRow[]) {
  for (const aggregate of aggregates) {
    const key = keyOf(aggregate);
    const existing = rows.get(key);
    const sums = {
      input_tokens: Number(aggregate.input_tokens),
      output_tokens: Number(aggregate.output_tokens),
      cache_hit_tokens: Number(aggregate.cache_hit_tokens),
      cost_microdollars: Number(aggregate.cost_microdollars),
      request_count: Number(aggregate.request_count),
      error_count: Number(aggregate.error_count),
    };
    if (existing) {
      existing.input_tokens += sums.input_tokens;
      existing.output_tokens += sums.output_tokens;
      existing.cache_hit_tokens += sums.cache_hit_tokens;
      existing.cost_microdollars += sums.cost_microdollars;
      existing.request_count += sums.request_count;
      existing.error_count += sums.error_count;
    } else {
      rows.set(key, {
        provider: aggregate.provider,
        requested_model: aggregate.requested_model,
        model: aggregate.model,
        inference_provider: aggregate.inference_provider,
        mode: aggregate.mode,
        is_user_byok: aggregate.is_user_byok,
        ...sums,
      });
    }
  }
}

export type LeaderboardUsageHourBuild = {
  rows: number;
  durationMs: number;
  slices: number;
  slowestSliceMs: number;
};

/** An hour left unbuilt without writing anything, because `deadline` passed. */
export type LeaderboardUsageHourStop = { stopped: 'deadline' };

function postgresErrorCode(error: unknown): string | null {
  let current = error;
  for (let depth = 0; depth < 3 && typeof current === 'object' && current !== null; depth++) {
    if ('code' in current && typeof current.code === 'string') return current.code;
    current = 'cause' in current ? current.cause : undefined;
  }
  return null;
}

/**
 * Aggregates one UTC hour of usage 5 minutes at a time, then replaces that
 * hour's rollup rows and records the hour in one transaction. `hourStart` is
 * an ISO string on the hour. `deadline` is checked before every slice; an hour
 * stopped by it writes nothing. A failure is logged with the hour, the stage
 * and the slice, then rethrown.
 */
export async function rebuildLeaderboardUsageHour(
  hourStart: string,
  { db, deadline }: { db: DrizzleDatabase; deadline?: number }
): Promise<LeaderboardUsageHourBuild | LeaderboardUsageHourStop> {
  const startedAt = Date.now();
  const hourStartMs = Date.parse(hourStart);
  const rows = new Map<string, LeaderboardUsageRow>();
  let slices = 0;
  let slowestSliceMs = 0;
  let stage: { name: 'read'; sliceStart: string } | { name: 'write' } | null = null;

  try {
    for (let sliceStartMs = hourStartMs; sliceStartMs < hourStartMs + HOUR_MS;) {
      const start = new Date(sliceStartMs).toISOString();
      sliceStartMs += SLICE_MS;
      const end = new Date(sliceStartMs).toISOString();
      stage = { name: 'read', sliceStart: start };
      if (deadline !== undefined && Date.now() >= deadline) {
        logExceptInTest(
          JSON.stringify({
            type: 'leaderboard_usage_rollup_hour_stopped',
            hourStart,
            stopped: 'deadline',
            sliceStart: start,
            slices,
            durationMs: Date.now() - startedAt,
          })
        );
        return { stopped: 'deadline' };
      }
      const readStartedAt = Date.now();
      const aggregates = await aggregateSlice(db, start, end);
      slowestSliceMs = Math.max(slowestSliceMs, Date.now() - readStartedAt);
      slices++;
      mergeSlice(rows, aggregates);
    }

    const values = [...rows.values()].map(row => ({ hour_start: hourStart, ...row }));

    stage = { name: 'write' };
    await db.transaction(async tx => {
      // Serializes concurrent rebuilds of the same hour, so an overlapping run
      // replaces the first run's committed rows instead of failing on the
      // unique constraint. The key is the hour number since the epoch.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('leaderboard_usage_hourly'), (extract(epoch FROM ${hourStart}::timestamptz) / 3600)::int)`
      );
      await tx.execute(sql`DELETE FROM leaderboard_usage_hourly WHERE hour_start = ${hourStart}`);
      for (let index = 0; index < values.length; index += INSERT_BATCH_SIZE) {
        await tx
          .insert(leaderboard_usage_hourly)
          .values(values.slice(index, index + INSERT_BATCH_SIZE));
      }
      await tx
        .insert(leaderboard_usage_hours)
        .values({ hour_start: hourStart, rows: values.length })
        .onConflictDoUpdate({
          target: leaderboard_usage_hours.hour_start,
          set: { rows: values.length, built_at: sql`now()` },
        });
    });

    const build = {
      rows: values.length,
      durationMs: Date.now() - startedAt,
      slices,
      slowestSliceMs,
    };
    logExceptInTest(JSON.stringify({ type: 'leaderboard_usage_rollup_hour', hourStart, ...build }));
    return build;
  } catch (error) {
    // The Postgres code tells a statement timeout (57014) from other failures.
    // The message is left out: it repeats the query text.
    errorExceptInTest(
      JSON.stringify({
        type: 'leaderboard_usage_rollup_hour_failed',
        hourStart,
        stage: stage?.name ?? null,
        sliceStart: stage?.name === 'read' ? stage.sliceStart : null,
        slicesCompleted: slices,
        durationMs: Date.now() - startedAt,
        errorName: error instanceof Error ? error.name : typeof error,
        postgresCode: postgresErrorCode(error),
      })
    );
    throw error;
  }
}

export type LeaderboardUsageBuildSummary = {
  built: ({ hourStart: string } & LeaderboardUsageHourBuild)[];
  /** Hours whose build threw; each is logged and retried by the next run. */
  failed: string[];
  /** Hours that ran out of `HOUR_BUDGET_MS`; each is retried by the next run. */
  overBudget: string[];
  /** Eligible hours not attempted, or cut off by `deadline`, left for the next run. */
  remaining: string[];
  stoppedBy: 'deadline' | null;
  durationMs: number;
};

/**
 * Builds the eligible hours that are not recorded in `leaderboard_usage_hours`
 * yet, oldest first, stopping at `deadline`, even partway through an hour.
 * Each hour is built once and written whole, so readers never see a partly
 * built hour. Neither a failed hour nor one that runs out of `HOUR_BUDGET_MS`
 * stops the run, so one bad hour cannot keep newer hours from being built
 * while they are warm.
 * Reads and writes go to `db`, the primary, where recent usage is warm.
 */
export async function buildLeaderboardUsageHours({
  db,
  now,
  deadline,
}: {
  db: DrizzleDatabase;
  now: Date;
  deadline: number;
}): Promise<LeaderboardUsageBuildSummary> {
  const startedAt = Date.now();
  const eligible = eligibleLeaderboardUsageHours(now);
  const recorded =
    eligible.length === 0
      ? []
      : await db
          .select({ hour_start: leaderboard_usage_hours.hour_start })
          .from(leaderboard_usage_hours)
          .where(
            and(
              gte(leaderboard_usage_hours.hour_start, eligible[0]),
              lte(leaderboard_usage_hours.hour_start, eligible[eligible.length - 1])
            )
          );
  const recordedMs = new Set(recorded.map(row => Date.parse(row.hour_start)));
  const toBuild = eligible.filter(hourStart => !recordedMs.has(Date.parse(hourStart)));

  const built: LeaderboardUsageBuildSummary['built'] = [];
  const failed: string[] = [];
  const overBudget: string[] = [];
  let attempted = 0;
  let stoppedBy: LeaderboardUsageBuildSummary['stoppedBy'] = null;
  for (const hourStart of toBuild) {
    if (Date.now() >= deadline) {
      stoppedBy = 'deadline';
      break;
    }
    const hourDeadline = Math.min(deadline, Date.now() + HOUR_BUDGET_MS);
    let build: LeaderboardUsageHourBuild | LeaderboardUsageHourStop;
    try {
      build = await rebuildLeaderboardUsageHour(hourStart, { db, deadline: hourDeadline });
    } catch {
      // Already logged with its slice and Postgres code.
      failed.push(hourStart);
      attempted++;
      continue;
    }
    if ('stopped' in build) {
      if (Date.now() >= deadline) {
        stoppedBy = 'deadline';
        break;
      }
      overBudget.push(hourStart);
    } else {
      built.push({ hourStart, ...build });
    }
    attempted++;
  }

  return {
    built,
    failed,
    overBudget,
    remaining: toBuild.slice(attempted),
    stoppedBy,
    durationMs: Date.now() - startedAt,
  };
}
