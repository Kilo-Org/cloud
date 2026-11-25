import type { User } from '@kilocode/db/schema';
import { CODE_INDEXING_ENABLED_USER_IDS } from '@kilocode/web-shared/lib/config.server';
import { sql } from 'drizzle-orm';

const manuallyEnabledUsers = new Set(
  CODE_INDEXING_ENABLED_USER_IDS.split(',')
    .map(userId => userId.trim())
    .filter(userId => userId.length > 0)
);

export function isEnabledForUser(user: User): boolean {
  // Code indexing is off by default - only admins have access
  if (user.is_admin) {
    return true;
  }

  return manuallyEnabledUsers.has(user.id);
}

/**
 * SQL fragment to calculate storage size in KB from chunk count.
 * Formula: chunks * 256 (embedding dimensions) * 4 (bytes per float) * 1.5 (overhead) / 1024 (bytes to KB)
 * Returns size in kilobytes for better precision on the frontend
 */
export const chunkCountToSizeKbSql = (chunkCountExpression: ReturnType<typeof sql.raw>) =>
  sql`ROUND((${chunkCountExpression} * 256.0 * 4.0 * 1.5 / 1024.0)::numeric, 2)`;
