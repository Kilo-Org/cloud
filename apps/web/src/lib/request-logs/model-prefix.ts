import { microdollar_usage } from '@kilocode/db/schema';
import { like, sql } from 'drizzle-orm';
import { escapeLikePattern } from '@/lib/sql-like';

/** Matches the model the client asked for, falling back to the served model. */
export function microdollarUsageModelStartsWith(prefix: string) {
  return like(
    sql`coalesce(${microdollar_usage.requested_model}, ${microdollar_usage.model})`,
    `${escapeLikePattern(prefix)}%`
  );
}
