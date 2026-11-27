import { UTS_GRANT_TYPES, UTS_MAX_TOKENS_PER_CALL, UTS_TOKEN_PATH } from '@kilocode/uts-contracts';
import { z } from 'zod';
import type { UtsConfig } from '../env';
import type { DeviceContext, ExchangeCodeInput, GrantsAccess, Minted } from '../grants/store';
import { jsonResponse } from '../responses';
import type { FeedPublish } from '../revocation/publish';
import { requestNetwork } from '../signin/network';
import {
  type MintClient,
  type ScopeRegistry,
  clientScopeRefusal,
  orgScopeRefusal,
} from '../scopes/policy';
import {
  firstPartyRefreshTokenOfExchange,
  grantIdOfCode,
  grantIdOfFirstPartyRefreshToken,
  isRandomCredential,
  randomCredential,
  sha256,
} from '../token/credentials';
import { type SignerAccess, accessTokenClaims, tokenResponseBody } from '../token/mint';
import { type ClientIdentity, type FirstPartyClient, requestClient } from './clients';
import { failureResponse, oauthError, temporarilyUnavailable } from './errors';
import { type Params, audiencesOfResources, parseScopes, readForm, targetMismatch } from './params';
import { CodeVerifierSchema, s256Challenge } from './pkce';
import { firstPartyProof, refuseThirdPartyProof, replayedDpopProof } from './proof';

/**
 * POST /token (design 5.3 and 5.4). Grants: `authorization_code` (DPoP-bound for a first-party
 * client), `refresh_token` (DPoP-bound first-party grant, or third-party rotation with reuse
 * detection) and the RFC 8628 device grant through its hook. `client_credentials` is not offered.
 *
 * Each call verifies at most one DPoP proof, before the grant read, runs one SQL statement, which
 * also records the proof's `jti` under the proof's key, and signs one token per scope (up to 8)
 * in one call to the grant's signer object. A failure after the statement committed leaves the
 * grant as the statement left it and answers an error. A first-party client retries: a code
 * exchange while the code's 60-second lifetime lasts gets the same grant and the same refresh
 * token, which derives from the code and the PKCE verifier. A third-party client that lost an
 * answer authorizes again: a second use of its code, like a second use of a replaced refresh
 * token, revokes the family.
 *
 * A refused exchange or third-party refresh whose statement revoked a grant (a second use of a
 * code, a reused rotated token) publishes the statement's feed entries before it answers; a failed
 * publish changes nothing in the answer, and the backfill adds the entries (design 5.6).
 */

/** The RFC 8628 device grant, which the device sign-in slice provides. */
export type DeviceCodeGrant = (request: Request, params: Params) => Promise<Response>;

export type TokenDeps = {
  config: UtsConfig;
  grants: GrantsAccess;
  sign: SignerAccess;
  scopes: ScopeRegistry;
  publish: FeedPublish;
  deviceCodeGrant: DeviceCodeGrant | null;
};

/** The token endpoint on the issuer origin: the `htu` of every token request's DPoP proof. */
export function tokenEndpointUrl(config: UtsConfig): string {
  return `${config.endpoints.issuer}${UTS_TOKEN_PATH}`;
}

/** Kilo extension parameters of a first-party code exchange, shown in the user's device list. */
const DeviceParamsSchema = z.strictObject({
  label: z.optional(z.string().regex(/^[\x20-\x7e]{1,128}$/)),
  platform: z.optional(z.string().regex(/^[\x21-\x7e]{1,64}$/)),
});

const GRANT_ERRORS = {
  invalid_grant: 'the grant is invalid, expired or revoked',
  invalid_scope:
    'the scopes are not all granted, a scope needs another role in the organization, or there are more than 8',
  invalid_target: 'each resource must name a Kilo service that a requested scope belongs to',
} as const;

/**
 * Every refused grant answers 400. A DPoP key that is not the grant's and a reused third-party
 * token answer like any invalid grant, so the response tells an attacker nothing more. A proof
 * whose `jti` the grant recorded before answers `invalid_dpop_proof`, as a refused proof does.
 */
export function grantError(
  outcome: keyof typeof GRANT_ERRORS | 'dpop_mismatch' | 'reuse_detected' | 'dpop_replay'
): Response {
  if (outcome === 'dpop_replay') return replayedDpopProof();
  const error =
    outcome === 'dpop_mismatch' || outcome === 'reuse_detected' ? 'invalid_grant' : outcome;
  return oauthError(error, 400, GRANT_ERRORS[error]);
}

type TokenSelection = { scopes: string[] | null; resources: string[] | null };

/**
 * The optional `scope` and `resource` of a token request (RFC 6749 section 6, RFC 8707). A named
 * scope the client may not hold (`clientScopeRefusal`) answers `invalid_scope` before the grant
 * statement runs.
 */
