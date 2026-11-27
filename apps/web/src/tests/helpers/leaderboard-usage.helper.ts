import { leaderboard_usage_daily } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';

type LeaderboardUsageInsert = typeof leaderboard_usage_daily.$inferInsert;

/** A UTC date `daysAgo` days before today, as `YYYY-MM-DD`. */
export function utcDaysAgo(daysAgo: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo))
    .toISOString()
    .slice(0, 10);
}

/** Inserts rollup rows, defaulting to yesterday's ordinary public usage. */
export async function insertLeaderboardUsage(
  rows: Partial<LeaderboardUsageInsert>[]
): Promise<void> {
  await db.insert(leaderboard_usage_daily).values(
    rows.map(row => ({
      usage_date: utcDaysAgo(1),
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
    }))
  );
}
