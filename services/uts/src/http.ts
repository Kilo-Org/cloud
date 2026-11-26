import {
  UTS_AUTHORIZATION_SERVER_METADATA_PATH,
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
import { credentialNotices } from './notices/credential';
import { noticesAccess } from './notices/store';
import { noticeEmail, platformFetch } from './signin/email/delivery';
import type { SignInMailer } from './signin/email/mailer';
import { signInConfigFor } from './signin/providers/config';
import { subjectDeps } from './subjects/deps';
import { handleInternalRequest } from './subjects/routes';
import { type ServiceTokenVerifier, noServiceTokenVerifier } from './subjects/service-tokens';
import type { MetadataFetcher } from './third-party/metadata';
import type { SignerAccess } from './token/mint';
import type { StsCallerVerifier } from './exchange/endpoint';

/**
 * What only the development entry adds: a choice of the synthetic sign-in hand-off, a failing
 * signer for the local end-to-end run, the development fixture scopes on top of the scope
 * registry, a recording mail port for the email sign-in, a metadata fetch that serves the local
 * end-to-end run's client documents, a stand-in STS token verifier of the broker exchange and a
 * stand-in STS token check for the `/internal/` routes (src/dev.ts). The deployed options are the
 * sign-in pages, the grant's signer, the registry alone, no recording mail port (mail goes through
 * Mailgun where the mail settings are on, src/signin/email/delivery.ts), the platform `fetch`, no
 * STS token verifier (the broker exchange waits for `@kilocode/verify`) and no STS token check, so
 * every `/internal/` route answers 503 until the mint Worker carries `@kilocode/verify`.
 */
export type MintOptions = {
  authorizationHandoff: HandoffChoice | null;
  signer: SignerAccess | null;
  scopes: ScopeRegistry;
  recordingMailer: SignInMailer | null;
  serviceTokens: ServiceTokenVerifier;
  metadataFetcher: MetadataFetcher;
  stsCallers: StsCallerVerifier | null;
};

const DEPLOYED: MintOptions = {
  authorizationHandoff: null,
  signer: null,
  scopes: utsScopeEntry,
  recordingMailer: null,
  serviceTokens: noServiceTokenVerifier,
  metadataFetcher: (url, init) => fetch(url, init),
  stsCallers: null,
};

/** The probe route's per-address lookup windows, per isolate (src/pat/address-limit.ts). */
const probeWindows: AddressWindows = new Map();

/**
 * The account API is served once the identity store's primary config is bound. A created
 * credential's notice goes out at once by email where the mail settings are on (push has no
 * deployed provider yet); elsewhere the minute cron settles it.
 */
function accountDeps(env: Env, ctx: ExecutionContext, config: UtsConfig): AccountDeps | null {
  const binding = identityStoreBinding(env);
  if (binding.kind === 'unprovisioned') return null;
  const email = noticeEmail(signInConfigFor(env, config).mail, platformFetch);
  return {
    config,
    account: work =>
      withIdentityStore(binding.connectionString, ctx, store => work(identityStoreAccount(store))),
    keys: shardAccessTokenKeys(env, config),
    notices:
      email === null
        ? null
        : credentialNotices({
            notices: noticesAccess(binding.connectionString, ctx),
            transports: { push: null, email },
            now: () => new Date(),
          }),
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
 * outbox (src/subjects/routes.ts), which answer 503 until both an STS token check and the identity
 * store exist; and the account API (src/account/routes.ts) and the PAT probe route
 * (src/pat/probe.ts) once their identity-store configs are bound. Signer keys are served by the
 * `SignerKeys` entrypoint (src/signer-keys.ts), PAT lookups for verifiers by the `PatLookup`
 * entrypoint (src/pat/entrypoint.ts) and Worker subject operations by the `SubjectRevocation`
 * entrypoint (src/subjects/entrypoint.ts), never by this handler.
 */
export async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  options: MintOptions = DEPLOYED
): Promise<Response> {
  const config = readConfig(env);
  const { pathname } = new URL(request.url);
  const oauth = oauthService(env, ctx, config, options);
  if (pathname === UTS_AUTHORIZATION_SERVER_METADATA_PATH) {
    if (request.method !== 'GET') {
      return jsonResponse({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
    }
    const webClientReady =
      oauth.kind === 'ready' && (await oauth.deps.web.keys()).status === 'ready';
    return jsonResponse(authorizationServerMetadata(config, oauth, webClientReady), 200, {
      'Cache-Control': 'public, max-age=300',
    });
  }
  const account = accountDeps(env, ctx, config);
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
    serviceTokens: options.serviceTokens,
    subjects: subjectDeps(env, ctx, config),
  });
  if (internal !== null) return internal;
  if (account !== null) {
    const response = await handleAccountRequest(request, pathname, account);
    if (response !== null) return response;
  }
  if (probe !== null && pathname === UTS_PAT_PROBE_PATH) {
    return await handlePatProbe(request, probe);
  }
  return jsonResponse({ error: 'not_found' }, 404);
}
