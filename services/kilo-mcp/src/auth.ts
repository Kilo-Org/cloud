import {
  verifyMcpAccessToken,
  type VerifyMcpTokenDeps,
  type VerifiedMcpToken,
} from './auth/verify';
import type { ForwardedAuth } from './types';

/**
 * Organization header name. Mirrors ORGANIZATION_ID_HEADER in
 * apps/web/src/lib/constants.ts:19 — apps/web reads it to scope identity to an
 * org (apps/web/src/lib/user/server.ts). Keep in sync if the web constant ever
 * changes.
 */
export const ORGANIZATION_ID_HEADER = 'x-kilocode-organizationid';

export type AuthenticateDeps = {
  /**
   * MCP token verification (s5). When present, /mcp accepts ONLY a bearer that
   * verifies as this worker's own MCP access token (s6 enforcement): a foreign
   * bearer, an expired/revoked/wrong-audience MCP token, or a malformed token
   * is rejected (no passthrough). The forwarded identity — bearer + org —
   * comes entirely from the verified token's claims; the caller-supplied
   * organization header is ignored. Without this dep (a worker missing its
   * OAuth bindings) the s2 passthrough stays so the misconfigured worker still
   * answers.
   */
  mcpToken?: VerifyMcpTokenDeps;
  /**
   * Resolve the Kilo API token to forward for a verified MCP identity (s6).
   * apps/web cannot verify this worker's MCP JWT, so a verified token is
   * exchanged for the Kilo credential its grant was minted from. Null when no
   * live grant holds one (the user must reconnect) — treated as a rejection.
   */
  resolveKiloToken?: (identity: VerifiedMcpToken) => Promise<string | null>;
};

/**
 * Extract the credentials to forward to apps/web. Returns null when the
 * request has no usable bearer (or, with MCP verification on, when the bearer
 * is not a live MCP token), which the transport answers with 401 before any
 * upstream request is made.
 *
 * Never log the returned values; they embed a live token.
 */
export async function authenticate(
  request: Request,
  deps?: AuthenticateDeps
): Promise<ForwardedAuth | null> {
  const authorization = request.headers.get('Authorization');
  if (!authorization || !/^Bearer\s+\S+/i.test(authorization)) {
    return null;
  }

  if (deps?.mcpToken) {
    const bearer = authorization.replace(/^Bearer\s+/i, '');
    const verification = await verifyMcpAccessToken(bearer, deps.mcpToken);
    if (!verification.ok) {
      // s6: only MCP tokens reach the catalog. Any non-verified bearer —
      // foreign, malformed, expired, revoked, wrong audience — is rejected.
      return null;
    }
    // The token is bound to user + org + this MCP (requirement 18); the org
    // claim is authoritative and the caller-supplied header is ignored.
    const kiloToken = deps.resolveKiloToken
      ? await deps.resolveKiloToken(verification.token)
      : null;
    if (!kiloToken) {
      // A live MCP token whose grant no longer carries a Kilo credential: the
      // user must reconnect. Reject before any catalog or upstream work.
      return null;
    }
    return {
      authorization: `Bearer ${kiloToken}`,
      organizationId: verification.token.organizationId ?? undefined,
      mcpIdentity: verification.token,
    };
  }

  // Unconfigured worker (no OAuth bindings): s2 passthrough of the caller's
  // bearer and organization header.
  const headerOrganizationId = request.headers.get(ORGANIZATION_ID_HEADER) ?? undefined;
  return { authorization, organizationId: headerOrganizationId };
}
