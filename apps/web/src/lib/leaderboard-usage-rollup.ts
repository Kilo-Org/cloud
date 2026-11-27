import { sql } from 'drizzle-orm';

import { leaderboard_usage_daily } from '@kilocode/db/schema';
import type { DrizzleDatabase } from '@kilocode/web-shared/lib/drizzle';

/** Complete UTC days before today that the leaderboard routes read. */
export const LEADERBOARD_USAGE_LOOKBACK_DAYS = 7;

/** Runs before this UTC hour rebuild yesterday even when it is already built. */
export const YESTERDAY_SETTLING_HOURS = 6;

/**
 * How long after a day ends before it is first built. Usage-ingest queue
 * retries can write a row ~20 minutes after its `created_at`, so building
 * earlier would publish a day that is visibly short.
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

/**
 * Aggregates one UTC day of usage from `readDb` 15 minutes at a time, then replaces
 * that day's rollup rows on `db` in one transaction. Returns the rows written, or
 * `null` without writing anything when `deadline` passes before the last slice.
 */
export async function rebuildLeaderboardUsageDay(
  usageDate: string,
  { readDb, db, deadline }: { readDb: DrizzleDatabase; db: DrizzleDatabase; deadline?: number }
): Promise<number | null> {
  const dayStartMs = Date.parse(`${usageDate}T00:00:00.000Z`);
  const rows = new Map<string, LeaderboardUsageRow>();

  for (
    let sliceStartMs = dayStartMs;
    sliceStartMs < dayStartMs + DAY_MS;
    sliceStartMs += SLICE_MS
  ) {
    if (deadline !== undefined && Date.now() >= deadline) return null;
    const start = new Date(sliceStartMs).toISOString();
    const end = new Date(sliceStartMs + SLICE_MS).toISOString();
    for (const aggregate of await aggregateSlice(readDb, start, end)) {
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

  return values.length;
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

/**
 * Builds the days in the leaderboard window that have no rollup rows yet,
 * newest first, then rebuilds yesterday during its settling period. A run
 * builds at most `MAX_DAYS_PER_RUN` days and stops at `deadline`, even partway
 * through a day; whatever is left is reported as `remaining` for the next run.
 *
 * Each day is written whole, so the routes never see a partly built day. A day
 * is first built `DAY_SETTLE_MS` after it ends, and only once `readDb` has
 * replayed past that point, because a usage row's `created_at` is stamped when
 * the gateway sends it, before usage-ingest queue retries can delay its write.
 * Stragglers after that are picked up by rebuilding yesterday on every run until
 * `YESTERDAY_SETTLING_HOURS` UTC. Rows landing later, such as dead-letter
 * replays, are not reflected.
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
}): Promise<{ built: { usageDate: string; rows: number }[]; remaining: string[] }> {
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
  const settled = settledLeaderboardUsageDays(window, now, replay.rows[0]?.replayed_at_ms ?? null);
  const yesterday = window[0];
  const rebuildYesterday =
    now.getUTCHours() < YESTERDAY_SETTLING_HOURS &&
    builtDates.has(yesterday) &&
    settled.includes(yesterday);
  const toBuild = [
    ...settled.filter(usageDate => !builtDates.has(usageDate)),
    ...(rebuildYesterday ? [yesterday] : []),
  ];

  const built: { usageDate: string; rows: number }[] = [];
  for (const usageDate of toBuild.slice(0, MAX_DAYS_PER_RUN)) {
    if (Date.now() >= deadline) break;
    const rows = await rebuildLeaderboardUsageDay(usageDate, { readDb, db, deadline });
    if (rows === null) break;
    built.push({ usageDate, rows });
  }

  return {
    built,
    remaining: toBuild.filter(usageDate => !built.some(day => day.usageDate === usageDate)),
  };
}
