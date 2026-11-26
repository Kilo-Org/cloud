import type { UtsConfig } from '../env';
import type { GrantsAccess } from '../grants/store';
import { grantIdOfFirstPartyRefreshToken, isRandomCredential, sha256 } from '../token/credentials';
import { identifyClient } from './clients';
import { failureResponse, oauthError } from './errors';
import { readForm } from './params';

/**
 * POST /revoke (RFC 7009). A refresh token revokes its first-party grant (and its device session)
 * or its whole third-party family, writes the feed entry and the audit row in one statement
 * (design 5.6), and answers 200. An unknown or already revoked token also answers 200 (RFC 7009
 * section 2.2). An access token answers `unsupported_token_type`: it lives 10 minutes, and its
 * grant is revoked through the refresh credential.
 *
 * A public client identifies by `client_id`. A token issued to another client changes nothing and
 * answers 200 like an unknown token, so the answer does not tell which client holds a token; the
 * statement's denied audit row records the attempt. No DPoP proof is needed, so a device that lost
 * its key can still sign out; whoever holds a stolen first-party refresh token can therefore sign
 * that device out, a denial of service and nothing more (design 5.6).
 */

export type RevokeDeps = { config: UtsConfig; grants: GrantsAccess };

/** A compact JWS: three base64url parts, the header always starting `eyJ`. */
const JWT_SHAPE = /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export async function handleRevoke(request: Request, deps: RevokeDeps): Promise<Response> {
  if (request.method !== 'POST') {
    return oauthError('invalid_request', 405, 'use POST', { Allow: 'POST' });
  }
  const form = await readForm(request);
  if (form.status === 'invalid') return oauthError('invalid_request', 400, form.description);
  const token = form.params.one('token');
  const clientId = form.params.one('client_id');
  if (token.status !== 'present' || clientId.status !== 'present') {
    return oauthError('invalid_request', 400, 'token and client_id are required once');
  }
  if (identifyClient(clientId.value).kind === 'unknown') {
    return oauthError('invalid_client', 401, 'unknown client');
  }
  if (JWT_SHAPE.test(token.value)) {
    return oauthError('unsupported_token_type', 400, 'revoke the refresh token instead');
  }
  const revoked = new Response(null, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  if (grantIdOfFirstPartyRefreshToken(token.value) === null && !isRandomCredential(token.value)) {
    return revoked;
  }
  try {
    // Every outcome answers 200: revoked, already revoked, unknown, or issued to another client.
    await deps.grants(async grants =>
      grants.revoke({
        environment: deps.config.environment,
        tokenHash: await sha256(token.value),
        clientId: clientId.value,
      })
    );
    return revoked;
  } catch (error) {
    return failureResponse(error, 'revoke');
  }
}
