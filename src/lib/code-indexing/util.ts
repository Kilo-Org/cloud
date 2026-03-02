import type { User } from '@kilocode/db/schema';
import { sql } from 'drizzle-orm';

const ManuallyEnabledUsers = new Set(['9ff28f58-a37a-4d8a-ad45-bb0c9a4cd229']);

export function isEnabledForUser(user: User): boolean {
  // Code indexing is off by default - only admins have access
  if (user.is_admin) {
    return true;
  }

  return ManuallyEnabledUsers.has(user.id);
}

/**
 * SQL fragment to calculate storage size in KB from chunk count.
 * Formula: chunks * 256 (embedding dimensions) * 4 (bytes per float) * 1.5 (overhead) / 1024 (bytes to KB)
 * Returns size in kilobytes for better precision on the frontend
 */
export const chunkCountToSizeKbSql = (chunkCountExpression: ReturnType<typeof sql.raw>) =>
  sql`ROUND((${chunkCountExpression} * 256.0 * 4.0 * 1.5 / 1024.0)::numeric, 2)`;
