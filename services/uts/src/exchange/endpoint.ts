import {
  KILO_MCP_AUDIENCE,
  type TokenExchangeResponse,
  type TokenExchangeSlowDown,
  type UtsAccessTokenClaims,
  UTS_ACCESS_TOKEN_TYPE,
  UTS_ACCESS_TOKEN_TYPE_URN,
  UTS_EXCHANGED_TOKEN_MAX_LIFETIME_SECONDS,
  UTS_EXCHANGE_MIN_SUBJECT_SECONDS,
  UTS_TOKEN_EXCHANGE_ACTOR,
  UTS_TOKEN_EXCHANGE_STS_SCOPE,
  UtsAccessTokenClaimsSchema,
  UtsTokenKidSchema,
  audienceOfScope,
  resourceOriginOf,
} from '@kilocode/uts-contracts';
import { decodeProtectedHeader, importJWK, jwtVerify } from 'jose';
import type { AccessTokenKeys } from '../account/bearer';
import type { UtsConfig } from '../env';
import type { GrantsAccess } from '../grants/store';
import { identifyClient } from '../oauth/clients';
import { failureResponse, oauthError, temporarilyUnavailable } from '../oauth/errors';
import type { Params } from '../oauth/params';
import { jsonResponse } from '../responses';
import { type ScopeRegistry, clientScopeRefusal } from '../scopes/policy';
import type { SignerAccess } from '../token/mint';
import { type ExchangeLimit, type ExchangeWindows, exchangeRetryAfter } from './limits';

/**
 * The RFC 8693 broker exchange at `POST /token` (design 5.9; wire contract in
 * `@kilocode/uts-contracts`, `exchange.ts`). Kilo MCP holds an MCP access token of a user
 * (`kilo-mcp:catalog.read`, audience `kilo-mcp`) and needs a `kilo-api` token for the same user to
 * call the two global model queries. It authenticates with its STS token and receives a token that
 * carries the subject, its client, grant (`sid`) and organization, with `act: { sub: "kilo-mcp" }`.
 *
 * Steps, each refusing before the next costs anything:
 * 1. the caller: an STS token for the audience `uts` with the scope `uts:token-exchange`, of the
 *    workload `kilo-mcp` (`invalid_client`, 401); then the caller limit;
 * 2. the form: the subject token and its type, the requested type, exactly one `resource` (the
 *    environment's exact resource of the requested scope's audience, else `invalid_target`) and
 *    exactly one `scope` that only this exchange mints (else `invalid_scope`);
 * 3. the subject token, verified like any UTS token (signature under a signer key the isolate
 *    holds, `typ`, issuer, environment, time, claim profile), never itself delegated, with a `sid`
 *    (`invalid_grant`); then the subject limit;
 * 4. the delegation: the subject's scope lists the requested scope in `delegatesTo`
 *    (`invalid_scope`), and the registry allows the subject's client that scope (`invalid_grant`);
 * 5. the lifetime: min(now + 300 s, subject `exp`), and `invalid_grant` when under 30 s are left;
 * 6. one SQL statement: the grant (consent family or first-party grant), the consent, the subject
 *    and key revocations, and the `token.exchanged` audit row;
 * 7. one signer call for the one token.
 *
 * A pre-store refusal makes no SQL statement and no signer call; a store refusal writes at most one
 * denied audit row per grant per minute; a 429 costs nothing. Retry only on 503, after
 * `Retry-After`, and on 429 per its `limit`.
 */

/** RFC 6750 section 2.1: `Bearer` and a b64token. */
const BEARER = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/;
const SKEW_SECONDS = 60;

/** The caller's STS token as the verification port reads it. */
export type StsCaller = { workload: string; scope: string };

export type StsCallerCheck =
  | { status: 'verified'; caller: StsCaller }
  | { status: 'invalid' }
  | { status: 'unavailable' };

/**
 * Verifies an STS token for the audience `uts` (design 6, 7): signature under the STS key set,
 * issuer, environment, time, the service-token profile. The deployed entry uses
 * `@kilocode/verify` (src/sts-callers.ts); a development run without a stand-in STS wires none, so
 * the exchange is not offered there (`unsupported_grant_type`).
 */
export type StsCallerVerifier = (token: string) => Promise<StsCallerCheck>;

export type ExchangeService = {
  callers: StsCallerVerifier;
  keys: AccessTokenKeys;
  windows: ExchangeWindows;
  now: () => number;
};

export type ExchangeDeps = {
  config: UtsConfig;
  grants: GrantsAccess;
  sign: SignerAccess;
  scopes: ScopeRegistry;
  exchange: ExchangeService;
};

