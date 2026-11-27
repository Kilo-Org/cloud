import { z } from 'zod';
import { readBoundedText } from '../request-body';

/**
 * GitHub's OIDC key set, held per isolate as plain data (design 7 key-set rules): one copy, 5
 * minutes old at most; a token whose `kid` the copy lacks makes one refresh, at most once per 5
 * minutes, so a flood of tokens with made-up `kid`s costs GitHub one fetch per isolate per 5
 * minutes. A copy past its 5 minutes is refreshed before use and never served stale: a key that
 * GitHub removed stops verifying within 5 minutes. A failed fetch answers `unavailable` and is not
 * retried for 10 seconds. The fetch follows no redirect, gives up after 5 seconds and reads at
 * most 64 KB. The URL is pinned, so no discovery document is read.
 *
 * Only plain data crosses requests, never a promise, because workerd ties a promise to the request
 * that created it (design 7). Two requests that find the copy stale at once may both fetch; a
 * late answer never replaces a copy fetched later.
 */

export const GITHUB_ACTIONS_JWKS_URL =
  'https://token.actions.githubusercontent.com/.well-known/jwks';

const COPY_LIFETIME_MS = 5 * 60 * 1000;
const UNKNOWN_KID_REFRESH_MS = 5 * 60 * 1000;
const FAILURE_PAUSE_MS = 10 * 1000;
const FETCH_TIMEOUT_MS = 5 * 1000;
const MAX_BODY_BYTES = 64 * 1024;

/** One RSA signing key as GitHub publishes it; other members are ignored. */
const RsaKeySchema = z.object({
  kty: z.literal('RSA'),
  kid: z.string().min(1).max(256),
  n: z.string().regex(/^[A-Za-z0-9_-]+$/),
  e: z.string().regex(/^[A-Za-z0-9_-]+$/),
  alg: z.literal('RS256').optional(),
  use: z.literal('sig').optional(),
});
export type GithubKey = z.infer<typeof RsaKeySchema>;

const KeySetSchema = z.object({ keys: z.array(z.unknown()).max(32) });

/** Per isolate: the held copy, when it was fetched, and the last unknown-`kid` and failed fetch. */
export type GithubKeyState = {
  copy: { keys: ReadonlyMap<string, GithubKey>; fetchedAt: number } | null;
  unknownKidRefreshAt: number | null;
  failedAt: number | null;
};

export function newGithubKeyState(): GithubKeyState {
  return { copy: null, unknownKidRefreshAt: null, failedAt: null };
}

export type GithubKeyLookup =
  | { status: 'found'; key: GithubKey }
  | { status: 'unknown' }
  | { status: 'unavailable' };

/** Finds GitHub's public key for a `kid`; the deployed entry fetches the pinned key set. */
export type GithubKeys = (kid: string) => Promise<GithubKeyLookup>;

type Fetched = { status: 'ok'; keys: ReadonlyMap<string, GithubKey> } | { status: 'failed' };

async function fetchKeySet(fetcher: typeof fetch): Promise<Fetched> {
  let response: Response;
  try {
    response = await fetcher(GITHUB_ACTIONS_JWKS_URL, {
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });
  } catch {
    return { status: 'failed' };
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    return { status: 'failed' };
  }
  const text = await readBoundedText(response.body, MAX_BODY_BYTES);
  if (text === null) return { status: 'failed' };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { status: 'failed' };
  }
  const set = KeySetSchema.safeParse(json);
  if (!set.success) return { status: 'failed' };
  const keys = new Map<string, GithubKey>();
  for (const item of set.data.keys) {
    const key = RsaKeySchema.safeParse(item);
    if (key.success) keys.set(key.data.kid, key.data);
  }
  return keys.size === 0 ? { status: 'failed' } : { status: 'ok', keys };
}

/**
 * The key lookup over `state`, one per isolate in the deployed entry; tests pass their own state,
 * fetcher and clock.
 */
export function githubKeys(
  state: GithubKeyState,
  fetcher: typeof fetch,
  now: () => number
): GithubKeys {
  async function refresh(): Promise<'ok' | 'unavailable'> {
    if (state.failedAt !== null && now() - state.failedAt < FAILURE_PAUSE_MS) return 'unavailable';
    const startedAt = now();
    const fetched = await fetchKeySet(fetcher);
    if (fetched.status === 'failed') {
      state.failedAt = now();
      return 'unavailable';
    }
    state.failedAt = null;
    if (state.copy === null || state.copy.fetchedAt <= startedAt) {
      state.copy = { keys: fetched.keys, fetchedAt: startedAt };
    }
    return 'ok';
  }

  return async kid => {
    const copy = state.copy;
    if (copy === null || now() - copy.fetchedAt >= COPY_LIFETIME_MS) {
      if ((await refresh()) === 'unavailable') return { status: 'unavailable' };
    } else if (
      !copy.keys.has(kid) &&
      (state.unknownKidRefreshAt === null ||
        now() - state.unknownKidRefreshAt >= UNKNOWN_KID_REFRESH_MS)
    ) {
      state.unknownKidRefreshAt = now();
      if ((await refresh()) === 'unavailable') return { status: 'unavailable' };
    }
    const key = state.copy?.keys.get(kid);
    return key === undefined ? { status: 'unknown' } : { status: 'found', key };
  };
}
