import { TRPCError } from '@trpc/server';
import { CODE_INDEXING_ENABLED_USER_IDS } from '@kilocode/web-shared/lib/config.server';
import { staffRefusalKind } from '@kilocode/web-shared/lib/admin/admin-guard';
import { StaffRequestRefusal } from '@kilocode/web-shared/routers/organizations/utils';
import type { User } from '@kilocode/db/schema';
import type { TRPCContext } from '@kilocode/web-shared/lib/trpc/init';
import { sql } from 'drizzle-orm';

const manuallyEnabledUsers = new Set(
  CODE_INDEXING_ENABLED_USER_IDS.split(',')
    .map(userId => userId.trim())
    .filter(userId => userId.length > 0)
);

/** Whether the configured list enables the personal code index for this account. */
export function isManuallyEnabledForUser(userId: string): boolean {
  return manuallyEnabledUsers.has(userId);
}

/**
 * Whether the personal code index could open to this account only through
 * staff authority: the configured list does not name it and the session's row
 * carries the platform admin flag. The staff guard re-reads the primary row.
 */
export function isStaffPersonalIndexingCandidate(user: Pick<User, 'id' | 'is_admin'>): boolean {
  return !isManuallyEnabledForUser(user.id) && user.is_admin;
}

/**
 * Whether the personal code index is open to this caller only through staff
 * authority: the request names no organization, the account is a
 * {@link isStaffPersonalIndexingCandidate}, and it calls from a browser
 * session. Such a caller must pass the staff guard; any other credential gets
 * the ordinary refusal.
 */
export function personalIndexingNeedsStaffAuthority(
  ctx: Pick<TRPCContext, 'user' | 'credential'>,
  organizationId: string | null | undefined
): boolean {
  return (
    !organizationId && isStaffPersonalIndexingCandidate(ctx.user) && ctx.credential === 'session'
  );
}

/**
 * Whether an error is a staff guard refusal a handler must pass through: any
 * typed tRPC refusal except `not_staff`, or any refusal of a REST staff
 * admission ({@link StaffRequestRefusal}), which carries the adapter's own
 * response. A tRPC `not_staff` refusal means the primary row is no longer an
 * admin, so the caller gets the ordinary answer. A handler that turns other
 * failures into an ordinary answer must pass these through.
 */
export function isStaffAuthorityRefusal(error: unknown): error is TRPCError {
  if (error instanceof TRPCError && error.cause instanceof StaffRequestRefusal) return true;
  const kind = staffRefusalKind(error);
  return kind !== null && kind !== 'not_staff';
}

/**
 * SQL fragment to calculate storage size in KB from chunk count.
 * Formula: chunks * 256 (embedding dimensions) * 4 (bytes per float) * 1.5 (overhead) / 1024 (bytes to KB)
 * Returns size in kilobytes for better precision on the frontend
 */
export const chunkCountToSizeKbSql = (chunkCountExpression: ReturnType<typeof sql.raw>) =>
  sql`ROUND((${chunkCountExpression} * 256.0 * 4.0 * 1.5 / 1024.0)::numeric, 2)`;