export function tokenSelection(
  params: Params,
  deps: Pick<TokenDeps, 'config' | 'scopes'>,
  client: MintClient
): TokenSelection | Response {
  const scopeParam = params.one('scope');
  if (scopeParam.status === 'repeated') return oauthError('invalid_request', 400, 'scope repeats');
  let scopes: string[] | null = null;
  if (scopeParam.status === 'present') {
    scopes = parseScopes(scopeParam.value, UTS_MAX_TOKENS_PER_CALL);
    if (scopes === null) {
      return oauthError('invalid_scope', 400, 'scope must name at most 8 UTS scopes once each');
    }
    if (clientScopeRefusal(scopes, client, deps.scopes) !== null) {
      return oauthError(
        'invalid_scope',
        400,
        'a requested scope is not registered for this client'
      );
    }
  }
  const resourceValues = params.all('resource');
  let resources: string[] | null = null;
  if (resourceValues.length > 0) {
    resources = audiencesOfResources(resourceValues, deps.config.environment);
    if (resources === null || (scopes !== null && targetMismatch(scopes, resources))) {
      return grantError('invalid_target');
    }
  }
  return { scopes, resources };
}

function mintClient(identity: Exclude<ClientIdentity, { kind: 'unknown' }>): MintClient {
  return identity.kind === 'first_party'
    ? { kind: 'first_party', clientId: identity.client.clientId }
    : { kind: 'third_party', clientId: identity.clientId };
}

export function required(params: Params, name: string): string | Response {
  const param = params.one(name);
  return param.status === 'present'
    ? param.value
    : oauthError('invalid_request', 400, `${name} is required once`);
}

/** Where the device that signs in is, for its device-session row. */
export function deviceContext(
  request: Request,
  params: Params,
  client: FirstPartyClient
): DeviceContext | Response {
  const label = params.one('device_label');
  const platform = params.one('device_platform');
  const parsed = DeviceParamsSchema.safeParse({
    label: label.status === 'present' ? label.value : undefined,
    platform: platform.status === 'present' ? platform.value : undefined,
  });
  if (label.status === 'repeated' || platform.status === 'repeated' || !parsed.success) {
    return oauthError('invalid_request', 400, 'device_label or device_platform is malformed');
  }
  const network = requestNetwork(request);
  return {
    label: parsed.data.label ?? client.name,
    platform: parsed.data.platform ?? 'unknown',
    clientIp: network.clientIp,
    asn: network.asn,
    country: network.country,
    city: network.city,
  };
}

/**
 * Signs the minted tokens and answers the token response. The statement already refused a role
 * outside a scope's roles without writing anything (migration 0005), and `/authorize` stored only
 * scopes the client may hold; this last check before signing keeps a token from ever carrying a
 * scope the registry does not allow the client, or an organization scope without `org` or with
 * another role, even if the registry changed after the grant was created.
 */
export async function completeMint(
  deps: Pick<TokenDeps, 'config' | 'sign' | 'scopes'>,
  client: MintClient,
  grantId: string,
  minted: Minted,
  refresh: { token: string; expiresAt: Date } | null
): Promise<Response> {
  const clientId = client.clientId;
  if (clientScopeRefusal(minted.scopes, client, deps.scopes) !== null) {
    console.error(JSON.stringify({ event: 'uts.token.client_scope_refused', client: clientId }));
    return oauthError('invalid_scope', 400, 'a granted scope is not registered for this client');
  }
  if (orgScopeRefusal(minted.scopes, minted.orgId, minted.orgRole, deps.scopes) !== null) {
    console.error(JSON.stringify({ event: 'uts.token.org_scope_refused', client: clientId }));
    return oauthError(
      'invalid_grant',
      400,
      'the grant names no organization, or another role, for its scopes'
    );
  }
  const nowMs = Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  const claims = accessTokenClaims(deps.config, clientId, grantId, minted, nowSeconds);
  const signed = await deps.sign(grantId, claims);
  if (signed.status === 'unavailable') return temporarilyUnavailable();
  if (signed.status === 'misconfigured') return oauthError('server_error', 500);
  return jsonResponse(tokenResponseBody(claims, signed.tokens, refresh, nowMs), 200, {
    Pragma: 'no-cache',
  });
}

