import {
  type BotKeyList,
  CreateBotKeyRequestSchema,
  type CreatedBotKey,
  type CreatedPat,
  CreatePatRequestSchema,
  type PatList,
  UTS_BOT_KEYS_MANAGE_SCOPE,
  UTS_CREDENTIAL_DEFAULT_LIFETIME_DAYS,
  UTS_ORGS_PATH,
  UTS_PATS_MANAGE_SCOPE,
  UTS_PATS_PATH,
  audienceOfScope,
} from '@kilocode/uts-contracts';
import type { z } from 'zod';
import type { WaitUntil } from '../db/client';
import type { UtsConfig } from '../env';
import { gateRequiredResponse } from '../gates/challenge';
import { failureResponse } from '../oauth/errors';
import { createSecret, lastFour, secretHash, type SecretKind } from '../pat/format';
import { jsonResponse } from '../responses';
import type { FeedPublish } from '../revocation/publish';
import { credentialScopeCheck } from '../scopes/policy';
import { type AccessTokenKeys, type AccountCaller, checkAccountBearer } from './bearer';
import {
  accountError,
  credentialInvalid,
  credentialMissing,
  dependencyUnavailable,
  insufficientScope,
  methodNotAllowed,
} from './responses';
import type { AccountAccess, RevokeBotKeyResult } from './store';

/**
 * The account API for PATs and org bot keys (design 5.3, 5.5, 5.8, 5.11). Every route takes a UTS
 * access token for the `uts` audience with the route's scope and a `sid`; each action is one
 * statement that checks the grant and its session (a revoked grant fails there at once), runs the
 * tier B gate for a create, and writes the audit row with the credential.
 *
 * | Route | Scope |
 * |---|---|
 * | `POST /account/pats`, `GET /account/pats`, `DELETE /account/pats/<id>` | `uts:pats.manage` |
 * | `POST`/`GET /account/orgs/<org>/bot-keys`, `DELETE .../<id>`, `POST .../<id>/keep` | `uts:bot-keys.manage`, as an owner or admin of `<org>` |
 *
 * A PAT or bot key value appears once, in the create answer, and never in a log or an audit row.
 */

/** What a created credential's owner hears about it by push and email (design 5.13). */
export type CredentialNotice = {
  kind: 'pat_created' | 'bot_key_created';
  accountId: string;
  credentialId: string;
};

/**
 * Sends the push and email notice of a created credential. The create statement already wrote the
 * in-app notice row, which the security page always shows; null where no notice provider is wired.
 */
export type CredentialNotices = (notice: CredentialNotice) => Promise<void>;

export type AccountDeps = {
  config: UtsConfig;
  account: AccountAccess;
  keys: AccessTokenKeys;
  notices: CredentialNotices | null;
  /** Writes a committed revoke's feed entries to the feed objects (src/revocation/publish.ts). */
  publish: FeedPublish;
  context: WaitUntil;
  nowSeconds: () => number;
};

/** A create body holds a name and a few short fields; a larger body is refused unread. */
const MAX_BODY_BYTES = 4 * 1024;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PAT_ITEM = new RegExp(`^${UTS_PATS_PATH}/(${UUID})$`);
const BOT_KEYS = new RegExp(`^${UTS_ORGS_PATH}/(${UUID})/bot-keys$`);
const BOT_KEY_ITEM = new RegExp(`^${UTS_ORGS_PATH}/(${UUID})/bot-keys/(${UUID})$`);
const BOT_KEY_KEEP = new RegExp(`^${UTS_ORGS_PATH}/(${UUID})/bot-keys/(${UUID})/keep$`);

type Route =
  | { kind: 'pats' }
  | { kind: 'pat'; patId: string }
  | { kind: 'bot_keys'; orgId: string }
  | { kind: 'bot_key'; orgId: string; keyId: string }
  | { kind: 'bot_key_keep'; orgId: string; keyId: string };

