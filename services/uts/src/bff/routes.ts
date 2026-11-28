import {
  SessionHandleSchema,
  UTS_BROWSER_SESSION_END_ALL_PATH,
  UTS_BROWSER_SESSION_END_PATH,
  UTS_BROWSER_SESSION_READ_PATH,
  UTS_BROWSER_SESSION_TOKEN_PATH,
  UTS_DEVICE_REVOKE_PATH,
  UTS_RESOURCE_ORIGINS,
  UtsScopeSchema,
} from '@kilocode/uts-contracts';
import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { failureResponse, oauthError, temporarilyUnavailable } from '../oauth/errors';
import { type Params, readForm } from '../oauth/params';
import { signMinted } from '../oauth/token-endpoint';
import { jsonResponse } from '../responses';
import type { FeedEntry } from '../revocation/entries';
import { clientScopeRefusal } from '../scopes/policy';
import { sha256 } from '../token/credentials';
import { type JtiUse, authenticateWebClient } from './client-auth';
import { type WebClientDeps, WEB_MINT_CLIENT } from './deps';
import { handleRetryAfter } from './limits';
import {
  invalidClient,
  invalidSession,
  orgDenied,
  sessionFields,
  slowDown,
  stepUpRequired,
  webClientUnavailable,
} from './responses';
import type { HandleInput } from './store';

/**
 * The browser-session API of the web BFF (design 5.3, 5.5): `read`, `token`, `end` and `end-all`
 * under `/account/browser-sessions/`, and `/account/devices/revoke`. Each is a form POST with the
 * `kilo-web` client assertion for its exact URL and the session handle, and runs one SQL statement,
 * which also records the assertion's `jti`. A handle is counted against its per-isolate allowance
 * before the statement (src/bff/limits.ts). The revoking calls answer 200 only once a feed object
 * that vouches for its list took the entries, else 503 with `Retry-After`; a repeat returns the
 * entries still in the feed, so the retry publishes them. `token` binds its token to the `org` it
 * names only when the minting statement finds the subject an active member there (design 5.8).
 */

const BROWSER_SESSION_PATHS = [
  UTS_BROWSER_SESSION_READ_PATH,
  UTS_BROWSER_SESSION_TOKEN_PATH,
  UTS_BROWSER_SESSION_END_PATH,
  UTS_BROWSER_SESSION_END_ALL_PATH,
  UTS_DEVICE_REVOKE_PATH,
] as const;
type BrowserSessionPath = (typeof BROWSER_SESSION_PATHS)[number];

export function isBrowserSessionPath(pathname: string): pathname is BrowserSessionPath {
  return BROWSER_SESSION_PATHS.some(path => path === pathname);
}

/** A verified call: its handle's hash and the assertion the statement records. */
type Caller = { handleHash: Uint8Array; assertion: JtiUse };

/** Answers 200 with `body` once the entries are in a vouching feed object, else 503. */
async function afterPublish(
  deps: WebClientDeps,
  entries: readonly FeedEntry[],
  body: Record<string, unknown>
): Promise<Response> {
  const published = await deps.publish(entries);
  return published === 'published' ? jsonResponse(body, 200) : temporarilyUnavailable();
}

const SidSchema = z.uuid();
const OrgSchema = z.uuid();

/** The answer to a statement that refused the call. */
function refusal(
  outcome: 'assertion_replay' | 'invalid_session' | 'org_denied' | 'step_up_required'
): Response {
  if (outcome === 'assertion_replay') return invalidClient();
  if (outcome === 'invalid_session') return invalidSession();
  if (outcome === 'org_denied') return orgDenied();
  return stepUpRequired();
}

