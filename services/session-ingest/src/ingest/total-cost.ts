import { sql, type SQL } from 'drizzle-orm';
import { cli_sessions_v2 } from '@kilocode/db/schema';

/** Moves `total_cost_microdollars` up only, so concurrent and late writers commute. */
export function higherTotalCostMicrodollars(cost: number): SQL {
  return sql`CASE
    WHEN ${cli_sessions_v2.total_cost_microdollars} IS NULL
      OR ${cli_sessions_v2.total_cost_microdollars} < ${cost}
    THEN ${cost}
    ELSE ${cli_sessions_v2.total_cost_microdollars}
  END`;
}
