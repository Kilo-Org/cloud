import {
  UTS_AUTHORIZATION_SERVER_METADATA_PATH,
  UTS_BOT_TOKEN_PATH,
  UTS_PAT_PROBE_PATH,
  UTS_PROTECTED_RESOURCE_METADATA_PATH,
  utsScopeEntry,
} from '@kilocode/uts-contracts';
import { shardAccessTokenKeys } from './account/bearer';
import { isBrowserSessionPath } from './bff/routes';
import { webClientUnavailable } from './bff/responses';
import { type AccountDeps, handleAccountRequest } from './account/routes';
import { identityStoreAccount } from './account/store';
import { withIdentityStore } from './db/client';
import { patLookupsInFlight, readConfig, type Env, type UtsConfig } from './env';
import { identityStoreBinding } from './grants/binding';
import { authorizationServerMetadata } from './metadata/authorization-server';
import { protectedResourceMetadata } from './metadata/protected-resource';
import { type HandoffChoice, handleOAuthRequest, oauthService } from './oauth/routes';
import type { AddressWindows } from './pat/address-limit';
import { identityStorePatLookup, lookupPatHash, patStoreBinding } from './pat/lookup';
import { type PatProbeDeps, handlePatProbe } from './pat/probe';
import { jsonResponse } from './responses';
import { feedPublisher } from './revocation/publish';
import type { ScopeRegistry } from './scopes/policy';
import { type CredentialNotices, credentialNotices } from './notices/credential';
import { noticesAccess } from './notices/store';
import { type UtsSecrets, requestSecrets } from './secrets';
import { noticeEmailTransport, platformFetch } from './signin/email/delivery';
import type { SignInMailer } from './signin/email/mailer';
import { mailSettingsFor } from './signin/providers/config';
import { subjectDeps } from './subjects/deps';
import { handleInternalRequest } from './subjects/routes';
import type { ServiceTokenVerifier } from './subjects/service-tokens';
import type { MetadataFetcher } from './third-party/metadata';
import { type SignerAccess, signerAccess } from './token/mint';
import type { StsCallerVerifier } from './exchange/endpoint';
import { MANAGER_JWKS_PATH } from './manager/config';
import { managerKeySet } from './manager/key-set';
import { deployedStsCallers } from './sts-callers';
import { botTokenPolicies } from './bot-token/policy';
import { type BotTokenDeps, handleBotTokenRequest } from './bot-token/route';
import { botTokenAccess } from './bot-token/store';

/**
 * What only the development entry adds: a choice of the synthetic sign-in hand-off, a failing
 * signer for the local end-to-end run, the development fixture scopes on top of the scope
 * registry, a recording mail port for the email sign-in, a metadata fetch that serves the local
 * end-to-end run's client documents, a stand-in STS token verifier of the broker exchange and a
 * stand-in STS token check for the `/internal/` routes, the bot-token route's included
 * (src/dev.ts). The deployed options are the sign-in pages, the grant's signer, the registry
 * alone, no recording mail port (mail goes through Mailgun where the mail settings are on,
 * src/signin/email/delivery.ts), the platform `fetch`, and the STS checks of `@kilocode/verify`
 * with this environment's caller allow-lists (src/sts-callers.ts).
 */
export type MintOptions = {
  authorizationHandoff: HandoffChoice | null;
  signer: SignerAccess | null;
  scopes: ScopeRegistry;
  recordingMailer: SignInMailer | null;
  serviceTokens: ServiceTokenVerifier;
  botTokenCallers: ServiceTokenVerifier;
  metadataFetcher: MetadataFetcher;
  stsCallers: StsCallerVerifier | null;
};

/** The deployed options; the STS checks need the request's context (`deployedStsCallers`). */
const DEPLOYED: Omit<MintOptions, 'serviceTokens' | 'botTokenCallers' | 'stsCallers'> = {
  authorizationHandoff: null,
  signer: null,
  scopes: utsScopeEntry,
  recordingMailer: null,
  metadataFetcher: (url, init) => fetch(url, init),
};

/** The probe route's per-address lookup windows, per isolate (src/pat/address-limit.ts). */
const probeWindows: AddressWindows = new Map();

/**
 * The bot-token mint of this environment's `BOT_TOKEN_POLICIES` (src/bot-token/). Its store
 * waits for the identity store's primary config; until then a call from a listed workload
 * answers 503.
 */
function botTokenDeps(
  env: Env,
  ctx: ExecutionContext,
  config: UtsConfig,
  mint: MintOptions
): BotTokenDeps {
  const policies = botTokenPolicies(env, mint.scopes);
  const binding = identityStoreBinding(env);
  return {
    config,
    callers: mint.botTokenCallers,
    scopes: mint.scopes,
    sign: mint.signer ?? signerAccess(env, config),
    mint:
      policies.status === 'on'
        ? {
            status: 'on',
            policies: policies.policies,
            store: binding.kind === 'ready' ? botTokenAccess(binding.connectionString, ctx) : null,
          }
        : policies,
    nowSeconds: () => Math.floor(Date.now() / 1000),
  };
}

/**
 * The account API is served once the identity store's primary config is bound. A created
 * credential's notice goes out at once by email where the mail settings are on (push has no
 * deployed provider yet); elsewhere, and while STS gives no usable bundle, the minute cron settles
 * it. The notice runs after the answer, so the account routes never wait for STS.
 */
