import { like, sql, type Column } from 'drizzle-orm';
import { GONE_OR_DELETING_BLOCK_REASON_PREFIXES } from './user-soft-delete-reasons';

// Server path: this module imports drizzle-orm. Browser code must import
// `@kilocode/db/user-soft-delete-reasons` instead.
export * from './user-soft-delete-reasons';

/**
 * The SQL form of `isGoneOrDeletingBlockedReason`: one literal prefix match per entry
 * of the shared prefix list, so both predicates always cover the same set.
 */
export function goneOrDeletingBlockedReasonSql(column: Column) {
  return sql`(${sql.join(
    GONE_OR_DELETING_BLOCK_REASON_PREFIXES.map(prefix => like(column, `${prefix}%`)),
    sql` OR `
  )})`;
}
