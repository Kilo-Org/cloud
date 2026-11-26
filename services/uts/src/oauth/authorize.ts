import {
  type OAuthErrorCode,
  UTS_MAX_TOKENS_PER_CALL,
  audienceOfScope,
} from '@kilocode/uts-contracts';
import { z } from 'zod';
import type { AUTH_METHODS } from '../db/enums';
import type { UtsConfig } from '../env';
import type { GrantsAccess, IssueCodeInput } from '../grants/store';
import { type ScopeRegistry, clientScopeRefusal, orgScopeRefusal } from '../scopes/policy';
import type { ThirdPartyClients } from '../third-party/clients';
import { randomCredential, sha256 } from '../token/credentials';
import {
  type FirstPartyClient,
  type RedirectRule,
  identifyClient,
  clientServedIn,
  isRegisteredRedirect,
} from './clients';
import { jktOfParameter } from './dpop';
import { classifyFailure, oauthError, temporarilyUnavailable } from './errors';
import { audiencesOfResources, paramsOf, parseScopes, targetMismatch } from './params';
import { CodeChallengeSchema } from './pkce';

/**
 * GET /authorize: OAuth 2.1 authorization code with PKCE S256 (design 5.4). The client id and the
 * redirect URI are checked first; an error there is shown to the user and never redirected
 * (RFC 6749 section 4.1.2.1). Every later error, and the code itself, goes back to the redirect
 * URI with `state` and `iss` (RFC 9207). The user's sign-in and consent come from the
 * authorization hand-off, which the sign-in and consent screens implement. A POST carries the same
 * query; only the hand-off's confirm page sends one, and its parameters stay those of the URL.
 */

/**
 * An authorization holds at most 8 scopes, the most one token call mints, so a token request that
 * names no scope (every granted scope, RFC 6749 section 6) always fits one call. At most 8 scopes
 * also means at most 8 audiences, the most a code stores.
 */
const MAX_AUTHORIZED_SCOPES = UTS_MAX_TOKENS_PER_CALL;
/** `state` round-trips unchanged; a longer value is refused rather than cut. */
const MAX_STATE_LENGTH = 1024;

export type AuthorizingClient =
  | {
      kind: 'first_party';
      clientId: string;
      name: string;
      clientClass: FirstPartyClient['clientClass'];
      /** How the client receives the code; a private-use scheme needs a fresh sign-in. */
      redirectKind: RedirectRule['kind'];
    }
  | { kind: 'third_party'; clientId: string; name: string };

/** What the hand-off shows and decides on. */
export type PendingAuthorization = {
  client: AuthorizingClient;
  redirectUri: string;
  /** Canonical: unique and in ascending byte order. */
  scopes: readonly string[];
  audiences: readonly string[];
  /** The organization the client asked for (`org`), which the user may change. */
  orgHint: string | null;
};

type ApprovalSubject = {
  accountId: string;
  /** The browser session the user approved in, when there is one. */
  browserSessionId: string | null;
  authTime: Date;
  amr: ReadonlyArray<(typeof AUTH_METHODS)[number]>;
  orgId: string | null;
};

/** A third-party approval names the consent it was given under (design 5.9). */
export type AuthorizationApproval = ApprovalSubject &
  ({ clientKind: 'first_party' } | { clientKind: 'third_party'; consentId: string });

export type HandoffResult =
  | { status: 'approved'; approval: AuthorizationApproval }
  | { status: 'denied' }
  /** The hand-off needs the user: its response (a sign-in or consent page) goes back as is. */
  | { status: 'interaction'; response: Response };

/**
 * The sign-in and consent hand-off: the sign-in pages' session (src/signin/handoff.ts) in a
 * deployed entry.
 */
export type AuthorizationHandoff = (
  request: Request,
  pending: PendingAuthorization
) => Promise<HandoffResult>;