async function exchangeCode(request: Request, params: Params, deps: TokenDeps): Promise<Response> {
  const identity = requestClient(params);
  if (identity instanceof Response) return identity;
  const code = required(params, 'code');
  if (code instanceof Response) return code;
  const redirectUri = required(params, 'redirect_uri');
  if (redirectUri instanceof Response) return redirectUri;
  const verifier = required(params, 'code_verifier');
  if (verifier instanceof Response) return verifier;
  if (!CodeVerifierSchema.safeParse(verifier).success) {
    return oauthError('invalid_request', 400, 'code_verifier is malformed');
  }
  const client = mintClient(identity);
  const selection = tokenSelection(params, deps, client);
  if (selection instanceof Response) return selection;
  if (!isRandomCredential(code)) return grantError('invalid_grant');

  const grantId = await grantIdOfCode(code);
  let binding: ExchangeCodeInput['binding'];
  let refreshToken: string;
  if (identity.kind === 'first_party') {
    const device = deviceContext(request, params, identity.client);
    if (device instanceof Response) return device;
    const proof = await firstPartyProof(request, tokenEndpointUrl(deps.config));
    if (proof instanceof Response) return proof;
    binding = {
      kind: 'first_party',
      proof,
      clientClass: identity.client.clientClass,
      device,
    };
    refreshToken = await firstPartyRefreshTokenOfExchange(grantId, code, verifier);
  } else {
    const refused = refuseThirdPartyProof(request);
    if (refused !== null) return refused;
    binding = { kind: 'third_party' };
    refreshToken = randomCredential();
  }
  const clientId = client.clientId;

  const result = await deps.grants(async grants =>
    grants.exchangeCode({
      environment: deps.config.environment,
      codeHash: await sha256(code),
      clientId,
      redirectUri,
      codeChallenge: await s256Challenge(verifier),
      binding,
      grantId,
      refreshTokenHash: await sha256(refreshToken),
      ...selection,
    })
  );
  if (result.outcome !== 'issued') {
    await deps.publish(result.feedEntries);
    return grantError(result.outcome);
  }
  return await completeMint(deps, client, grantId, result, {
    token: refreshToken,
    expiresAt: result.refreshExpiresAt,
  });
}

async function refresh(request: Request, params: Params, deps: TokenDeps): Promise<Response> {
  const identity = requestClient(params);
  if (identity instanceof Response) return identity;
  const token = required(params, 'refresh_token');
  if (token instanceof Response) return token;
  const client = mintClient(identity);
  const selection = tokenSelection(params, deps, client);
  if (selection instanceof Response) return selection;

  if (identity.kind === 'first_party') {
    const grantId = grantIdOfFirstPartyRefreshToken(token);
    if (grantId === null) return grantError('invalid_grant');
    const proof = await firstPartyProof(request, tokenEndpointUrl(deps.config));
    if (proof instanceof Response) return proof;
    const result = await deps.grants(async grants =>
      grants.refreshFirstParty({
        environment: deps.config.environment,
        tokenHash: await sha256(token),
        grantId,
        clientId: identity.client.clientId,
        proof,
        ...selection,
      })
    );
    if (result.outcome !== 'issued') return grantError(result.outcome);
    return await completeMint(deps, client, grantId, result, null);
  }

  const refused = refuseThirdPartyProof(request);
  if (refused !== null) return refused;
  if (!isRandomCredential(token)) return grantError('invalid_grant');
  const rotated = randomCredential();
  const result = await deps.grants(async grants =>
    grants.refreshThirdParty({
      environment: deps.config.environment,
      tokenHash: await sha256(token),
      clientId: identity.clientId,
      newTokenHash: await sha256(rotated),
      ...selection,
    })
  );
  if (result.outcome !== 'issued') {
    await deps.publish(result.feedEntries);
    return grantError(result.outcome);
  }
  return await completeMint(deps, client, result.familyId, result, {
    token: rotated,
    expiresAt: result.refreshExpiresAt,
  });
}

export async function handleToken(request: Request, deps: TokenDeps): Promise<Response> {
  if (request.method !== 'POST') {
    return oauthError('invalid_request', 405, 'use POST', { Allow: 'POST' });
  }
  const form = await readForm(request);
  if (form.status === 'invalid') return oauthError('invalid_request', 400, form.description);
  const grantType = form.params.one('grant_type');
  if (grantType.status !== 'present') {
    return oauthError('invalid_request', 400, 'grant_type is required once');
  }
  try {
    switch (grantType.value) {
      case UTS_GRANT_TYPES.authorizationCode:
        return await exchangeCode(request, form.params, deps);
      case UTS_GRANT_TYPES.refreshToken:
        return await refresh(request, form.params, deps);
      case UTS_GRANT_TYPES.deviceCode:
        if (deps.deviceCodeGrant !== null) return await deps.deviceCodeGrant(request, form.params);
        return oauthError('unsupported_grant_type', 400);
      default:
        return oauthError('unsupported_grant_type', 400);
    }
  } catch (error) {
    return failureResponse(error, 'token');
  }
}