/** A verified subject token. */
type Subject = { claims: UtsAccessTokenClaims & { sid: string }; kid: string };

type SubjectCheck =
  | { status: 'ok'; subject: Subject }
  | { status: 'invalid' }
  | { status: 'unavailable' };

const FORBIDDEN_PARAMS = ['actor_token', 'actor_token_type', 'audience', 'client_id'] as const;

function invalidClient(description: string): Response {
  return oauthError('invalid_client', 401, description, { 'WWW-Authenticate': 'Bearer' });
}

function slowDown(limit: ExchangeLimit, retryAfter: number): Response {
  const body: TokenExchangeSlowDown = { error: 'slow_down', limit };
  return jsonResponse(body, 429, { 'Retry-After': String(retryAfter), Pragma: 'no-cache' });
}

function one(params: Params, name: string): string | null {
  const param = params.one(name);
  return param.status === 'present' ? param.value : null;
}

/**
 * Step 3: the subject token, verified like any UTS token by UTS itself. Its audience must be
 * `audience`, the resource the calling workload serves (`kilo-mcp` for Kilo MCP), so a workload
 * exchanges only tokens issued to itself, and its scope must belong to that audience.
 */
async function verifySubject(
  token: string,
  config: UtsConfig,
  keys: AccessTokenKeys,
  audience: string,
  nowSeconds: number
): Promise<SubjectCheck> {
  let header;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return { status: 'invalid' };
  }
  const kid = UtsTokenKidSchema.safeParse(header.kid);
  if (header.alg !== 'EdDSA' || header.typ !== UTS_ACCESS_TOKEN_TYPE || !kid.success) {
    return { status: 'invalid' };
  }
  const found = await keys(kid.data);
  if (found.status === 'unavailable') return { status: 'unavailable' };
  if (found.status === 'unknown') return { status: 'invalid' };
  let payload;
  try {
    const verified = await jwtVerify(token, await importJWK(found.key, 'EdDSA'), {
      algorithms: ['EdDSA'],
      typ: UTS_ACCESS_TOKEN_TYPE,
      issuer: config.endpoints.issuer,
      audience,
      clockTolerance: SKEW_SECONDS,
      currentDate: new Date(nowSeconds * 1000),
    });
    payload = verified.payload;
  } catch {
    return { status: 'invalid' };
  }
  const parsed = UtsAccessTokenClaimsSchema.safeParse(payload);
  if (
    !parsed.success ||
    parsed.data.env !== config.environment ||
    parsed.data.iat > nowSeconds + SKEW_SECONDS ||
    parsed.data.act !== undefined ||
    parsed.data.aud !== audience ||
    audienceOfScope(parsed.data.scope) !== audience
  ) {
    return { status: 'invalid' };
  }
  const { sid } = parsed.data;
  if (sid === undefined) return { status: 'invalid' };
  return { status: 'ok', subject: { claims: { ...parsed.data, sid }, kid: kid.data } };
}

