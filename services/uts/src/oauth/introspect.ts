import { type IntrospectionResponse, UTS_INTROSPECT_PATH } from '@kilocode/uts-contracts';
import type { UtsConfig } from '../env';
import type { GrantsAccess, ProofBinding } from '../grants/store';
import { jsonResponse } from '../responses';
import { grantIdOfFirstPartyRefreshToken, isRandomCredential, sha256 } from '../token/credentials';
import { requestClient } from './clients';
import { failureResponse, oauthError } from './errors';
import { readForm } from './params';
import { firstPartyProof, refuseThirdPartyProof, replayedDpopProof } from './proof';

/**
 * POST /introspect (RFC 7662): the synchronous liveness answer for the refresh credentials UTS
 * issues (design 5.4). The caller is the client the token was issued to. RFC 7662 section 2.1
 * needs the caller authorized: a first-party client proves its device key with a DPoP proof for
 * this endpoint, which must match the grant's key; a third-party client holds the token itself,
 * 32 random bytes that cannot be guessed. An access token, like any unknown, expired, revoked or
 * foreign token, answers `{ active: false }`: services verify access tokens locally (design 7).
 * The endpoint runs one statement, which writes no audit row; for a first-party grant it records
 * the proof's `jti`, so the proof is accepted once.
 */

export type IntrospectDeps = { config: UtsConfig; grants: GrantsAccess };

const INACTIVE: IntrospectionResponse = { active: false };

function answer(body: IntrospectionResponse): Response {
  return jsonResponse(body, 200, { Pragma: 'no-cache' });
}

export async function handleIntrospect(request: Request, deps: IntrospectDeps): Promise<Response> {
  if (request.method !== 'POST') {
    return oauthError('invalid_request', 405, 'use POST', { Allow: 'POST' });
  }
  const form = await readForm(request);
  if (form.status === 'invalid') return oauthError('invalid_request', 400, form.description);
  const identity = requestClient(form.params);
  if (identity instanceof Response) return identity;
  const token = form.params.one('token');
  if (token.status !== 'present') {
    return oauthError('invalid_request', 400, 'token is required once');
  }

  let proof: ProofBinding | null = null;
  let clientId: string;
  if (identity.kind === 'first_party') {
    clientId = identity.client.clientId;
    if (grantIdOfFirstPartyRefreshToken(token.value) === null) return answer(INACTIVE);
    const verified = await firstPartyProof(
      request,
      `${deps.config.endpoints.issuer}${UTS_INTROSPECT_PATH}`
    );
    if (verified instanceof Response) return verified;
    proof = verified;
  } else {
    clientId = identity.clientId;
    const refused = refuseThirdPartyProof(request);
    if (refused !== null) return refused;
    if (!isRandomCredential(token.value)) return answer(INACTIVE);
  }

  try {
    const result = await deps.grants(async grants =>
      grants.introspect({ tokenHash: await sha256(token.value), clientId, proof })
    );
    if (result.outcome !== 'active') {
      return result.outcome === 'dpop_replay' ? replayedDpopProof() : answer(INACTIVE);
    }
    return answer({
      active: true,
      token_type: 'refresh_token',
      client_id: clientId,
      sub: result.subjectId,
      scope: result.scopes.join(' '),
      iat: Math.floor(result.issuedAt.getTime() / 1000),
      exp: Math.floor(result.expiresAt.getTime() / 1000),
      iss: deps.config.endpoints.issuer,
      sid: result.grantId,
    });
  } catch (error) {
    return failureResponse(error, 'introspect');
  }
}
