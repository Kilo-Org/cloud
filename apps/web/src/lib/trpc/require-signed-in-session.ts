import 'server-only';
import { TRPCError } from '@trpc/server';
import type { TRPCContext } from '@kilocode/web-shared/lib/trpc/init';

/**
 * The credential rule for procedures that manage account access: a browser
 * session, or a bearer bound to a live device session. Native sign-in and a
 * device-code login that asks for refreshable credentials create device
 * sessions. The app shell names its caller with its own cookie, which is set
 * only from a hand-off minted under this rule.
 */
export function requireSignedInSession(
  ctx: Pick<TRPCContext, 'authViaToken' | 'credential' | 'deviceSessionId'>
): void {
  if (ctx.authViaToken && (ctx.credential !== 'human_bearer' || !ctx.deviceSessionId)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'A signed-in session is required, not an API token.',
    });
  }
}
