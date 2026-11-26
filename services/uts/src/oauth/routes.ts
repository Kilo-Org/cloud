import {
  UTS_AUTHORIZE_PATH,
  UTS_INTROSPECT_PATH,
  UTS_REVOKE_PATH,
  UTS_TOKEN_PATH,
  utsScopeEntry,
} from '@kilocode/uts-contracts';
import type { Env, UtsConfig } from '../env';
import { grantsAccess, identityStoreBinding } from '../grants/binding';
import type { GrantsAccess } from '../grants/store';
import type { ScopeRegistry } from '../scopes/policy';
import { type SignerAccess, signerAccess } from '../token/mint';
import { type AuthorizationHandoff, handleAuthorize } from './authorize';
import { handleIntrospect } from './introspect';
import { handleRevoke } from './revoke';
import { type DeviceCodeGrant, handleToken } from './token-endpoint';

/** What an OAuth request needs; the runtime tests pass their own `grants` and `scopes`. */
export type OAuthDeps = {
  config: UtsConfig;
  grants: GrantsAccess;
  sign: SignerAccess;
  /** The scope registry the endpoints enforce: `UTS_SCOPE_REGISTRY` in every deployed Worker. */
  scopes: ScopeRegistry;
  /** Null until the sign-in slice provides one: the authorization endpoint is not served. */
  handoff: AuthorizationHandoff | null;
  /** Null until the device sign-in slice provides one: the device grant is not offered. */
  deviceCodeGrant: DeviceCodeGrant | null;
};

/** The OAuth endpoints are served only where the identity store is bound. */
export type OAuthService = { kind: 'unprovisioned' } | { kind: 'ready'; deps: OAuthDeps };

/**
 * `sign` null uses the grant's signer object; only the development entry passes another one, to
 * show a signing failure in the local end-to-end run (src/dev.ts).
 */
export function oauthService(
  env: Env,
  ctx: ExecutionContext,
  config: UtsConfig,
  handoff: AuthorizationHandoff | null,
  sign: SignerAccess | null
): OAuthService {
  const binding = identityStoreBinding(env);
  if (binding.kind === 'unprovisioned') return binding;
  return {
    kind: 'ready',
    deps: {
      config,
      grants: grantsAccess(binding.connectionString, ctx),
      sign: sign ?? signerAccess(env, config),
      scopes: utsScopeEntry,
      handoff,
      deviceCodeGrant: null,
    },
  };
}

/** The response for an OAuth endpoint, or null when `pathname` names none that is served. */
export async function handleOAuthRequest(
  request: Request,
  pathname: string,
  deps: OAuthDeps
): Promise<Response | null> {
  switch (pathname) {
    case UTS_AUTHORIZE_PATH:
      return deps.handoff === null
        ? null
        : await handleAuthorize(request, { ...deps, handoff: deps.handoff });
    case UTS_TOKEN_PATH:
      return await handleToken(request, deps);
    case UTS_REVOKE_PATH:
      return await handleRevoke(request, deps);
    case UTS_INTROSPECT_PATH:
      return await handleIntrospect(request, deps);
    default:
      return null;
  }
}