export async function handleTokenExchange(
  request: Request,
  params: Params,
  deps: ExchangeDeps
): Promise<Response> {
  const { exchange, config } = deps;

  // 1. The caller.
  const bearer = BEARER.exec(request.headers.get('Authorization') ?? '')?.[1];
  if (bearer === undefined) return invalidClient('an STS bearer token is required');
  const checked = await exchange.callers(bearer);
  if (checked.status === 'unavailable') return temporarilyUnavailable();
  if (
    checked.status === 'invalid' ||
    checked.caller.workload !== UTS_TOKEN_EXCHANGE_ACTOR ||
    checked.caller.scope !== UTS_TOKEN_EXCHANGE_STS_SCOPE
  ) {
    return invalidClient('the STS token does not allow this exchange');
  }
  const actor = checked.caller.workload;
  const callerWait = exchangeRetryAfter(exchange.windows, 'caller', actor, exchange.now());
  if (callerWait !== null) return slowDown('caller', callerWait);

  // 2. The form.
  const subjectToken = one(params, 'subject_token');
  const requestedType = params.one('requested_token_type');
  const resource = one(params, 'resource');
  const scope = one(params, 'scope');
  if (
    subjectToken === null ||
    one(params, 'subject_token_type') !== UTS_ACCESS_TOKEN_TYPE_URN ||
    requestedType.status === 'repeated' ||
    (requestedType.status === 'present' && requestedType.value !== UTS_ACCESS_TOKEN_TYPE_URN) ||
    resource === null ||
    scope === null ||
    FORBIDDEN_PARAMS.some(name => params.one(name).status !== 'absent')
  ) {
    return oauthError(
      'invalid_request',
      400,
      'subject_token, subject_token_type, resource and scope are required once, as access tokens'
    );
  }
  const scopeEntry = deps.scopes(scope);
  if (scopeEntry === null || scopeEntry.issuance !== 'token_exchange' || !scopeEntry.delegable) {
    return oauthError('invalid_scope', 400, 'the scope is not one this exchange issues');
  }
  if (resourceOriginOf(config.environment, audienceOfScope(scope)) !== resource) {
    return oauthError('invalid_target', 400, 'resource must be the exact resource of the scope');
  }

  // 3. The subject token.
  const nowSeconds = Math.floor(exchange.now() / 1000);
  // The one workload the exchange serves is Kilo MCP (step 1), whose resource is `kilo-mcp`.
  const verified = await verifySubject(
    subjectToken,
    config,
    exchange.keys,
    KILO_MCP_AUDIENCE,
    nowSeconds
  );
  if (verified.status === 'unavailable') return temporarilyUnavailable();
  if (verified.status === 'invalid') {
    return oauthError('invalid_grant', 400, 'the subject token is invalid, expired or revoked');
  }
  const { claims, kid } = verified.subject;
  const subjectWait = exchangeRetryAfter(exchange.windows, 'subject', claims.sid, exchange.now());
  if (subjectWait !== null) return slowDown('subject', subjectWait);

  // 4. The delegation.
  if (!(deps.scopes(claims.scope)?.delegatesTo.includes(scope) ?? false)) {
    return oauthError('invalid_scope', 400, 'the subject token does not delegate this scope');
  }
  const client = identifyClient(claims.client_id);
  if (
    client.kind === 'unknown' ||
    clientScopeRefusal(
      [claims.scope],
      { kind: client.kind, clientId: claims.client_id },
      deps.scopes
    ) !== null
  ) {
    return oauthError('invalid_grant', 400, 'the subject token is invalid, expired or revoked');
  }

  // 5. The lifetime.
  const remaining = claims.exp - nowSeconds;
  if (remaining < UTS_EXCHANGE_MIN_SUBJECT_SECONDS) {
    return oauthError('invalid_grant', 400, 'the subject token expires too soon; refresh it');
  }
  const lifetime = Math.min(
    UTS_EXCHANGED_TOKEN_MAX_LIFETIME_SECONDS,
    scopeEntry.maxLifetimeSeconds,
    remaining
  );

  // 6. The statement.
  let stored;
  try {
    stored = await deps.grants(grants =>
      grants.exchangeDelegated({
        environment: config.environment,
        clientKind: client.kind,
        accountId: claims.sub,
        clientId: claims.client_id,
        grantId: claims.sid,
        orgId: claims.org ?? null,
        subjectScope: claims.scope,
        subjectIssuedAt: new Date(claims.iat * 1000),
        subjectTokenId: claims.jti,
        subjectKid: kid,
        scope,
        actor,
        lifetimeSeconds: lifetime,
      })
    );
  } catch (error) {
    return failureResponse(error, 'token_exchange');
  }
  if (stored.outcome !== 'issued') {
    return stored.outcome === 'invalid_scope'
      ? oauthError('invalid_scope', 400, 'the consent does not cover this scope')
      : oauthError('invalid_grant', 400, 'the subject token is invalid, expired or revoked');
  }

  // 7. The signer call.
  const issued = UtsAccessTokenClaimsSchema.parse({
    iss: config.endpoints.issuer,
    exp: nowSeconds + lifetime,
    aud: audienceOfScope(scope),
    sub: claims.sub,
    client_id: claims.client_id,
    iat: nowSeconds,
    jti: stored.tokenId,
    scope,
    ...(claims.org === undefined ? {} : { org: claims.org }),
    act: { sub: actor },
    req: actor,
    sid: claims.sid,
    ...(claims.auth_time === undefined ? {} : { auth_time: claims.auth_time }),
    ...(claims.amr === undefined ? {} : { amr: claims.amr }),
    env: config.environment,
  });
  const signed = await deps.sign(claims.sid, [issued]);
  if (signed.status === 'unavailable') return temporarilyUnavailable();
  if (signed.status === 'misconfigured') return oauthError('server_error', 500);
  const body: TokenExchangeResponse = {
    access_token: signed.tokens[0],
    issued_token_type: UTS_ACCESS_TOKEN_TYPE_URN,
    token_type: 'Bearer',
    expires_in: lifetime,
    scope,
  };
  return jsonResponse(body, 200, { Pragma: 'no-cache' });
}
