import { and, isNull } from 'drizzle-orm';
import { kilocode_users } from '@kilocode/db/schema';

/**
 * The account availability condition for a SQL join against `kilocode_users`.
 * This package does not depend on `@kilocode/web-shared`, so the rule is applied here.
 */
export function availableAccountCondition() {
  return and(isNull(kilocode_users.blocked_at), isNull(kilocode_users.blocked_reason));
}
