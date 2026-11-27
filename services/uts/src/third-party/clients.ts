import { classifyFailure } from '../oauth/errors';
import {
  type MetadataFetchOutcome,
  type MetadataFetcher,
  clientIdUrlProblem,
  fetchClientMetadata,
} from './metadata';
import type { CachedClient, ThirdPartyAccess, ThirdPartyClientRecord } from './store';

/**
 * The third-party client a request names (design 5.9). The identity store caches each Client ID
 * Metadata Document for its HTTP cache time; a missing or stale copy is fetched (a stale copy with
 * its `ETag`) before the client is served, and a blocked client is never fetched again or served.
 *
 * Each isolate fetches one document at a time per client id, and after a failed fetch it does not
 * fetch that id again for 60 seconds, so a client id that keeps failing costs its host at most one
 * fetch a minute per isolate, whatever the request rate. A fetch happens before anyone signs in and
 * can store a row, so each fetch also counts against the requesting network's anonymous-write
 * allowance (`fetchRetryAfter`, src/signin/limits.ts); a cached client costs no allowance.
 */

export type ClientResolution =
  | { kind: 'client'; client: ThirdPartyClientRecord }
  /** Not a client UTS serves: a bad URL, a document that is missing or refused, or blocked. */
  | { kind: 'refused'; reason: string }
  /** The store or the document host failed; a retry can succeed. */
  | { kind: 'unavailable' }
  /** The requesting network used its fetch allowance; nothing was fetched or stored. */
  | { kind: 'rate_limited'; retryAfterSeconds: number };

/** Resolves `clientId` for a request from `address` (`CF-Connecting-IP`, null when absent). */
export type ThirdPartyClients = (
  clientId: string,
  address: string | null
) => Promise<ClientResolution>;

/** After a failed fetch, the client id waits this long before the next fetch in the isolate. */
export const FAILED_FETCH_PAUSE_MS = 60_000;
/** The failure memory holds at most this many ids; past it, the oldest is dropped first. */
const MAX_REMEMBERED_FAILURES = 1_000;

export type ThirdPartyClientsDeps = {
  store: ThirdPartyAccess;
  fetcher: MetadataFetcher;
  now: () => number;
  /** Per isolate: the time until which a client id is not fetched, by id. */
  failures: Map<string, { until: number; outcome: ClientResolution }>;
  /** Per isolate: the fetch in flight, by id. */
  inFlight: Map<string, Promise<ClientResolution>>;
  /** Null when `address` may start one more fetch now (and counts it), else the seconds to wait. */
  fetchRetryAfter: (address: string | null) => number | null;
};

function remember(
  deps: ThirdPartyClientsDeps,
  clientId: string,
  outcome: ClientResolution
): ClientResolution {
  deps.failures.delete(clientId);
  if (deps.failures.size >= MAX_REMEMBERED_FAILURES) {
    const oldest = deps.failures.keys().next();
    if (!oldest.done) deps.failures.delete(oldest.value);
  }
  deps.failures.set(clientId, { until: deps.now() + FAILED_FETCH_PAUSE_MS, outcome });
  return outcome;
}

function served(cached: CachedClient): ClientResolution {
  return cached.status === 'blocked'
    ? { kind: 'refused', reason: 'blocked' }
    : { kind: 'client', client: cached.record };
}

async function refresh(
  deps: ThirdPartyClientsDeps,
  clientId: string,
  cached: CachedClient | null
): Promise<ClientResolution> {
  const etag = cached?.status === 'active' ? cached.etag : null;
  const fetched: MetadataFetchOutcome = await fetchClientMetadata(clientId, etag, deps.fetcher);
  switch (fetched.kind) {
    case 'not_modified': {
      if (cached?.status !== 'active') {
        return remember(deps, clientId, { kind: 'refused', reason: 'unexpected 304' });
      }
      await deps.store(store => store.extendClient(clientId, fetched.cacheSeconds));
      return served(cached);
    }
    case 'document': {
      const saved = await deps.store(store =>
        store.saveClient({
          clientId,
          metadata: fetched.metadata,
          etag: fetched.etag,
          cacheSeconds: fetched.cacheSeconds,
        })
      );
      deps.failures.delete(clientId);
      return served(saved);
    }
    case 'refused':
      console.warn(
        JSON.stringify({ event: 'uts.client_metadata.refused', reason: fetched.reason })
      );
      return remember(deps, clientId, { kind: 'refused', reason: fetched.reason });
    case 'unavailable':
      console.warn(
        JSON.stringify({ event: 'uts.client_metadata.unavailable', reason: fetched.reason })
      );
      return remember(deps, clientId, { kind: 'unavailable' });
  }
}

export function thirdPartyClients(deps: ThirdPartyClientsDeps): ThirdPartyClients {
  return async (clientId, address) => {
    const problem = clientIdUrlProblem(clientId);
    if (problem !== null) return { kind: 'refused', reason: `client id ${problem}` };
    try {
      const cached = await deps.store(store => store.readClient(clientId));
      if (cached !== null && (cached.status === 'blocked' || cached.fresh)) return served(cached);
      const failed = deps.failures.get(clientId);
      if (failed !== undefined && failed.until > deps.now()) return failed.outcome;
      const running = deps.inFlight.get(clientId);
      if (running !== undefined) return await running;
      const retryAfter = deps.fetchRetryAfter(address);
      if (retryAfter !== null) return { kind: 'rate_limited', retryAfterSeconds: retryAfter };
      const started = refresh(deps, clientId, cached);
      deps.inFlight.set(clientId, started);
      try {
        return await started;
      } finally {
        deps.inFlight.delete(clientId);
      }
    } catch (error) {
      classifyFailure(error, 'client_metadata');
      return { kind: 'unavailable' };
    }
  };
}
