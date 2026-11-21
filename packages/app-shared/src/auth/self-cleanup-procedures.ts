/**
 * The only procedures a refused account may still call: the three cleanups its
 * sign-out issues. A blocked account's sign-out must end the session
 * server-side and delete the device's own push and activity token rows; a
 * device that skips the latter keeps receiving notifications for an account it
 * was just told it cannot use. The web logout route admits a blocked account
 * for the same session cleanup
 * (`apps/web/src/app/api/auth/revoke-web-session/route.ts`).
 *
 * Each of the three only deletes rows where `user_id` is the caller's own
 * (`apps/web/src/routers/user-router.ts` `revokeCurrentDeviceSession` /
 * `unregisterPushToken` / `unregisterActivityToken`), so the admission cannot
 * carry a read or reach another account.
 *
 * The server admits a refused account only for a request whose every call is
 * one of these, so the mobile client must never batch one of them with another
 * call: the whole request, the cleanup included, would be refused. Both sides
 * read this one list, so a fourth cleanup cannot be added on the server alone
 * while the client keeps batching it.
 */
export const SELF_CLEANUP_PROCEDURES = [
  'user.revokeCurrentDeviceSession',
  'user.unregisterPushToken',
  'user.unregisterActivityToken',
] as const;

export type SelfCleanupProcedure = (typeof SELF_CLEANUP_PROCEDURES)[number];

const SELF_CLEANUP_PROCEDURE_SET: ReadonlySet<string> = new Set(SELF_CLEANUP_PROCEDURES);

/**
 * Whether a call's path is one of the self-cleanup procedures. The path is
 * tRPC's `procedure?input` form, so the query string is dropped first, exactly
 * as the server's admission reads it.
 */
export function isSelfCleanupProcedure(path: string): boolean {
  const procedure = path.split('?')[0];
  return procedure !== undefined && SELF_CLEANUP_PROCEDURE_SET.has(procedure);
}
