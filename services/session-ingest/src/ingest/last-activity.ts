import { sql, type SQL } from 'drizzle-orm';
import { cli_sessions_v2 } from '@kilocode/db/schema';

/** Moves `last_activity_at` forward only, so concurrent and late writers commute. */
export function laterLastActivityAt(activityIso: string): SQL {
  return sql`CASE
    WHEN ${cli_sessions_v2.last_activity_at} IS NULL
      OR ${cli_sessions_v2.last_activity_at} < ${activityIso}
    THEN ${activityIso}
    ELSE ${cli_sessions_v2.last_activity_at}
  END`;
}