async function mintSessionToken(
  params: Params,
  deps: WebClientDeps,
  input: HandleInput
): Promise<Response> {
  const scopeParam = params.one('scope');
  const resourceParam = params.one('resource');
  if (scopeParam.status !== 'present' || resourceParam.status !== 'present') {
    return oauthError('invalid_request', 400, 'scope and resource are required once');
  }
  const orgParam = params.one('org');
  const org = orgParam.status === 'present' ? OrgSchema.safeParse(orgParam.value) : null;
  if (orgParam.status === 'repeated' || (org !== null && !org.success)) {
    return oauthError('invalid_request', 400, 'org must be one organization id');
  }
  const orgId = org?.data ?? null;
  const scope = UtsScopeSchema.safeParse(scopeParam.value);
  const client = WEB_MINT_CLIENT;
  const entry = scope.success ? deps.scopes(scope.data) : null;
  if (
    !scope.success ||
    entry === null ||
    clientScopeRefusal([scope.data], client, deps.scopes) !== null
  ) {
    return oauthError('invalid_scope', 400, 'the scope is not registered for this client');
  }
  // Without an organization no scope that needs one can pass (design 5.8).
  if (entry.requiresOrgClaim && orgId === null) {
    return oauthError('invalid_scope', 400, 'this scope needs an organization');
  }
  const origins = UTS_RESOURCE_ORIGINS[deps.config.environment];
  if (
    !Object.hasOwn(origins, resourceParam.value) ||
    origins[resourceParam.value] !== entry.audience
  ) {
    return oauthError('invalid_target', 400, "resource must be the scope's service origin");
  }
  const result = await deps.sessions(sessions =>
    sessions.mint({ ...input, scope: scope.data, stepUp: entry.stepUp, orgId })
  );
  if (result.outcome !== 'issued') return refusal(result.outcome);
  const signed = await signMinted(deps, client, result.sessionId, result);
  if (signed instanceof Response) return signed;
  const [claims] = signed.claims;
  return jsonResponse(
    {
      access_token: signed.tokens[0],
      token_type: 'Bearer',
      expires_in: claims.exp - claims.iat,
      scope: claims.scope,
    },
    200,
    { Pragma: 'no-cache' }
  );
}

async function serve(
  path: BrowserSessionPath,
  params: Params,
  deps: WebClientDeps,
  caller: Caller
): Promise<Response> {
  const input: HandleInput = { environment: deps.config.environment, ...caller };
  switch (path) {
    case UTS_BROWSER_SESSION_READ_PATH: {
      const result = await deps.sessions(sessions => sessions.read(caller));
      if (result.outcome !== 'active') return refusal(result.outcome);
      return jsonResponse({ status: 'active', ...sessionFields(result.session) }, 200);
    }
    case UTS_BROWSER_SESSION_TOKEN_PATH:
      return await mintSessionToken(params, deps, input);
    case UTS_BROWSER_SESSION_END_PATH: {
      const result = await deps.sessions(sessions => sessions.end(input));
      if (result.outcome !== 'ended' && result.outcome !== 'already_ended') {
        return refusal(result.outcome);
      }
      return await afterPublish(
        deps,
        result.feedEntries,
        result.outcome === 'ended'
          ? { status: 'ended', session_id: result.sessionId }
          : { status: 'ended' }
      );
    }
    case UTS_BROWSER_SESSION_END_ALL_PATH: {
      const result = await deps.sessions(sessions => sessions.endAll(input));
      if (result.outcome === 'assertion_replay') return invalidClient();
      return await afterPublish(deps, result.feedEntries, {
        status: 'ended',
        ended: result.ended,
      });
    }
    case UTS_DEVICE_REVOKE_PATH: {
      const sidParam = params.one('sid');
      const sid = sidParam.status === 'present' ? SidSchema.safeParse(sidParam.value) : null;
      if (sid === null || !sid.success) {
        return oauthError('invalid_request', 400, 'sid must name one device session or grant');
      }
      const result = await deps.sessions(sessions =>
        sessions.revokeDevice({ ...input, sid: sid.data })
      );
      if (result.outcome !== 'ended') return refusal(result.outcome);
      return await afterPublish(deps, result.feedEntries, { status: 'ended' });
    }
  }
}

/** The response for a browser-session path, or null when `pathname` is not one. */
export async function handleBrowserSessionRequest(
  request: Request,
  pathname: string,
  deps: WebClientDeps
): Promise<Response | null> {
  if (!isBrowserSessionPath(pathname)) return null;
  if (request.method !== 'POST') {
    return oauthError('invalid_request', 405, 'use POST', { Allow: 'POST' });
  }
  try {
    const form = await readForm(request);
    if (form.status === 'invalid') return oauthError('invalid_request', 400, form.description);
    const nowMs = deps.now();
    const keys = await deps.keys();
    const auth = await authenticateWebClient(
      form.params,
      keys,
      `${deps.config.endpoints.issuer}${pathname}`,
      Math.floor(nowMs / 1000)
    );
    if (auth.status === 'unavailable') return webClientUnavailable();
    if (auth.status !== 'authenticated') return invalidClient();
    const handleParam = form.params.one('session_handle');
    const handle =
      handleParam.status === 'present' ? SessionHandleSchema.safeParse(handleParam.value) : null;
    if (handle === null || !handle.success) {
      return oauthError('invalid_request', 400, 'session_handle is required once');
    }
    const handleHash = await sha256(handle.data);
    const retryAfter = handleRetryAfter(
      deps.windows,
      Buffer.from(handleHash).toString('base64url'),
      nowMs
    );
    if (retryAfter !== null) return slowDown(retryAfter);
    return await serve(pathname, form.params, deps, { handleHash, assertion: auth.assertion });
  } catch (error) {
    return failureResponse(error, 'browser_sessions');
  }
}
