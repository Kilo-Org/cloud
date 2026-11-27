import { sql } from 'drizzle-orm';

import { leaderboard_usage_daily } from '@kilocode/db/schema';
import type { DrizzleDatabase } from '@kilocode/web-shared/lib/drizzle';
import { errorExceptInTest, logExceptInTest } from '@kilocode/web-shared/lib/utils.server';

/** Complete UTC days before today that the leaderboard routes read. */
export const LEADERBOARD_USAGE_LOOKBACK_DAYS = 7;

/**
 * How long after a day ends before it is built. Usage-ingest queue retries can
 * write a row ~20 minutes after its `created_at`, so building earlier would
 * publish a day that is visibly short. Rows later than this are not counted;
 * to recount a day, delete its rows and the next run rebuilds it.
 */
export const DAY_SETTLE_MS = 60 * 60 * 1000;

/** Days built per run, bounding replica load and the work a killed run loses. */
export const MAX_DAYS_PER_RUN = 2;

const DAY_MS = 24 * 60 * 60 * 1000;
const INSERT_BATCH_SIZE = 1_000;

// A busy hour is ~800k usage rows. A 15-minute slice keeps each read a few
// seconds when warm, and well under the replica's 90s
// `max_standby_streaming_delay` when cold, past which WAL replay may cancel it.
const SLICE_MS = 15 * 60 * 1000;
const SLICE_STATEMENT_TIMEOUT_MS = 60_000;
// The default 32MB spills the usage-side hash join to disk at a busy hour.
const SLICE_WORK_MEM = '128MB';

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

function utcDateString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The complete UTC days in the leaderboard window, newest first, so a run that
 * runs out of time has filled the days most recently added to the window.
 */
export function leaderboardUsageWindow(now: Date): string[] {
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: LEADERBOARD_USAGE_LOOKBACK_DAYS }, (_, index) =>
    utcDateString(todayMs - (index + 1) * DAY_MS)
  );
}

