import 'server-only';
import { isGoneOrDeletingBlockedReason } from '@kilocode/db/user-soft-delete';
import { findUserById } from '@kilocode/web-shared/lib/user/find-user-by-id';
import { readDb, type db } from '@kilocode/web-shared/lib/drizzle';

/**
 * The person a connection row names as the one whose delegated account it
 * holds. An organization connection's credential is that person's account, so
 * it needs them to still be usable.
 */
export type ConnectionConnector =
  /** The row names no connector; an older release did not record one. */
  | { kind: 'unrecorded' }
  /** The connector resolves to an account that is still usable. */
  | { kind: 'present' }
  /**
   * The connector is gone: the account row is missing, the account is
   * soft-deleted or being deleted, or it holds no usable email.
   */
  | { kind: 'gone' };

/**
 * Resolves the connector recorded on a connection. Account erasure keeps the
 * `kilocode_users` row and replaces it with a placeholder address and a
 * soft-deleted reason, so a missing row alone never reports a gone connector.
 */
export async function resolveConnectionConnector(
  createdBy: string | null | undefined,
  fromDb: typeof db = readDb
): Promise<ConnectionConnector> {
  if (!createdBy) return { kind: 'unrecorded' };
  const user = await findUserById(createdBy, fromDb);
  if (!user || isGoneOrDeletingBlockedReason(user.blocked_reason)) return { kind: 'gone' };
  const email = user.google_user_email?.trim();
  return email ? { kind: 'present' } : { kind: 'gone' };
}
