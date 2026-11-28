import {
  type BotTokenDenial,
  BotTokenRequestSchema,
  type BotTokenResponse,
  UTS_BOT_TOKEN_MINT_SCOPE,
  UtsAccessTokenClaimsSchema,
  audienceOfScope,
} from '@kilocode/uts-contracts';
import type { UtsConfig } from '../env';
import { failureResponse, oauthError, temporarilyUnavailable } from '../oauth/errors';
import { jsonResponse } from '../responses';
import type { ScopeRegistry } from '../scopes/policy';
import { NO_VERIFIER_RETRY_SECONDS, type ServiceTokenVerifier } from '../subjects/service-tokens';
import type { SignerAccess } from '../token/mint';
import { type BotTokenPolicy, botTokenLifetimeSeconds } from './policy';
import type { BotTokenAccess } from './store';

/**
 * The bot-token mint at `POST /internal/bot-tokens` (design 5.3, 6.5). Wire contract in
 * `@kilocode/uts-contracts`, `bot-token.ts`.
 *
 * Steps, each refusing before the next costs anything:
 * 1. the switch: without policies the route is not offered (404);
 * 2. the caller: an STS token for audience `uts` and scope `uts:bot-token.mint` (`@kilocode/verify`
 *    in the deployed entry), from a workload that has at least one policy;
 * 3. the request: one bot account, one audience and one scope of that audience; the caller's
 *    policy for that account must grant the scope. These refusals write a log line, no row;
 * 4. one SQL statement (src/bot-token/store.ts): the account is active and an active owner or
 *    member of the policy's organization in a role the scope allows, and the audit row;
 * 5. one signer call for the one token, signed in the object its `jti` picks.
 */

/**
 * The mint as the environment configures it. `store` is null until the environment binds its
 * identity store, and every call then answers 503.
 */
export type BotTokenService =
  | { status: 'off' }
  | { status: 'misconfigured'; problems: readonly string[] }
  | { status: 'on'; policies: readonly BotTokenPolicy[]; store: BotTokenAccess | null };

export type BotTokenDeps = {
  config: UtsConfig;
  /** The STS token check; it admits any service workload, and the policies narrow it. */
  callers: ServiceTokenVerifier;
  scopes: ScopeRegistry;
  sign: SignerAccess;
  mint: BotTokenService;
  nowSeconds: () => number;
};

/** Logs a refusal of a known caller; the denials of the statement also write their audit row. */
function refused(reason: 'scope_not_granted' | BotTokenDenial, workload: string, account: string) {
  console.warn(JSON.stringify({ event: 'uts.bot_token.refused', reason, workload, account }));
}

/** Answers `POST /internal/bot-tokens` (`UTS_BOT_TOKEN_PATH`). */
export async function handleBotTokenRequest(
  request: Request,
  deps: BotTokenDeps
): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
  }

  // 1. The switch.
  const { mint } = deps;
  if (mint.status === 'misconfigured') {
    console.error(
      JSON.stringify({ event: 'uts.bot_token.misconfigured', problems: mint.problems })
    );
  }
  if (mint.status !== 'on') return jsonResponse({ error: 'not_found' }, 404);

  // 2. The caller.
  const check = await deps.callers(request.headers.get('Authorization'), UTS_BOT_TOKEN_MINT_SCOPE);
  switch (check.status) {
    case 'missing':
    case 'invalid':
      return jsonResponse({ error: 'invalid_token' }, 401, {
        'WWW-Authenticate': 'Bearer error="invalid_token"',
      });
    case 'insufficient_scope':
      return jsonResponse({ error: 'insufficient_scope' }, 403, {
        'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${UTS_BOT_TOKEN_MINT_SCOPE}"`,
      });
    case 'unavailable':
      return jsonResponse({ error: 'temporarily_unavailable' }, 503, {
        'Retry-After': String(check.retryAfterSeconds),
      });
    case 'workload_refused':
    case 'verified':
      break;
  }
  const workload = check.workload;
  const policies =
    workload === null ? [] : mint.policies.filter(policy => policy.workload === workload);
  if (workload === null || policies.length === 0) {
    console.warn(
      JSON.stringify({
        event: 'uts.internal.workload_refused',
        scope: UTS_BOT_TOKEN_MINT_SCOPE,
        workload,
      })
    );
    return jsonResponse({ error: 'insufficient_scope' }, 403);
  }
  if (mint.store === null) {
    return jsonResponse({ error: 'temporarily_unavailable' }, 503, {
      'Retry-After': String(NO_VERIFIER_RETRY_SECONDS),
    });
  }

  // 3. The request.
  const body = BotTokenRequestSchema.safeParse(await request.json().catch(() => undefined));
  if (!body.success) {
    return oauthError('invalid_request', 400, 'the body names account, audience and scope');
  }
  const { account, audience, scope } = body.data;
  if (audienceOfScope(scope) !== audience) {
    return oauthError('invalid_target', 400, 'audience must be the audience of the scope');
  }
  const policy = policies.find(candidate => candidate.account === account);
  if (policy === undefined) {
    refused('unknown_account', workload, account);
    return oauthError('access_denied', 403, 'unknown_account');
  }
  const entry = deps.scopes(scope);
  if (entry === null || !policy.scopes.includes(scope)) {
    refused('scope_not_granted', workload, account);
    return oauthError('invalid_scope', 400, 'the policy does not grant this scope');
  }
  const lifetimeSeconds = botTokenLifetimeSeconds(policy, entry);

  // 4. The statement.
  const nowSeconds = deps.nowSeconds();
  let stored;
  try {
    stored = await mint.store(store =>
      store.mint({
        environment: deps.config.environment,
        workload,
        accountId: account,
        orgId: policy.org,
        scope,
        lifetimeSeconds,
      })
    );
  } catch (error) {
    return failureResponse(error, 'bot_token');
  }
  if (stored.outcome !== 'issued') {
    refused(stored.outcome, workload, account);
    return oauthError('access_denied', 403, stored.outcome);
  }

  // 5. The signer call.
  const claims = UtsAccessTokenClaimsSchema.parse({
    iss: deps.config.endpoints.issuer,
    exp: nowSeconds + lifetimeSeconds,
    aud: audience,
    sub: account,
    client_id: workload,
    iat: nowSeconds,
    jti: stored.tokenId,
    scope,
    org: policy.org,
    req: workload,
    env: deps.config.environment,
    bot_user: true,
  });
  const signed = await deps.sign(stored.tokenId, [claims]);
  if (signed.status === 'unavailable') return temporarilyUnavailable();
  if (signed.status === 'misconfigured') return oauthError('server_error', 500);
  const answer: BotTokenResponse = {
    access_token: signed.tokens[0],
    token_type: 'Bearer',
    expires_in: lifetimeSeconds,
    audience,
    scope,
  };
  return jsonResponse(answer, 200, { Pragma: 'no-cache' });
}
