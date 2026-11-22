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
 * Every entry therefore names the call kind it is declared as, and the
 * admission accepts nothing but a `mutation`: the exemption covers self-scoped
 * writes only, so a read never enters it even if its path were listed here.
 * `apps/web/src/routers/user-router.test.ts` asserts each listed path is really
 * declared a mutation of the user router, so a cleanup whose kind changes fails
 * a test instead of quietly needing a wider exemption.
 *
 * The server admits a refused account only for a request whose every call is
 * one of these, so the mobile client must never batch one of them with another
 * call: the whole request, the cleanup included, would be refused. Both sides
 * read this one list, so a fourth cleanup cannot be added on the server alone
 * while the client keeps batching it.
 */
export const SELF_CLEANUP_PROCEDURES = [
  { path: 'user.revokeCurrentDeviceSession', type: 'mutation' },
  { path: 'user.unregisterPushToken', type: 'mutation' },
  { path: 'user.unregisterActivityToken', type: 'mutation' },
] as const;

/** The procedure path of a self-cleanup, e.g. `user.unregisterPushToken`. */
export type SelfCleanupProcedure = (typeof SELF_CLEANUP_PROCEDURES)[number]['path'];

const SELF_CLEANUP_PROCEDURE_SET: ReadonlySet<string> = new Set(
  SELF_CLEANUP_PROCEDURES.map(entry => entry.path)
);

/**
 * Whether a call is one of the self-cleanup writes. The exemption is limited to
 * a mutation of a listed procedure: the same path arriving as a query (or with
 * no kind at all) is not a self-cleanup, so a refused account gains no read
 * through this list.
 *
 * The path is tRPC's `procedure?input` form, so the query string is dropped
 * first, exactly as the server's admission reads it.
 */
export function isSelfCleanupProcedureCall(input: { path: string; type?: string }): boolean {
  if (input.type !== 'mutation') return false;
  const procedure = input.path.split('?')[0];
  return procedure !== undefined && SELF_CLEANUP_PROCEDURE_SET.has(procedure);
}
