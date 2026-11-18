import 'server-only';
import { isGoneOrDeletingBlockedReason } from '@kilocode/db/user-soft-delete';
import { findUserById } from '@kilocode/web-shared/lib/user/find-user-by-id';
import { readDb, type db } from '@kilocode/web-shared/lib/drizzle';

/**
 * The person a Claude billing row names as the one who linked it. An
 * organization connection bills on that person, so it needs them to still be
 * usable.
 */
export type ClaudeBillingConnector =
  /** The row names no connector; an older release did not record one. */
  | { kind: 'unrecorded' }
  /** The connector resolves to an account that can still bill. */
  | { kind: 'present' }
  /**
   * The connector can no longer bill: the account row is gone, the account is
   * soft-deleted or being deleted, or it holds no usable email.
   */
  | { kind: 'gone' };

/**
 * Resolves the connector recorded on a connection. Account erasure keeps the
 * `kilocode_users` row and replaces it with a placeholder address and a
 * soft-deleted reason, so a missing row alone never reports a gone connector.
 */
export async function resolveClaudeBillingConnector(
  createdBy: string | null | undefined,
  fromDb: typeof db = readDb
): Promise<ClaudeBillingConnector> {
  if (!createdBy) return { kind: 'unrecorded' };
  const user = await findUserById(createdBy, fromDb);
  if (!user || isGoneOrDeletingBlockedReason(user.blocked_reason)) return { kind: 'gone' };
  const email = user.google_user_email?.trim();
  return email ? { kind: 'present' } : { kind: 'gone' };
}
