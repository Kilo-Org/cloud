import {
  UTS_ACCESS_TOKEN_TOKEN_TYPE,
  UTS_BROWSER_SESSION_READ_SCOPE,
  UTS_GRANT_TYPES,
  UTS_JWT_TOKEN_TYPE,
} from '@kilocode/uts-contracts';
import { failureResponse, oauthError } from '../oauth/errors';
import { type Params, targetMismatch } from '../oauth/params';
import { CodeVerifierSchema, s256Challenge } from '../oauth/pkce';
import {
  grantError,
  required,
  signMinted,
  tokenEndpointUrl,
  tokenSelection,
} from '../oauth/token-endpoint';
import { jsonResponse } from '../responses';
import { needsStepUp, orgScopeRefusal } from '../scopes/policy';
import {
  browserSessionHandleOfExchange,
  isRandomCredential,
  randomCredential,
  sha256,
} from '../token/credentials';
import { tokenResponseBody } from '../token/mint';
import {
  type ClientKeys,
  type JtiUse,
  type LegacySessionClaims,
  authenticateWebClient,
  verifyLegacySessionToken,
} from './client-auth';
import type { Minted } from '../grants/store';
import { WEB_MINT_CLIENT as WEB_CLIENT, type WebClientDeps } from './deps';
import { invalidClient, sessionFields, webClientUnavailable } from './responses';
import type { WebSession } from './store';

/**
 * The token endpoint for `kilo-web` (design 5.1, 5.3): a request that carries a client assertion.
 * Two grants serve it:
 *
 * * `authorization_code`: the code the browser brought back to the BFF's callback, with its PKCE
 *   verifier and no DPoP proof (browser grants are not DPoP-bound). The answer names the browser
 *   session and its handle, derived from the code and the verifier, so a retry inside the code's
 *   lifetime gets the same session and handle with new access tokens.
 * * the RFC 8693 legacy bridge (`LEGACY_BRIDGE_ENABLED`): a web-signed subject token for an
 *   existing web session becomes a browser session with `amr` `legacy_session` and the legacy
 *   sign-in time, never a fresh sign-in or a step-up.
 *
 * Every other grant is `unauthorized_client`: the BFF holds no refresh token.
 */

/** Browser grants are not DPoP-bound, so a DPoP proof is refused rather than ignored. */
function refuseDpop(request: Request): Response | null {
  return request.headers.has('DPoP')
    ? oauthError('invalid_request', 400, 'browser sessions are not DPoP-bound')
    : null;
}

/** A step-up scope is minted only by the browser-session token call, which checks the passkey. */
function stepUpRefusal(scopes: readonly string[], deps: WebClientDeps): Response | null {
  return needsStepUp(scopes, deps.scopes)
    ? oauthError('invalid_scope', 400, 'a scope that needs a step-up is minted only per session')
    : null;
}

/** Signs the session's tokens with the session id as `sid`, then answers with the session. */
async function sessionGrant(
  deps: WebClientDeps,
  minted: Minted,
  session: WebSession,
  handle: string,
  extra: Record<string, string>
): Promise<Response> {
  // The code's own scopes, when the request names none, are checked here before signing.
  const stepUp = stepUpRefusal(minted.scopes, deps);
  if (stepUp !== null) return stepUp;
  const signed = await signMinted(deps, WEB_CLIENT, session.sessionId, minted);
  if (signed instanceof Response) return signed;
  return jsonResponse(
    {
      ...tokenResponseBody(signed.claims, signed.tokens, null, signed.nowMs),
      ...extra,
      session_handle: handle,
      ...sessionFields(session),
    },
    200,
    { Pragma: 'no-cache' }
  );
}

async function exchangeWebCode(
  request: Request,
  params: Params,
  deps: WebClientDeps,
  assertion: JtiUse
): Promise<Response> {
  const code = required(params, 'code');
  if (code instanceof Response) return code;
  const redirectUri = required(params, 'redirect_uri');
  if (redirectUri instanceof Response) return redirectUri;
  const verifier = required(params, 'code_verifier');
  if (verifier instanceof Response) return verifier;
  if (!CodeVerifierSchema.safeParse(verifier).success) {
    return oauthError('invalid_request', 400, 'code_verifier is malformed');
  }
  const refused = refuseDpop(request);
  if (refused !== null) return refused;
  const selection = tokenSelection(params, deps, WEB_CLIENT);
  if (selection instanceof Response) return selection;
  const stepUpRequested = stepUpRefusal(selection.scopes ?? [], deps);
  if (stepUpRequested !== null) return stepUpRequested;
  if (!isRandomCredential(code)) return grantError('invalid_grant');

  const handle = await browserSessionHandleOfExchange(code, verifier);
  const result = await deps.sessions(async sessions =>
    sessions.exchangeCode({
      environment: deps.config.environment,
      codeHash: await sha256(code),
      clientId: WEB_CLIENT.clientId,
      redirectUri,
      codeChallenge: await s256Challenge(verifier),
      assertion,
      handleHash: await sha256(handle),
      ...selection,
    })
  );
  if (result.outcome === 'assertion_replay') return invalidClient();
  if (result.outcome !== 'issued') return grantError(result.outcome);
  return await sessionGrant(deps, result, result.session, handle, {});
}