function routeOf(pathname: string): Route | null {
  if (pathname === UTS_PATS_PATH) return { kind: 'pats' };
  const pat = PAT_ITEM.exec(pathname);
  if (pat !== null) return { kind: 'pat', patId: pat[1] };
  const botKeys = BOT_KEYS.exec(pathname);
  if (botKeys !== null) return { kind: 'bot_keys', orgId: botKeys[1] };
  const botKey = BOT_KEY_ITEM.exec(pathname);
  if (botKey !== null) return { kind: 'bot_key', orgId: botKey[1], keyId: botKey[2] };
  const keep = BOT_KEY_KEEP.exec(pathname);
  if (keep !== null) return { kind: 'bot_key_keep', orgId: keep[1], keyId: keep[2] };
  return null;
}

type Body<Schema extends z.ZodType> =
  | { status: 'ok'; value: z.output<Schema> }
  | { status: 'invalid'; response: Response };

async function readJson<Schema extends z.ZodType>(
  request: Request,
  schema: Schema
): Promise<Body<Schema>> {
  const invalid = (description: string): Body<Schema> => ({
    status: 'invalid',
    response: accountError('invalid_request', 400, description),
  });
  const contentType = request.headers.get('Content-Type') ?? '';
  if (contentType.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return invalid('the body must be application/json');
  }
  if (Number(request.headers.get('Content-Length') ?? '0') > MAX_BODY_BYTES) {
    return invalid('the body is too large');
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return invalid('the body is too large');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return invalid('the body is not JSON');
  }
  const parsed = schema.safeParse(json);
  return parsed.success
    ? { status: 'ok', value: parsed.data }
    : invalid('the body does not match the request schema');
}

function scopeRefusal(scope: string, orgId: string | null): Response | null {
  const check = credentialScopeCheck(scope, orgId);
  switch (check.status) {
    case 'allowed':
      return null;
    case 'unknown_scope':
      return accountError('invalid_scope', 400, 'the scope registry does not list this scope');
    case 'not_pat_eligible':
      return accountError(
        'invalid_scope',
        400,
        'this scope cannot be held by a long-lived credential'
      );
    case 'org_required':
      return accountError(
        'invalid_request',
        400,
        'this scope needs the credential bound to an organization'
      );
  }
}

const invalidSession = (config: UtsConfig) =>
  credentialInvalid(config, 'the session of this token has ended');

const notOrgAdmin = () =>
  accountError('access_denied', 403, 'only an owner or admin of the organization can do this');

function notify(deps: AccountDeps, notice: CredentialNotice): void {
  const send = deps.notices;
  if (send === null) return;
  deps.context.waitUntil(
    send(notice).catch((error: unknown) => {
      console.error(
        JSON.stringify({
          event: 'uts.account.notice_failed',
          kind: notice.kind,
          error: String(error),
        })
      );
    })
  );
}

/** A new credential value and what the identity store keeps of it. */
async function newCredential(kind: SecretKind) {
  const token = createSecret(kind);
  return { token, hash: await secretHash(token), lastFour: lastFour(token) };
}

