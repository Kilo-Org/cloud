import { sql, type SQL } from 'drizzle-orm';
import { cli_sessions_v2 } from '@kilocode/db/schema';

/**
 * Moves `last_activity_at` forward only, so concurrent and late writers commute.
 *
 * A sender clock can run ahead of the database, and the list projection treats a
 * future `last_activity_at` as live, so activity is clamped to the database clock.
 */
export function laterLastActivityAt(activityIso: string): SQL {
  const activity = sql`LEAST(${activityIso}::timestamptz, now())`;
  return sql`CASE
    WHEN ${cli_sessions_v2.last_activity_at} IS NULL
      OR ${cli_sessions_v2.last_activity_at} < ${activity}
    THEN ${activity}
    ELSE ${cli_sessions_v2.last_activity_at}
  END`;
}
