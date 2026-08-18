import { like, sql, type Column } from 'drizzle-orm';
import {
  DELETION_IN_PROGRESS_BLOCK_REASON_PREFIX,
  SOFT_DELETED_BLOCK_REASON_PREFIX,
} from './user-soft-delete-reasons';

export * from './user-soft-delete-reasons';

export function goneOrDeletingBlockedReasonSql(column: Column) {
  return sql`(${like(column, `${SOFT_DELETED_BLOCK_REASON_PREFIX}%`)} OR ${like(
    column,
    `${DELETION_IN_PROGRESS_BLOCK_REASON_PREFIX}%`
  )})`;
}
