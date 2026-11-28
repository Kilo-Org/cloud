import { leaderboard_usage_hourly, leaderboard_usage_hours } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';

type LeaderboardUsageInsert = typeof leaderboard_usage_hourly.$inferInsert;

/** A UTC date `daysAgo` days before today, as `YYYY-MM-DD`. */
export function utcDaysAgo(daysAgo: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo))
    .toISOString()
    .slice(0, 10);
}

/** Records the first `count` hours of a UTC day as built. */
export async function recordLeaderboardHours(usageDate: string, count = 24): Promise<void> {
  await db
    .insert(leaderboard_usage_hours)
    .values(
      Array.from({ length: count }, (_, hour) => ({
        hour_start: new Date(
          Date.parse(`${usageDate}T00:00:00.000Z`) + hour * 3_600_000
        ).toISOString(),
        rows: 0,
      }))
    )
    .onConflictDoNothing();
}

/**
 * Inserts hourly rollup rows, defaulting to noon yesterday with ordinary public
 * usage, and records the first `recordedHours` hours of each day they fall in;
 * all 24 by default, so the day is complete.
 */
export async function insertLeaderboardUsage(
  rows: (Partial<LeaderboardUsageInsert> & { usage_date?: string })[],
  { recordedHours = 24 }: { recordedHours?: number } = {}
): Promise<void> {
  const values = rows.map(({ usage_date = utcDaysAgo(1), ...row }) => ({
    hour_start: `${usage_date}T12:00:00.000Z`,
    provider: 'openrouter',
    requested_model: 'acme/model',
    model: 'acme/model',
    inference_provider: 'acme',
    mode: 'code',
    is_user_byok: false,
    input_tokens: 10_000_000,
    output_tokens: 2_000_000,
    cache_hit_tokens: 0,
    cost_microdollars: 0,
    request_count: 100,
    error_count: 0,
    ...row,
  }));
  await db.insert(leaderboard_usage_hourly).values(values);
  for (const usageDate of new Set(values.map(value => value.hour_start.slice(0, 10)))) {
    await recordLeaderboardHours(usageDate, recordedHours);
  }
}