function accountDeps(
  env: Env,
  ctx: ExecutionContext,
  config: UtsConfig,
  secrets: () => Promise<UtsSecrets>
): AccountDeps | null {
  const binding = identityStoreBinding(env);
  if (binding.kind === 'unprovisioned') return null;
  const notices: CredentialNotices = async notice => {
    const email = noticeEmailTransport(await mailSettingsFor(env, secrets, config), platformFetch);
    if (email === null) return;
    await credentialNotices({
      notices: noticesAccess(binding.connectionString, ctx),
      transports: { push: null, email },
      now: () => new Date(),
    })(notice);
  };
  return {
    config,
    account: work =>
      withIdentityStore(binding.connectionString, ctx, store => work(identityStoreAccount(store))),
    keys: shardAccessTokenKeys(env, config),
    notices,
    publish: feedPublisher(env, config, ctx),
    context: ctx,
    nowSeconds: () => Math.floor(Date.now() / 1000),
  };
}

/** The PAT probe route is served once the PAT lookup config is bound. */
function probeDeps(env: Env, ctx: ExecutionContext, config: UtsConfig): PatProbeDeps | null {
  const binding = patStoreBinding(env);
  if (binding.kind === 'unprovisioned') return null;
  const store = identityStorePatLookup(binding.connectionString, ctx);
  const inFlightCap = patLookupsInFlight(env);
  return {
    config,
    lookup: hash => lookupPatHash(hash, store, inFlightCap),
    windows: probeWindows,
    now: Date.now,
  };
}

/**
 * The mint Worker's fetch handler. Placement runs it next to the identity store's primary, which
 * applies to fetch handlers only, not to RPC methods or named entrypoints (design 5.2). It serves
 * the issuer metadata; the OAuth endpoints, the sign-in pages, the device grant and the tickets
 * once the identity store is bound (src/oauth/routes.ts); the `/internal/` routes of the web app's
 * outbox (src/subjects/routes.ts), which answer 503 until the identity store exists; the bot-token
 * mint (src/bot-token/route.ts), off unless `BOT_TOKEN_POLICIES` lists policies; and the
 * account API (src/account/routes.ts) and the PAT probe route
 * (src/pat/probe.ts) once their identity-store configs are bound. Signer keys are served by the
 * `SignerKeys` entrypoint (src/signer-keys.ts), PAT lookups for verifiers by the `PatLookup`
 * entrypoint (src/pat/entrypoint.ts) and Worker subject operations by the `SubjectRevocation`
 * entrypoint (src/subjects/entrypoint.ts), never by this handler.
 */
export async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  options: MintOptions | null = null
): Promise<Response> {
  const config = readConfig(env);
  const { pathname } = new URL(request.url);
  const mint = options ?? { ...DEPLOYED, ...deployedStsCallers(config, ctx) };
  if (pathname === MANAGER_JWKS_PATH) {
    if (request.method !== 'GET') {
      return jsonResponse({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
    }
    return await managerKeySet(env, config);
  }
  const secrets = requestSecrets(env, config, ctx);
  const oauth = oauthService(env, ctx, config, mint, secrets);
  if (pathname === UTS_AUTHORIZATION_SERVER_METADATA_PATH) {
    if (request.method !== 'GET') {
      return jsonResponse({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
    }
    const webClientReady =
      oauth.kind === 'ready' && (await oauth.deps.web.keys()).status === 'ready';
    const device = oauth.kind === 'ready' ? (await oauth.deps.secretDeps()).device.status : 'off';
    // Without a usable STS bundle the device grant's state is unknown: the answer leaves it out and
    // is not cached, so the next read lists it again once the bundle is back.
    return jsonResponse(
      authorizationServerMetadata(config, oauth, webClientReady, device === 'served'),
      200,
      { 'Cache-Control': device === 'unavailable' ? 'no-store' : 'public, max-age=300' }
    );
  }
  const account = accountDeps(env, ctx, config, secrets);
  const probe = probeDeps(env, ctx, config);
  if (pathname === UTS_PROTECTED_RESOURCE_METADATA_PATH && (account !== null || probe !== null)) {
    if (request.method !== 'GET') {
      return jsonResponse({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
    }
    return jsonResponse(
      protectedResourceMetadata(config, { account: account !== null, probe: probe !== null }),
      200,
      { 'Cache-Control': 'public, max-age=300' }
    );
  }
  if (oauth.kind === 'ready') {
    const response = await handleOAuthRequest(request, pathname, oauth.deps);
    if (response !== null) return response;
  } else if (isBrowserSessionPath(pathname)) {
    // The web BFF reads this as "not yet", never as "no such session".
    return webClientUnavailable();
  }
  const internal = await handleInternalRequest(request, pathname, {
    serviceTokens: mint.serviceTokens,
    subjects: subjectDeps(env, ctx, config),
  });
  if (internal !== null) return internal;
  if (pathname === UTS_BOT_TOKEN_PATH) {
    return await handleBotTokenRequest(request, botTokenDeps(env, ctx, config, mint));
  }
  if (account !== null) {
    const response = await handleAccountRequest(request, pathname, account);
    if (response !== null) return response;
  }
  if (probe !== null && pathname === UTS_PAT_PROBE_PATH) {
    return await handlePatProbe(request, probe);
  }
  return jsonResponse({ error: 'not_found' }, 404);
}