async function createPat(request: Request, caller: AccountCaller, deps: AccountDeps) {
  const body = await readJson(request, CreatePatRequestSchema);
  if (body.status === 'invalid') return body.response;
  const { name, scope } = body.value;
  const orgId = body.value.org ?? null;
  if (caller.orgId !== null && orgId !== caller.orgId) {
    return accountError('org_mismatch', 403, 'the token is bound to another organization');
  }
  const refusal = scopeRefusal(scope, orgId);
  if (refusal !== null) return refusal;
  const credential = await newCredential('pat');
  const result = await deps.account(store =>
    store.createPat({
      environment: deps.config.environment,
      accountId: caller.accountId,
      grantId: caller.grantId,
      name,
      tokenHash: credential.hash,
      lastFour: credential.lastFour,
      scope,
      orgId,
      lifetimeDays: body.value.expires_in_days ?? UTS_CREDENTIAL_DEFAULT_LIFETIME_DAYS,
    })
  );
  switch (result.outcome) {
    case 'invalid_session':
      return invalidSession(deps.config);
    case 'gate_required':
      return gateRequiredResponse();
    case 'org_denied':
      return accountError('access_denied', 403, 'the account cannot act in this organization');
    case 'limit_reached':
      return accountError('limit_reached', 409, 'the account holds 100 live PATs');
    case 'created': {
      notify(deps, { kind: 'pat_created', accountId: caller.accountId, credentialId: result.id });
      const created: CreatedPat = {
        id: result.id,
        token: credential.token,
        name,
        audience: audienceOfScope(scope),
        scope,
        org: orgId,
        last_four: credential.lastFour,
        created_at: result.createdAt.toISOString(),
        expires_at: result.expiresAt.toISOString(),
      };
      return jsonResponse(created, 201);
    }
  }
}

async function createBotKey(
  request: Request,
  caller: AccountCaller,
  orgId: string,
  deps: AccountDeps
) {
  const body = await readJson(request, CreateBotKeyRequestSchema);
  if (body.status === 'invalid') return body.response;
  const { name, scope } = body.value;
  const refusal = scopeRefusal(scope, orgId);
  if (refusal !== null) return refusal;
  const credential = await newCredential('bot_key');
  const result = await deps.account(store =>
    store.createBotKey({
      environment: deps.config.environment,
      accountId: caller.accountId,
      grantId: caller.grantId,
      orgId,
      name,
      tokenHash: credential.hash,
      lastFour: credential.lastFour,
      scope,
      lifetimeDays: body.value.expires_in_days ?? UTS_CREDENTIAL_DEFAULT_LIFETIME_DAYS,
    })
  );
  switch (result.outcome) {
    case 'invalid_session':
      return invalidSession(deps.config);
    case 'gate_required':
      return gateRequiredResponse();
    case 'not_org_admin':
      return notOrgAdmin();
    case 'limit_reached':
      return accountError('limit_reached', 409, 'the organization holds 100 live bot keys');
    case 'created': {
      notify(deps, {
        kind: 'bot_key_created',
        accountId: caller.accountId,
        credentialId: result.id,
      });
      const created: CreatedBotKey = {
        id: result.id,
        token: credential.token,
        org: orgId,
        name,
        audience: audienceOfScope(scope),
        scope,
        last_four: credential.lastFour,
        created_by: caller.accountId,
        created_at: result.createdAt.toISOString(),
        expires_at: result.expiresAt.toISOString(),
      };
      return jsonResponse(created, 201);
    }
  }
}

/** Seconds a client waits before it retries a revoke whose feed entry no feed object took. */
const UNPUBLISHED_RETRY_SECONDS = 2;

/**
 * The answer to a PAT or bot key revoke. A revoke publishes the feed entry its statement wrote, as
 * `/revoke` does (design 5.6): it answers 204 once one feed object confirms, and 503 when neither
 * does; the revocation stands, the backfill adds the entry, and the retry finds it revoked.
 */
async function revokeResponse(
  result: RevokeBotKeyResult,
  deps: AccountDeps
): Promise<Response> {
  switch (result.outcome) {
    case 'revoked':
    case 'already_revoked':
      if ((await deps.publish(result.feedEntries)) === 'unpublished') {
        return dependencyUnavailable(UNPUBLISHED_RETRY_SECONDS);
      }
      return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
    case 'not_found':
      return accountError('not_found', 404, 'no such credential');
    case 'invalid_session':
      return invalidSession(deps.config);
    case 'not_org_admin':
      return notOrgAdmin();
  }
}

