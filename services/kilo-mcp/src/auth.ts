import type { ForwardedAuth, GrantProps } from './types';

/**
 * Organization header name. Mirrors ORGANIZATION_ID_HEADER in
 * apps/web/src/lib/constants.ts:19 — apps/web reads it to scope identity to an
 * org (apps/web/src/lib/user/server.ts). Keep in sync if the web constant ever
 * changes.
 */
export const ORGANIZATION_ID_HEADER = 'x-kilocode-organizationid';

/**
 * Build the credentials to forward to apps/web from the grant props the OAuth
 * provider decrypted for this request (see `src/index.ts`). The library
 * authenticated the bearer before the API handler runs, so the props are the
 * only source of identity: a caller-supplied bearer or organization header is
 * never consulted.
 *
 * Never log the returned value; `authorization` embeds a live Kilo token.
 */
export function forwardedAuthFromProps(props: GrantProps): ForwardedAuth {
  return {
    authorization: `Bearer ${props.kiloToken}`,
    organizationId: props.organizationId ?? undefined,
    kiloUserId: props.kiloUserId,
    clientId: props.clientId,
    adminEnabled: props.adminEnabled === true,
    adminEligible: props.adminEligible === true,
    // The grant's own connection id, forwarded so a protected request binds to
    // the session that created it. Absent or empty stays absent: a
    // pre-amendment grant (no sessionId) is unusable by the protected tools.
    ...(typeof props.sessionId === 'string' && props.sessionId.length > 0
      ? { sessionId: props.sessionId }
      : {}),
  };
}
