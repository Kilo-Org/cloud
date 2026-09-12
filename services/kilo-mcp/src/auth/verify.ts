/**
 * Access-token verification for the MCP endpoint (requirement 18).
 *
 * `verifyMcpAccessToken` checks the HS256 signature, `iss`, `exp`, the
 * resource-indicator `aud`, and the jti revocation registry, and returns the
 * bound identity `{ kiloUserId, organizationId }`.
 *
 * The result carries `mine`: whether the token passed THIS worker's HMAC
 * check. A foreign bearer (an apps/web token, some other issuer's JWT) is not
 * ours and the caller may fall back to passthrough; a token that bears our
 * signature but fails claims (expired, revoked, wrong audience) is ours and
 * must be rejected outright.
 */
import { decodeJwt, verifyJwtSignature } from './jwt';

export type VerifiedMcpToken = {
  kiloUserId: string;
  organizationId: string | null;
  clientId: string;
  /** The token's bound resource (`aud`), so credential lookups stay grant-scoped. */
  resource: string;
  /** Seconds (JWT `exp`), for callers that want to cache the verify result. */
  expiresAt: number;
};

export type VerifyMcpTokenDeps = {
  tokenSecret: string;
  /** This worker's origin — the `iss` the token must carry. */
  issuer: string;
  /** The canonical `/mcp` resource URL — the `aud` the token must carry. */
  resource: string;
  /** jti revocation lookup (the KiloMcpOAuthStore registry). */
  isJtiRevoked?: (jti: string) => Promise<boolean>;
  now?: () => number;
};

export type McpTokenVerification =
  | { ok: true; token: VerifiedMcpToken }
  | {
      ok: false;
      mine: boolean;
      reason: 'malformed' | 'signature' | 'expired' | 'revoked' | 'issuer' | 'audience' | 'claims';
    };

export async function verifyMcpAccessToken(
  bearer: string,
  deps: VerifyMcpTokenDeps
): Promise<McpTokenVerification> {
  const decoded = decodeJwt(bearer);
  if (!decoded) return { ok: false, mine: false, reason: 'malformed' };
  if (!(await verifyJwtSignature(decoded, deps.tokenSecret))) {
    return { ok: false, mine: false, reason: 'signature' };
  }
  // From here the token is definitely ours: every failure below is `mine: true`.
  const { payload } = decoded;
  if (payload['iss'] !== deps.issuer) return { ok: false, mine: true, reason: 'issuer' };
  if (payload['aud'] !== deps.resource) return { ok: false, mine: true, reason: 'audience' };
  const exp = payload['exp'];
  if (typeof exp !== 'number' || exp * 1000 <= (deps.now?.() ?? Date.now())) {
    return { ok: false, mine: true, reason: 'expired' };
  }
  const sub = payload['sub'];
  const clientId = payload['client_id'];
  if (typeof sub !== 'string' || typeof clientId !== 'string') {
    return { ok: false, mine: true, reason: 'claims' };
  }
  const org = payload['org'];
  if (org !== null && org !== undefined && typeof org !== 'string') {
    return { ok: false, mine: true, reason: 'claims' };
  }
  const jti = payload['jti'];
  if (typeof jti !== 'string') return { ok: false, mine: true, reason: 'claims' };
  if (deps.isJtiRevoked && (await deps.isJtiRevoked(jti))) {
    return { ok: false, mine: true, reason: 'revoked' };
  }
  return {
    ok: true,
    token: {
      kiloUserId: sub,
      organizationId: typeof org === 'string' ? org : null,
      clientId,
      resource: deps.resource,
      expiresAt: exp,
    },
  };
}
