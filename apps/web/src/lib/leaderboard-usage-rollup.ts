import { sql } from 'drizzle-orm';

import { leaderboard_usage_daily } from '@kilocode/db/schema';
import type { DrizzleDatabase } from '@kilocode/web-shared/lib/drizzle';

/** Complete UTC days before today that the leaderboard routes read. */
export const LEADERBOARD_USAGE_LOOKBACK_DAYS = 7;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const INSERT_BATCH_SIZE = 1_000;
const HOURLY_READ_STATEMENT_TIMEOUT_MS = 120_000;

type LeaderboardUsageKey = {
  provider: string | null;
  requested_model: string | null;
  model: string | null;
  inference_provider: string | null;
  mode: string | null;
  is_user_byok: boolean | null;
};

type LeaderboardUsageRow = LeaderboardUsageKey & {
  input_tokens: number;
  output_tokens: number;
  cache_hit_tokens: number;
  cost_microdollars: number;
  request_count: number;
  error_count: number;
};

type HourlyAggregateRow = LeaderboardUsageKey & {
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

async function aggregateHour(
  readDb: DrizzleDatabase,
  start: string,
  end: string
): Promise<HourlyAggregateRow[]> {
  // The metadata row is written in the same statement as its usage row with the
  // same `created_at`, so bounding both sides by the hour lets the planner range
  // scan each `created_at` index instead of probing metadata by id.
  return await readDb.transaction(async tx => {
    await tx.execute(
      sql.raw(`SET LOCAL statement_timeout = '${HOURLY_READ_STATEMENT_TIMEOUT_MS}'`)
    );
    const result = await tx.execute<HourlyAggregateRow>(sql`
      SELECT
        mu.provider,
        mu.requested_model,
        mu.model,
        mu.inference_provider,
        md.mode,
        meta.is_user_byok,
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
 * Aggregates one UTC day of usage from `readDb` an hour at a time, then replaces
 * that day's rollup rows on `db` in one transaction. Returns the rows written.
 */
export async function rebuildLeaderboardUsageDay(
  usageDate: string,
  { readDb, db }: { readDb: DrizzleDatabase; db: DrizzleDatabase }
): Promise<number> {
  const dayStartMs = Date.parse(`${usageDate}T00:00:00.000Z`);
  const rows = new Map<string, LeaderboardUsageRow>();

  for (let hour = 0; hour < 24; hour++) {
    const start = new Date(dayStartMs + hour * HOUR_MS).toISOString();
    const end = new Date(dayStartMs + (hour + 1) * HOUR_MS).toISOString();
    for (const aggregate of await aggregateHour(readDb, start, end)) {
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
      await tx.insert(leaderboard_usage_daily).values(values.slice(index, index + INSERT_BATCH_SIZE));
    }
  });

  return values.length;
}

/**
 * Builds every day in the leaderboard window that has no rollup rows yet,
 * newest first, until `deadline`. A built day is never rebuilt: usage rows are
 * inserted as requests finish, so a day is complete once it has ended.
 */
export async function buildMissingLeaderboardUsageDays({
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
  const missing = window.filter(usageDate => !builtDates.has(usageDate));

  const built: { usageDate: string; rows: number }[] = [];
  for (const usageDate of missing) {
    if (Date.now() >= deadline) break;
    built.push({ usageDate, rows: await rebuildLeaderboardUsageDay(usageDate, { readDb, db }) });
  }

  return {
    built,
    remaining: missing.filter(usageDate => !built.some(day => day.usageDate === usageDate)),
  };
}