async function aggregateSlice(
  readDb: DrizzleDatabase,
  start: string,
  end: string
): Promise<SliceAggregateRow[]> {
  // The metadata row is written in the same statement as its usage row with the
  // same `created_at`, so bounding both sides by the slice lets the planner range
  // scan each `created_at` index instead of probing metadata by id.
  return await readDb.transaction(async tx => {
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

export type LeaderboardUsageDayBuild = {
  rows: number;
  durationMs: number;
  slices: number;
  slowestSliceMs: number;
};

function postgresErrorCode(error: unknown): string | null {
  let current = error;
  for (let depth = 0; depth < 3 && typeof current === 'object' && current !== null; depth++) {
    if ('code' in current && typeof current.code === 'string') return current.code;
    current = 'cause' in current ? current.cause : undefined;
  }
  return null;
}

/**
 * Aggregates one UTC day of usage from `readDb` 15 minutes at a time, then replaces
 * that day's rollup rows on `db` in one transaction. Returns what was written,
 * or `null` without writing anything when `deadline` passes before the last
 * slice. A failure is logged with the day, the stage and the slice, then rethrown.
 */
export async function rebuildLeaderboardUsageDay(
  usageDate: string,
  { readDb, db, deadline }: { readDb: DrizzleDatabase; db: DrizzleDatabase; deadline?: number }
): Promise<LeaderboardUsageDayBuild | null> {
  const startedAt = Date.now();
  const dayStartMs = Date.parse(`${usageDate}T00:00:00.000Z`);
  const rows = new Map<string, LeaderboardUsageRow>();
  let slices = 0;
  let slowestSliceMs = 0;
  let stage: { name: 'read'; sliceStart: string } | { name: 'write' } | null = null;

  try {
    for (
      let sliceStartMs = dayStartMs;
      sliceStartMs < dayStartMs + DAY_MS;
      sliceStartMs += SLICE_MS
    ) {
      if (deadline !== undefined && Date.now() >= deadline) {
        logExceptInTest(
          JSON.stringify({
            type: 'leaderboard_usage_rollup_day_deadline',
            usageDate,
            slices,
            durationMs: Date.now() - startedAt,
          })
        );
        return null;
      }
      const start = new Date(sliceStartMs).toISOString();
      const end = new Date(sliceStartMs + SLICE_MS).toISOString();
      stage = { name: 'read', sliceStart: start };
      const sliceStartedAt = Date.now();
      const aggregates = await aggregateSlice(readDb, start, end);
      slowestSliceMs = Math.max(slowestSliceMs, Date.now() - sliceStartedAt);
      slices++;
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

    const values = [...rows.values()].map(row => ({ usage_date: usageDate, ...row }));

    stage = { name: 'write' };
    await db.transaction(async tx => {
      // Serializes concurrent rebuilds of the same day, so an overlapping run
      // deletes the first run's committed rows instead of duplicating them.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('leaderboard_usage_daily'), hashtext(${usageDate}))`
      );
      await tx.execute(sql`DELETE FROM leaderboard_usage_daily WHERE usage_date = ${usageDate}`);
      for (let index = 0; index < values.length; index += INSERT_BATCH_SIZE) {
        await tx
          .insert(leaderboard_usage_daily)
          .values(values.slice(index, index + INSERT_BATCH_SIZE));
      }
    });

    const build = {
      rows: values.length,
      durationMs: Date.now() - startedAt,
      slices,
      slowestSliceMs,
    };
    logExceptInTest(JSON.stringify({ type: 'leaderboard_usage_rollup_day', usageDate, ...build }));
    return build;
  } catch (error) {
    // The Postgres code tells a statement timeout (57014) from a replay
    // conflict on the replica (40001). The message is left out: it repeats the
    // query text.
    errorExceptInTest(
      JSON.stringify({
        type: 'leaderboard_usage_rollup_day_failed',
        usageDate,
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

/**
 * The days in `window` that may be built: their settle period has passed, and
 * `readDb` has replayed past it. `replayedAtMs` is null on a primary.
 */
export function settledLeaderboardUsageDays(
  window: string[],
  now: Date,
  replayedAtMs: number | null
): string[] {
  return window.filter(usageDate => {
    const settledAtMs = Date.parse(`${usageDate}T00:00:00.000Z`) + DAY_MS + DAY_SETTLE_MS;
    return now.getTime() >= settledAtMs && (replayedAtMs === null || replayedAtMs >= settledAtMs);
  });
}

export type LeaderboardUsageBuildSummary = {
  built: ({ usageDate: string } & LeaderboardUsageDayBuild)[];
  /** Settled days still unbuilt, left for the next run. */
  remaining: string[];
  /** Unbuilt days that have not settled yet, or that the replica has not replayed past. */
  unsettled: string[];
  /** Days built with no rows, which look missing and are rebuilt every run. */
  emptyDays: string[];
  stoppedBy: 'deadline' | 'cap' | null;
  yesterdayBuilt: boolean;
  /** How far `readDb` trails `now`; null on a primary. */
  replicaLagMs: number | null;
  durationMs: number;
};

/**
 * Builds the days in the leaderboard window that have no rollup rows yet,
 * newest first. A run builds at most `MAX_DAYS_PER_RUN` days and stops at
 * `deadline`, even partway through a day; whatever is left is reported as
 * `remaining` for the next run.
 *
 * Each day is built once and written whole, so the routes never see a partly
 * built day. A day is built `DAY_SETTLE_MS` after it ends, and only once
 * `readDb` has replayed past that point, because a usage row's `created_at` is
 * stamped when the gateway sends it, before usage-ingest queue retries can
 * delay its write.
 */
export async function buildLeaderboardUsageDays({
  readDb,
  db,
  now,
  deadline,
}: {
  readDb: DrizzleDatabase;
  db: DrizzleDatabase;
  now: Date;
  deadline: number;
}): Promise<LeaderboardUsageBuildSummary> {
  const startedAt = Date.now();
  const window = leaderboardUsageWindow(now);
  const existing = await db.execute<{ usage_date: string }>(sql`
    SELECT DISTINCT to_char(usage_date, 'YYYY-MM-DD') AS usage_date
    FROM leaderboard_usage_daily
    WHERE usage_date >= ${window[window.length - 1]} AND usage_date <= ${window[0]}
  `);
  const builtDates = new Set(existing.rows.map(row => row.usage_date));
  // One request keeps one replica, so this is the replica the slices read.
  const replay = await readDb.execute<{ replayed_at_ms: number | null }>(sql`
    SELECT (extract(epoch FROM pg_last_xact_replay_timestamp()) * 1000)::float8 AS replayed_at_ms
  `);
  const replayedAtMs = replay.rows[0]?.replayed_at_ms ?? null;
  const settled = settledLeaderboardUsageDays(window, now, replayedAtMs);
  const toBuild = settled.filter(usageDate => !builtDates.has(usageDate));

  const built: LeaderboardUsageBuildSummary['built'] = [];
  let stoppedBy: LeaderboardUsageBuildSummary['stoppedBy'] = null;
  for (const usageDate of toBuild) {
    if (built.length >= MAX_DAYS_PER_RUN) {
      stoppedBy = 'cap';
      break;
    }
    if (Date.now() >= deadline) {
      stoppedBy = 'deadline';
      break;
    }
    const build = await rebuildLeaderboardUsageDay(usageDate, { readDb, db, deadline });
    if (build === null) {
      stoppedBy = 'deadline';
      break;
    }
    built.push({ usageDate, ...build });
  }

  return {
    built,
    remaining: toBuild.filter(usageDate => !built.some(day => day.usageDate === usageDate)),
    unsettled: window.filter(
      usageDate => !builtDates.has(usageDate) && !settled.includes(usageDate)
    ),
    emptyDays: built.filter(day => day.rows === 0).map(day => day.usageDate),
    stoppedBy,
    yesterdayBuilt: builtDates.has(window[0]) || built.some(day => day.usageDate === window[0]),
    replicaLagMs: replayedAtMs === null ? null : Math.max(0, now.getTime() - replayedAtMs),
    durationMs: Date.now() - startedAt,
  };
}
