import {
  UTS_AUTHORIZATION_SERVER_METADATA_PATH,
  UTS_PAT_PROBE_PATH,
  UTS_PROTECTED_RESOURCE_METADATA_PATH,
} from '@kilocode/uts-contracts';
import { shardAccessTokenKeys } from './account/bearer';
import { type AccountDeps, handleAccountRequest } from './account/routes';
import { identityStoreAccount } from './account/store';
import { withIdentityStore } from './db/client';
import { patLookupsInFlight, readConfig, type Env, type UtsConfig } from './env';
import { identityStoreBinding } from './grants/binding';
import { authorizationServerMetadata } from './metadata/authorization-server';
import { protectedResourceMetadata } from './metadata/protected-resource';
import type { AuthorizationHandoff } from './oauth/authorize';
import { handleOAuthRequest, oauthService } from './oauth/routes';
import type { AddressWindows } from './pat/address-limit';
import { identityStorePatLookup, lookupPatHash, patStoreBinding } from './pat/lookup';
import { type PatProbeDeps, handlePatProbe } from './pat/probe';
import { jsonResponse } from './responses';
import type { SignerAccess } from './token/mint';

/**
 * What only the development entry adds: the development sign-in hand-off and a failing signer for
 * the local end-to-end run (src/dev.ts). Null is the deployed behaviour.
 */
export type MintOptions = {
  authorizationHandoff: AuthorizationHandoff | null;
  signer: SignerAccess | null;
};

const DEPLOYED: MintOptions = { authorizationHandoff: null, signer: null };

/** The probe route's per-address lookup windows, per isolate (src/pat/address-limit.ts). */
const probeWindows: AddressWindows = new Map();

/** The account API is served once the identity store's primary config is bound. */
function accountDeps(env: Env, ctx: ExecutionContext, config: UtsConfig): AccountDeps | null {
  const binding = identityStoreBinding(env);
  if (binding.kind === 'unprovisioned') return null;
  return {
    config,
    account: work =>
      withIdentityStore(binding.connectionString, ctx, store => work(identityStoreAccount(store))),
    keys: shardAccessTokenKeys(env, config),
    notices: null,
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
 * the issuer metadata, the OAuth endpoints once the identity store is bound
 * (src/oauth/routes.ts), the account API (src/account/routes.ts) and the PAT probe route
 * (src/pat/probe.ts) once their identity-store configs are bound. Signer keys are served by the
 * `SignerKeys` entrypoint (src/signer-keys.ts), and PAT lookups for verifiers by the `PatLookup`
 * entrypoint (src/pat/entrypoint.ts), never by this handler.
 */
export async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  options: MintOptions = DEPLOYED
): Promise<Response> {
  const config = readConfig(env);
  const { pathname } = new URL(request.url);
  const oauth = oauthService(env, ctx, config, options.authorizationHandoff, options.signer);
  if (pathname === UTS_AUTHORIZATION_SERVER_METADATA_PATH) {
    if (request.method !== 'GET') {
      return jsonResponse({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
    }
    return jsonResponse(authorizationServerMetadata(config, oauth), 200, {
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
