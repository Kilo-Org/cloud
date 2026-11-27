import { PatHashSchema, type UtsPatLookupResult } from '@kilocode/uts-contracts';
import { type WaitUntil, IdentityStoreError, withIdentityStore } from '../db/client';
import { lookupPat } from '../db/lookups';
import type { Env } from '../env';
import { hashOfHex } from './format';

/**
 * The PAT lookup at UTS (design 5.2, 7): one `uts.lookup_pat` statement through the PAT
 * Hyperdrive config, which serves nothing else, so a lookup flood cannot starve sign-in. A lookup
 * finds only a live PAT of an active account; `not_found` covers unknown, revoked and expired PATs
 * and PATs of blocked accounts alike. Each mint isolate runs at most `inFlightCap` lookups at once
 * and answers `rate_limited` above that, before it opens a connection; the PAT config's own
 * connection limit bounds the lookups that reach Postgres at once over all isolates. The cap is
 * min(100, 3 × `PAT_LOOKUP_CONNECTIONS`) (`patLookupsInFlight` in src/env.ts, design 3), so one
 * isolate queues at most 3 lookups per PAT config connection.
 */

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

/**
 * A lookup that has not answered after this long answers `unavailable`, connecting included.
 * `pg`'s own `connectionTimeoutMillis` cannot end a hung connect on a Workers socket: on timeout
 * it destroys the socket, and `pg-cloudflare` ends a socket by first writing to it, which waits
 * for a connect that never completes. So the deadline races the whole lookup instead.
 */
export const PAT_LOOKUP_DEADLINE_MS = 5 * 1000;

/**
 * How long a lookup holds its in-flight slot at most: twice its deadline. Workers cancels the work
 * of a request whose client went away, and a cancelled lookup's promises never settle, so its
 * `finally` never runs; the slot then lapses here instead of staying taken for the life of the
 * isolate.
 */
export const PAT_LOOKUP_LEASE_MS = 2 * PAT_LOOKUP_DEADLINE_MS;

/**
 * In-flight lookups of one isolate, as plain data: each holds a lease, keyed by a number, that
 * names when it started. Leases past `PAT_LOOKUP_LEASE_MS` no longer count.
 */
export type LookupLimiter = { leases: Map<number, number>; nextLease: number };

export function lookupLimiter(): LookupLimiter {
  return { leases: new Map(), nextLease: 0 };
}

const ISOLATE_LIMITER = lookupLimiter();

const TIMED_OUT = Symbol('timed out');

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

/**
 * The answer for `hash`, the lowercase-hex SHA-256 of the whole PAT, with at most `inFlightCap`
 * lookups of this isolate in flight at `now`. The admission check and the lease are taken before
 * the first await.
 */
export async function lookupPatHash(
  hash: string,
  store: PatLookupStore,
  inFlightCap: number,
  limiter: LookupLimiter = ISOLATE_LIMITER,
  now: number = Date.now()
): Promise<UtsPatLookupResult> {
  if (!PatHashSchema.safeParse(hash).success) return { status: 'not_found' };
  for (const [lease, startedAt] of limiter.leases) {
    if (now - startedAt >= PAT_LOOKUP_LEASE_MS) limiter.leases.delete(lease);
  }
  if (limiter.leases.size >= inFlightCap) {
    return { status: 'rate_limited', retryAfterSeconds: RATE_LIMITED_RETRY_SECONDS };
  }
  const lease = limiter.nextLease;
  limiter.nextLease += 1;
  limiter.leases.set(lease, now);
  let row: PatRow | null;
  try {
    const deadline = scheduler.wait(PAT_LOOKUP_DEADLINE_MS).then((): typeof TIMED_OUT => TIMED_OUT);
    const answer = await Promise.race([store(hashOfHex(hash)), deadline]);
    if (answer === TIMED_OUT) {
      console.error(JSON.stringify({ event: 'uts.pat_lookup.timed_out' }));
      return { status: 'unavailable', retryAfterSeconds: UNAVAILABLE_RETRY_SECONDS };
    }
    row = answer;
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
    limiter.leases.delete(lease);
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
