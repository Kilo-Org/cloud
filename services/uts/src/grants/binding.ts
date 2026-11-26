import { type WaitUntil, withIdentityStore } from '../db/client';
import type { Env } from '../env';
import { type GrantsAccess, identityStoreGrants } from './store';

/**
 * The identity store as the mint Worker sees it. An environment binds `IDENTITY_STORE` (the primary
 * Hyperdrive config) once its identity store is provisioned; until then the OAuth endpoints are not
 * served and the issuer metadata leaves them out.
 */
export type IdentityStoreBinding =
  | { kind: 'unprovisioned' }
  | { kind: 'ready'; connectionString: string };

export function identityStoreBinding(env: Pick<Env, 'IDENTITY_STORE'>): IdentityStoreBinding {
  return env.IDENTITY_STORE === undefined
    ? { kind: 'unprovisioned' }
    : { kind: 'ready', connectionString: env.IDENTITY_STORE.connectionString };
}

/** Each call opens one identity-store connection for its work and closes it in the background. */
export function grantsAccess(connectionString: string, context: WaitUntil): GrantsAccess {
  return work =>
    withIdentityStore(connectionString, context, store => work(identityStoreGrants(store)));
}
