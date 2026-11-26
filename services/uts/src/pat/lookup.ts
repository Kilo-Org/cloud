import { PatHashSchema, type UtsPatLookupResult } from '@kilocode/uts-contracts';
import { type WaitUntil, IdentityStoreError, withIdentityStore } from '../db/client';
import { lookupPat } from '../db/lookups';
import type { Env } from '../env';
import { hashOfHex } from './format';

/**
 * The PAT lookup at UTS (design 5.2, 7): one `uts.lookup_pat` statement through the PAT
 * Hyperdrive config, which serves nothing else, so a lookup flood cannot starve sign-in. A lookup
 * finds only a live PAT of an active account; `not_found` covers unknown, revoked and expired PATs
 * and PATs of blocked accounts alike. Each mint isolate runs at most 100 lookups at once and
 * answers `rate_limited` above that, before it opens a connection; the PAT config's own connection
 * limit bounds the lookups that reach Postgres at once over all isolates.
 */

export const PAT_LOOKUPS_IN_FLIGHT = 100;
/** Seconds a verifier waits after a `rate_limited` answer. */
const RATE_LIMITED_RETRY_SECONDS = 1;
/** Seconds a verifier waits after the identity store failed. */
const UNAVAILABLE_RETRY_SECONDS = 2;
/** Seconds a verifier waits when this environment has no PAT config bound, or refuses it. */
export const UNSERVED_RETRY_SECONDS = 60;

export type PatRow = {
  patId: string;
  accountId: string;
  audience: string;
  scope: string;
  orgId: string | null;
  expiresAt: Date;
};

/** One lookup by the raw SHA-256; throws `IdentityStoreError` when the identity store fails. */
export type PatLookupStore = (hash: Uint8Array) => Promise<PatRow | null>;

/** In-flight lookups of one isolate, as plain data. */
export type LookupLimiter = { inFlight: number };

const ISOLATE_LIMITER: LookupLimiter = { inFlight: 0 };

/** The PAT config as the mint Worker sees it: bound once the environment provisions it. */
export type PatStoreBinding =
  | { kind: 'unprovisioned' }
  | { kind: 'ready'; connectionString: string };

export function patStoreBinding(env: Pick<Env, 'IDENTITY_STORE_PAT'>): PatStoreBinding {
  return env.IDENTITY_STORE_PAT === undefined
    ? { kind: 'unprovisioned' }
    : { kind: 'ready', connectionString: env.IDENTITY_STORE_PAT.connectionString };
}

/** Each lookup opens one connection through the PAT config and closes it in the background. */
export function identityStorePatLookup(
  connectionString: string,
  context: WaitUntil
): PatLookupStore {
  return hash =>
    withIdentityStore(connectionString, context, async store => {
      const row = await lookupPat(store, hash);
      return row === null
        ? null
        : {
            patId: row.pat_id,
            accountId: row.account_id,
            audience: row.audience,
            scope: row.scope,
            orgId: row.org_id,
            expiresAt: row.expires_at,
          };
    });
}

/** The answer for `hash`, the lowercase-hex SHA-256 of the whole PAT. */
export async function lookupPatHash(
  hash: string,
  store: PatLookupStore,
  limiter: LookupLimiter = ISOLATE_LIMITER
): Promise<UtsPatLookupResult> {
  if (!PatHashSchema.safeParse(hash).success) return { status: 'not_found' };
  if (limiter.inFlight >= PAT_LOOKUPS_IN_FLIGHT) {
    return { status: 'rate_limited', retryAfterSeconds: RATE_LIMITED_RETRY_SECONDS };
  }
  limiter.inFlight += 1;
  let row: PatRow | null;
  try {
    row = await store(hashOfHex(hash));
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'uts.pat_lookup.failed',
        failure: error instanceof IdentityStoreError ? error.failure : 'unexpected',
        sqlState: error instanceof IdentityStoreError ? error.sqlState : undefined,
        systemCode: error instanceof IdentityStoreError ? error.systemCode : undefined,
      })
    );
    return { status: 'unavailable', retryAfterSeconds: UNAVAILABLE_RETRY_SECONDS };
  } finally {
    limiter.inFlight -= 1;
  }
  if (row === null) return { status: 'not_found' };
  return {
    status: 'found',
    record: {
      patId: row.patId,
      subject: row.accountId,
      audience: row.audience,
      scope: row.scope,
      org: row.orgId,
      expiresAt: Math.floor(row.expiresAt.getTime() / 1000),
    },
  };
}