async function patRoute(
  request: Request,
  route: Extract<Route, { kind: 'pats' | 'pat' }>,
  caller: AccountCaller,
  deps: AccountDeps
) {
  if (route.kind === 'pats') {
    if (request.method === 'POST') return await createPat(request, caller, deps);
    if (request.method !== 'GET') return methodNotAllowed('GET, POST');
    const result = await deps.account(store => store.listPats(caller));
    if (result.outcome === 'invalid_session') return invalidSession(deps.config);
    const body: PatList = { pats: result.pats };
    return jsonResponse(body, 200);
  }
  if (request.method !== 'DELETE') return methodNotAllowed('DELETE');
  const result = await deps.account(store =>
    store.revokePat({ environment: deps.config.environment, ...caller, patId: route.patId })
  );
  return await revokeResponse(result, deps);
}

async function botKeyRoute(
  request: Request,
  route: Exclude<Route, { kind: 'pats' | 'pat' }>,
  caller: AccountCaller,
  deps: AccountDeps
) {
  if (caller.orgId !== null && route.orgId !== caller.orgId) {
    return accountError('org_mismatch', 403, 'the token is bound to another organization');
  }
  const session = { ...caller, orgId: route.orgId };
  switch (route.kind) {
    case 'bot_keys': {
      if (request.method === 'POST') return await createBotKey(request, caller, route.orgId, deps);
      if (request.method !== 'GET') return methodNotAllowed('GET, POST');
      const result = await deps.account(store => store.listBotKeys(session));
      if (result.outcome !== 'listed') {
        return result.outcome === 'invalid_session' ? invalidSession(deps.config) : notOrgAdmin();
      }
      const body: BotKeyList = { bot_keys: result.botKeys };
      return jsonResponse(body, 200);
    }
    case 'bot_key': {
      if (request.method !== 'DELETE') return methodNotAllowed('DELETE');
      const result = await deps.account(store =>
        store.revokeBotKey({ environment: deps.config.environment, ...session, keyId: route.keyId })
      );
      return await revokeResponse(result, deps);
    }
    case 'bot_key_keep': {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      const outcome = await deps.account(store =>
        store.keepBotKey({ environment: deps.config.environment, ...session, keyId: route.keyId })
      );
      switch (outcome) {
        case 'kept':
          return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
        case 'not_flagged':
          return accountError('not_flagged', 409, 'the key is not flagged');
        case 'lapsed':
          return accountError('lapsed', 409, 'the key stopped 7 days after it was flagged');
        case 'not_found':
          return accountError('not_found', 404, 'no such credential');
        case 'invalid_session':
          return invalidSession(deps.config);
        case 'not_org_admin':
          return notOrgAdmin();
        case 'gate_required':
          return gateRequiredResponse();
      }
    }
  }
}

/** The response for an account route, or null when `pathname` names none. */
export async function handleAccountRequest(
  request: Request,
  pathname: string,
  deps: AccountDeps
): Promise<Response | null> {
  const route = routeOf(pathname);
  if (route === null) return null;
  const scope =
    route.kind === 'pats' || route.kind === 'pat'
      ? UTS_PATS_MANAGE_SCOPE
      : UTS_BOT_KEYS_MANAGE_SCOPE;
  const bearer = await checkAccountBearer(
    request.headers.get('Authorization'),
    scope,
    deps.config,
    deps.keys,
    deps.nowSeconds()
  );
  switch (bearer.status) {
    case 'missing':
      return credentialMissing(deps.config);
    case 'invalid':
      return credentialInvalid(deps.config, 'the access token is not valid for this route');
    case 'client_not_allowed':
      return accountError('access_denied', 403, 'this client may not use this route');
    case 'insufficient_scope':
      return insufficientScope(deps.config, scope);
    case 'unavailable':
      return dependencyUnavailable(2);
    case 'ok':
      break;
  }
  try {
    return route.kind === 'pats' || route.kind === 'pat'
      ? await patRoute(request, route, bearer.caller, deps)
      : await botKeyRoute(request, route, bearer.caller, deps);
  } catch (error) {
    return failureResponse(error, `account.${route.kind}`);
  }
}