/** The `token_type` values RFC 8693 names for the bridge's subject token and its result. */
function bridgeTypesError(params: Params): Response | null {
  const subjectType = params.one('subject_token_type');
  const requestedType = params.one('requested_token_type');
  if (subjectType.status !== 'present' || subjectType.value !== UTS_JWT_TOKEN_TYPE) {
    return oauthError('invalid_request', 400, `subject_token_type must be ${UTS_JWT_TOKEN_TYPE}`);
  }
  if (
    requestedType.status === 'repeated' ||
    (requestedType.status === 'present' && requestedType.value !== UTS_ACCESS_TOKEN_TOKEN_TYPE)
  ) {
    return oauthError('invalid_request', 400, 'requested_token_type must be an access token');
  }
  if (params.one('actor_token').status !== 'absent' || params.all('audience').length > 0) {
    return oauthError('invalid_request', 400, 'the legacy bridge takes no actor or audience');
  }
  return null;
}

async function bridgeLegacySession(
  request: Request,
  params: Params,
  deps: WebClientDeps,
  assertion: JtiUse,
  keys: ClientKeys
): Promise<Response> {
  if (deps.bridge.status === 'off') return oauthError('unsupported_grant_type', 400);
  const typesError = bridgeTypesError(params);
  if (typesError !== null) return typesError;
  const subjectToken = required(params, 'subject_token');
  if (subjectToken instanceof Response) return subjectToken;
  const refused = refuseDpop(request);
  if (refused !== null) return refused;
  const selection = tokenSelection(params, deps, WEB_CLIENT);
  if (selection instanceof Response) return selection;
  const scopes = [...(selection.scopes ?? [UTS_BROWSER_SESSION_READ_SCOPE])].sort();
  // A legacy session is never a step-up.
  const stepUp = stepUpRefusal(scopes, deps);
  if (stepUp !== null) return stepUp;
  if (selection.resources !== null && targetMismatch(scopes, selection.resources)) {
    return grantError('invalid_target');
  }
  // A bridged session names no organization, so no scope that needs one can be minted from it.
  if (orgScopeRefusal(scopes, null, null, deps.scopes) !== null) {
    return oauthError('invalid_scope', 400, 'a requested scope needs an organization');
  }

  const nowSeconds = Math.floor(deps.now() / 1000);
  const legacy = await verifyLegacySessionToken(
    subjectToken,
    keys,
    tokenEndpointUrl(deps.config),
    nowSeconds
  );
  if (legacy === null) return grantError('invalid_grant');
  let sso: LegacySessionClaims['sso'] = null;
  if (legacy.sso !== null) {
    try {
      const verdict = await deps.bridge.authority({ subject: legacy.subject, ...legacy.sso });
      sso = verdict === 'verified' ? legacy.sso : null;
    } catch (error) {
      // Fails closed to no SSO provenance: the bridge still works, org-bound access does not.
      console.error(
        JSON.stringify({
          event: 'uts.bridge.authority_failed',
          error: error instanceof Error ? error.name : 'unknown',
        })
      );
    }
  }

  const handle = randomCredential();
  const result = await deps.sessions(async sessions =>
    sessions.bridge({
      environment: deps.config.environment,
      accountId: legacy.subject,
      authTime: new Date(legacy.authTime * 1000),
      sso,
      assertion,
      subjectToken: legacy.use,
      handleHash: await sha256(handle),
      scopes,
    })
  );
  if (result.outcome === 'assertion_replay') return invalidClient();
  if (result.outcome === 'invalid_scope') {
    return oauthError('invalid_scope', 400, 'a requested scope needs an organization role');
  }
  if (result.outcome !== 'issued') return grantError(result.outcome);
  return await sessionGrant(deps, result, result.session, handle, {
    issued_token_type: UTS_ACCESS_TOKEN_TOKEN_TYPE,
  });
}

/**
 * Serves a token request that carries a client assertion, which only `kilo-web` sends. Null when
 * the request carries none, so the caller serves it as another client's.
 */
export async function handleWebClientToken(
  request: Request,
  grantType: string,
  params: Params,
  deps: WebClientDeps
): Promise<Response | null> {
  try {
    const keys = await deps.keys();
    const auth = await authenticateWebClient(
      params,
      keys,
      tokenEndpointUrl(deps.config),
      Math.floor(deps.now() / 1000)
    );
    if (auth.status === 'absent') return null;
    if (auth.status === 'unavailable' || keys.status !== 'ready') return webClientUnavailable();
    if (auth.status === 'refused') return invalidClient();
    switch (grantType) {
      case UTS_GRANT_TYPES.authorizationCode:
        return await exchangeWebCode(request, params, deps, auth.assertion);
      case UTS_GRANT_TYPES.tokenExchange:
        return await bridgeLegacySession(request, params, deps, auth.assertion, keys.keys);
      default:
        return oauthError(
          'unauthorized_client',
          400,
          'the web client uses the code and legacy-session exchanges only'
        );
    }
  } catch (error) {
    return failureResponse(error, 'token');
  }
}