export type AuthorizeDeps = {
  config: UtsConfig;
  grants: GrantsAccess;
  scopes: ScopeRegistry;
  handoff: AuthorizationHandoff;
  /** Third-party clients by their Client ID Metadata Document (src/third-party/clients.ts). */
  clients: ThirdPartyClients;
};

/** An error before the redirect URI is trusted: shown, never redirected. */
function directError(error: OAuthErrorCode, description: string, status = 400): Response {
  return oauthError(error, status, description);
}

function redirect(location: URL): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location.toString(), 'Cache-Control': 'no-store' },
  });
}

export async function handleAuthorize(request: Request, deps: AuthorizeDeps): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'POST') {
    return oauthError('invalid_request', 405, 'use GET', { Allow: 'GET, POST' });
  }
  const params = paramsOf(new URL(request.url).searchParams);

  const clientIdParam = params.one('client_id');
  const redirectParam = params.one('redirect_uri');
  if (clientIdParam.status !== 'present') {
    return directError('invalid_request', 'client_id is required once');
  }
  if (redirectParam.status !== 'present') {
    return directError('invalid_request', 'redirect_uri is required once');
  }
  const redirectUri = redirectParam.value;
  const identity = identifyClient(clientIdParam.value);
  let client: AuthorizingClient;
  if (identity.kind === 'first_party') {
    if (!isRegisteredRedirect(identity.client, redirectUri)) {
      return directError('invalid_request', 'redirect_uri is not registered for this client');
    }
    if (!clientServedIn(identity.client, deps.config.environment)) {
      return directError(
        'unauthorized_client',
        'this client needs device attestation, which this environment does not verify yet'
      );
    }
    client = {
      kind: 'first_party',
      clientId: identity.client.clientId,
      name: identity.client.name,
      clientClass: identity.client.clientClass,
      redirectKind: identity.client.redirect.kind,
    };
  } else if (identity.kind === 'third_party') {
    const resolved = await deps.clients(identity.clientId);
    if (resolved.kind === 'unavailable') return temporarilyUnavailable();
    if (resolved.kind === 'refused') return directError('invalid_client', 'unknown client', 401);
    const record = resolved.client;
    if (!record.redirectUris.includes(redirectUri)) {
      return directError('invalid_request', 'redirect_uri is not registered for this client');
    }
    client = { kind: 'third_party', clientId: record.clientId, name: record.name };
  } else {
    return directError('invalid_client', 'unknown client', 401);
  }

  // The redirect URI is trusted from here on.
  const stateParam = params.one('state');
  const state = stateParam.status === 'present' ? stateParam.value : null;
  const back = (outcome: Record<string, string>): Response => {
    const location = new URL(redirectUri);
    for (const [name, value] of Object.entries(outcome)) location.searchParams.set(name, value);
    if (state !== null) location.searchParams.set('state', state);
    location.searchParams.set('iss', deps.config.endpoints.issuer);
    return redirect(location);
  };
  const fail = (error: OAuthErrorCode, description: string): Response =>
    back({ error, error_description: description });

  if (stateParam.status === 'repeated' || (state !== null && state.length > MAX_STATE_LENGTH)) {
    return fail('invalid_request', 'state must appear once and hold at most 1024 characters');
  }
  const responseType = params.one('response_type');
  if (responseType.status !== 'present' || responseType.value !== 'code') {
    return fail('unsupported_response_type', 'response_type must be code');
  }
  const challenge = params.one('code_challenge');
  const method = params.one('code_challenge_method');
  if (
    challenge.status !== 'present' ||
    !CodeChallengeSchema.safeParse(challenge.value).success ||
    method.status !== 'present' ||
    method.value !== 'S256'
  ) {
    return fail('invalid_request', 'PKCE with code_challenge_method S256 is required');
  }

  const scopeParam = params.one('scope');
  const requested =
    scopeParam.status === 'present' ? parseScopes(scopeParam.value, MAX_AUTHORIZED_SCOPES) : null;
  if (requested === null) {
    return fail('invalid_scope', 'scope must name at most 8 UTS scopes once each');
  }
  const scopes = [...requested].sort();
  if (clientScopeRefusal(scopes, client, deps.scopes) !== null) {
    return fail('invalid_scope', 'a requested scope is not registered for this client');
  }

  const resources = params.all('resource');
  let audiences = [...new Set(scopes.map(audienceOfScope))];
  if (resources.length > 0) {
    const named = audiencesOfResources(resources, deps.config.environment);
    if (named === null || targetMismatch(scopes, named)) {
      return fail(
        'invalid_target',
        'each resource must name a Kilo service that a scope belongs to'
      );
    }
    audiences = named;
  }

  // RFC 9449 section 10: a first-party code is bound to the DPoP key of its later token request.
  const jktParam = params.one('dpop_jkt');
  let dpopJkt: Uint8Array | null = null;
  if (client.kind === 'first_party') {
    dpopJkt = jktParam.status === 'present' ? jktOfParameter(jktParam.value) : null;
    if (dpopJkt === null) return fail('invalid_request', 'dpop_jkt is required for this client');
  } else if (jktParam.status !== 'absent') {
    return fail('invalid_request', 'DPoP binding is available to first-party clients only');
  }

  const orgParam = params.one('org');
  const orgHint =
    orgParam.status === 'present' ? (z.uuid().safeParse(orgParam.value).data ?? null) : null;
  if (orgParam.status === 'repeated' || (orgParam.status === 'present' && orgHint === null)) {
    return fail('invalid_request', 'org must be one organization id');
  }

  const decision = await deps.handoff(request, {
    client,
    redirectUri,
    scopes,
    audiences,
    orgHint,
  });
  if (decision.status === 'interaction') return decision.response;
  if (decision.status === 'denied') return fail('access_denied', 'the user denied the request');
  const { approval } = decision;
  // Without an organization no organization scope can pass, so no code is stored for it.
  if (approval.orgId === null && orgScopeRefusal(scopes, null, null, deps.scopes) !== null) {
    return fail('invalid_scope', 'a requested scope needs an organization');
  }

  let codeClient: IssueCodeInput['client'];
  if (client.kind === 'first_party' && approval.clientKind === 'first_party' && dpopJkt !== null) {
    codeClient = { kind: 'first_party', clientId: client.clientId, dpopJkt };
  } else if (client.kind === 'third_party' && approval.clientKind === 'third_party') {
    codeClient = { kind: 'third_party', clientId: client.clientId, consentId: approval.consentId };
  } else {
    console.error(JSON.stringify({ event: 'uts.authorize.handoff_mismatch', client: client.kind }));
    return fail('server_error', 'the authorization could not be completed');
  }

  const code = randomCredential();
  let outcome;
  try {
    outcome = await deps.grants(async grants =>
      grants.issueCode({
        environment: deps.config.environment,
        codeHash: await sha256(code),
        client: codeClient,
        accountId: approval.accountId,
        browserSessionId: approval.browserSessionId,
        redirectUri,
        audiences,
        scopes,
        orgId: approval.orgId,
        codeChallenge: challenge.value,
        authTime: approval.authTime,
        amr: approval.amr,
      })
    );
  } catch (error) {
    const failure = classifyFailure(error, 'authorize');
    return fail(
      failure === 'retryable' ? 'temporarily_unavailable' : 'server_error',
      'the authorization could not be completed'
    );
  }
  if (outcome.outcome === 'invalid_scope') {
    // The statement stored nothing: the caller's role in the organization is not one the scope
    // registry lists for a requested scope (`uts.scope_org_roles`).
    return fail('invalid_scope', 'a requested scope needs another role in the organization');
  }
  if (outcome.outcome !== 'issued') {
    return fail(
      'access_denied',
      outcome.outcome === 'consent_required'
        ? 'consent is required'
        : 'the account cannot authorize'
    );
  }
  return back({ code });
}
