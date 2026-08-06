import * as SecureStore from 'expo-secure-store';
import { type Query, type QueryClient } from '@tanstack/react-query';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import {
  type AsyncStorage,
  type Persister,
  persistQueryClientRestore,
} from '@tanstack/react-query-persist-client';

import { buildAgentSessionListInput } from '@/lib/agent-session-input';
import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { ACTIVE_USER_ID_KEY } from '@/lib/storage-keys';
import { utf8ByteLength } from '@/lib/utf8-utils';

/**
 * Encrypted read cache over the SQLCipher KV store (DEC-01).
 *
 * One serialized blob per user per schema version, stored under scope
 * `cache:<userId>:<SCHEMA_VERSION>`. Only allowlisted, successful tRPC
 * queries are dehydrated into the blob; every other query shape (including
 * flat application keys) is denied without throwing. A save is fenced on the
 * auth epoch and the cached authoritative user id captured at persister
 * creation, bounded to 2 MB of serialized JSON (an oversized blob is dropped
 * and the previous blob for the scope is removed), and expires after 24 h.
 *
 * The module is pure (no native imports) so its logic runs in node tests; the
 * SQLCipher KV adapter is bound once by the root layout via
 * {@link bindReadCacheKv} and injected as the persister's `kv`.
 */

/** Bump on any breaking change to a persisted query shape. */
export const SCHEMA_VERSION = 1;

export const READ_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const READ_CACHE_MAX_BYTES = 2 * 1024 * 1024;

const READ_CACHE_KEY = 'read-cache';
const CACHE_SCOPE_PREFIX = 'cache:';

/** One scope holds one user's read-cache blob for the current schema. */
export function readCacheScope(userId: string): string {
  return `${CACHE_SCOPE_PREFIX}${userId}:${SCHEMA_VERSION}`;
}

/** The encrypted-kv surface the read cache uses; injected for node tests. */
export type ReadCacheKv = {
  getItem: (scope: string, k: string) => Promise<string | null>;
  setItem: (scope: string, k: string, v: string) => Promise<void>;
  removeItem: (scope: string, k: string) => Promise<void>;
  clearScope: (scope: string) => Promise<void>;
  clearScopePrefix: (prefix: string) => Promise<void>;
};

// Late-bound production KV adapter. The root layout binds it at module scope
// so auth-context can clear cache scopes on sign-out and the cold-start
// restore can hydrate, without auth-context importing the native chain.
let boundKv: ReadCacheKv | null = null;

/** Binds the production SQLCipher KV adapter, from the root layout. */
export function bindReadCacheKv(kv: ReadCacheKv): void {
  boundKv = kv;
}

/** Returns the bound KV adapter, or null before the root layout binds it. */
export function getBoundReadCacheKv(): ReadCacheKv | null {
  return boundKv;
}

// Test-only: resets the late-bound adapter and the cold-start restore state so
// a test can drive each lifecycle from a clean module (the same pattern as
// `resetEncryptedKvOpenForTests` in encrypted-kv.ts).
export function resetReadCacheForTests(): void {
  boundKv = null;
  coldStartGeneration = 0;
  coldStartRestoredScope = null;
}

// ── Allowlist ──────────────────────────────────────────────────────────────

// The exact tRPC query key for `user.getMe` (path segment array plus the
// `{ type: 'query' }` meta), as built by the `@trpc/tanstack-react-query`
// proxy that `useCurrentUserId` consumes. The publication fence and sign-out
// read the authoritative user id from this key without a React context.
const GET_ME_QUERY_KEY: readonly unknown[] = [['user', 'getMe'], { type: 'query' }];

type QueryCacheReader = { getQueryData?: QueryClient['getQueryData'] };

/** Authoritative user id from the cached `user.getMe` result, or null. */
export function readCachedUserId(queryClient: QueryCacheReader): string | null {
  const data = queryClient.getQueryData?.<{ id?: unknown } | undefined>(GET_ME_QUERY_KEY);
  return typeof data?.id === 'string' && data.id.length > 0 ? data.id : null;
}

/**
 * Paths that must never persist even if they were allowlisted: transcript
 * pages and anything carrying patches, diffs, tokens, or secrets. Kept as an
 * explicit list (in addition to the exact-path allowlist) so the denial is
 * documented and unit-asserted.
 */
function isHardDeniedPath(path: string): boolean {
  return (
    path === 'cliSessionsV2.getSessionMessagesPage' ||
    path.includes('patch') ||
    path.includes('diff') ||
    path.includes('token') ||
    path.includes('secret') ||
    path.startsWith('kiloclaw.')
  );
}

/** The `input` field of a tRPC query key's meta segment, or undefined. */
function metaInput(meta: unknown): unknown {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    return undefined;
  }
  return (meta as { input?: unknown }).input;
}

type AllowedProcedure = {
  path: string;
  isAllowedInput: (meta: unknown) => boolean;
};

/**
 * The exact default first-page input the app builds for the personal session
 * list (`buildAgentSessionListInput({ organizationId: null })`). The app's
 * list callers always pass the organization context, and personal context is
 * `null`, so the persisted snapshot must match this shape field for field.
 */
const DEFAULT_SESSION_LIST_INPUT = buildAgentSessionListInput({ organizationId: null });
const DEFAULT_SESSION_LIST_KEY_COUNT = Object.keys(DEFAULT_SESSION_LIST_INPUT).length;

// Initial allowlist. Verified against the mobile tRPC router
// (`packages/trpc/src/mobile.ts`) before coding.
const ALLOWED_PROCEDURES: readonly AllowedProcedure[] = [
  {
    path: 'user.getMe',
    isAllowedInput: meta => metaInput(meta) === undefined,
  },
  {
    path: 'organizations.list',
    isAllowedInput: meta => metaInput(meta) === undefined,
  },
  {
    path: 'cliSessionsV2.recentRepositories',
    // Only the default (personal-context) variant persists so at most one
    // snapshot of this procedure is ever written.
    isAllowedInput: meta => {
      const input = metaInput(meta);
      if (input == null || typeof input !== 'object') {
        return true;
      }
      return (input as { organizationId?: unknown }).organizationId == null;
    },
  },
  {
    path: 'cliSessionsV2.list',
    // Only the exact default first-page input persists: `null` and an omitted
    // organization are both personal context, and every other field must match
    // the default builder output. An organization, repository (`gitUrl`),
    // platform (`createdOnPlatform`), sort (`orderBy`), extra-field, or cursor
    // variant is denied, so the read cache holds at most one session-list
    // snapshot. The tRPC adapter strips `cursor`/`direction` from infinite
    // keys, so a later page shares this key — the loaded page count is
    // enforced separately in {@link shouldPersistReadCacheQuery}.
    isAllowedInput: meta => {
      const input = metaInput(meta);
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return false;
      }
      const candidate = input as Record<string, unknown>;
      if (Object.keys(candidate).length !== DEFAULT_SESSION_LIST_KEY_COUNT) {
        return false;
      }
      return (
        candidate.limit === DEFAULT_SESSION_LIST_INPUT.limit &&
        candidate.orderBy === DEFAULT_SESSION_LIST_INPUT.orderBy &&
        candidate.includeChildren === DEFAULT_SESSION_LIST_INPUT.includeChildren &&
        candidate.createdOnPlatform === DEFAULT_SESSION_LIST_INPUT.createdOnPlatform &&
        candidate.gitUrl === DEFAULT_SESSION_LIST_INPUT.gitUrl &&
        (candidate.organizationId === null || candidate.organizationId === undefined)
      );
    },
  },
];

/** True when a query key is an allowlisted, non-hard-denied tRPC shape. */
export function isReadCacheAllowedKey(queryKey: unknown): boolean {
  if (!Array.isArray(queryKey) || queryKey.length < 2) {
    return false;
  }
  const segments = queryKey[0];
  if (!Array.isArray(segments) || segments.length === 0) {
    // Flat application keys (e.g. ['org-default-model', <id>]) and empty
    // paths are denied, never thrown on.
    return false;
  }
  const path = segments.join('.');
  if (isHardDeniedPath(path)) {
    return false;
  }
  const allowed = ALLOWED_PROCEDURES.find(procedure => procedure.path === path);
  return allowed?.isAllowedInput(queryKey[1]) ?? false;
}

/** True when the meta segment marks an infinite query. */
function isInfiniteQueryMeta(meta: unknown): boolean {
  if (typeof meta !== 'object' || meta === null) {
    return false;
  }
  return (meta as { type?: unknown }).type === 'infinite';
}

/** True when an allowlisted infinite query holds only its first page. */
function isFirstPageOnly(query: Query): boolean {
  const data = query.state.data as { pageParams?: unknown[] } | undefined;
  const loadedPages = data?.pageParams?.length ?? 1;
  return loadedPages <= 1;
}

/**
 * Persist only successful queries on allowlisted shapes. An allowlisted
 * infinite query persists only while it holds the first page: the tRPC
 * adapter strips `cursor`/`direction` from infinite-query keys, so every
 * loaded page shares the same key and only the loaded data can prove the
 * snapshot is the first page.
 */
export function shouldPersistReadCacheQuery(query: Query): boolean {
  if (query.state.status !== 'success' || !isReadCacheAllowedKey(query.queryKey)) {
    return false;
  }
  const meta = Array.isArray(query.queryKey) ? query.queryKey[1] : undefined;
  return isInfiniteQueryMeta(meta) ? isFirstPageOnly(query) : true;
}

// ── Persister ──────────────────────────────────────────────────────────────

type ReadCachePersisterOptions = {
  kv: ReadCacheKv;
  queryClient: QueryClient;
  userId: string;
  epoch: number;
};

/**
 * Creates a `Persister` bound to one user's scope. The epoch and the cached
 * authoritative user id are captured at creation; a mismatch at write time
 * skips the write, so a throttled save from a torn-down persister can never
 * land in the previous account's scope.
 */
export function createReadCachePersister(options: ReadCachePersisterOptions): Persister {
  const { kv, queryClient, userId, epoch } = options;
  const scope = readCacheScope(userId);

  // Publication fence: every sign-in and sign-out bumps the epoch, and the
  // authoritative user id comes from the live getMe query, so an epoch or
  // user mismatch at write time means the session changed after creation.
  const isPublicationAllowed = (): boolean =>
    isCurrentAuthEpoch(epoch) && readCachedUserId(queryClient) === userId;

  const storage: AsyncStorage = {
    getItem: async k => {
      const value = await kv.getItem(scope, k);
      return value;
    },
    setItem: async (k, v) => {
      // The fence also guards the storage write: the async-storage persister
      // throttles saves, so the actual write can happen after teardown.
      if (!isPublicationAllowed()) {
        return;
      }
      await kv.setItem(scope, k, v);
    },
    removeItem: async k => {
      await kv.removeItem(scope, k);
    },
  };
  const base = createAsyncStoragePersister({ storage, key: READ_CACHE_KEY });

  return {
    persistClient: async client => {
      if (!isPublicationAllowed()) {
        return;
      }
      const serialized = JSON.stringify(client);
      if (utf8ByteLength(serialized) > READ_CACHE_MAX_BYTES) {
        // Oversized blobs are never written partially: the previous blob for
        // this scope is removed so a stale snapshot cannot survive the write
        // that replaced it.
        await base.removeClient();
        return;
      }
      await base.persistClient(client);
    },
    restoreClient: base.restoreClient,
    removeClient: base.removeClient,
  };
}

// ── Cold-start restore ─────────────────────────────────────────────────────

let coldStartGeneration = 0;
let coldStartRestoredScope: string | null = null;

/**
 * Best-effort cold-start restore for the identity hint stored in
 * `ACTIVE_USER_ID_KEY`. Never blocks startup. A generation flag abandons the
 * restore once the authenticated mount takes over: a late restore no-ops —
 * including one whose KV read was still in flight at takeover, which never
 * hydrates — and never claims a scope, and the scope of a completed restore
 * is reported to the mount via {@link takeOverColdStartRestore}.
 */
export async function restorePersistedCacheOnColdStart(queryClient: QueryClient): Promise<void> {
  // The generation bump is synchronous so the authenticated mount can abandon
  // this restore immediately after scheduling it.
  coldStartGeneration += 1;
  const generation = coldStartGeneration;
  // Capture the epoch before the first SecureStore read: a sign-in or sign-out
  // that lands while the hint read or the KV read is in flight fences the
  // whole restore, so it can never hydrate (or claim a scope) after the auth
  // epoch moved — including after a logout that cleared the query client.
  const epoch = currentAuthEpoch();
  try {
    const kv = getBoundReadCacheKv();
    if (!kv) {
      return;
    }
    const hintUserId = await SecureStore.getItemAsync(ACTIVE_USER_ID_KEY);
    if (generation !== coldStartGeneration || !hintUserId || !isCurrentAuthEpoch(epoch)) {
      return;
    }
    const persister = createReadCachePersister({
      kv,
      queryClient,
      userId: hintUserId,
      epoch,
    });
    if (generation !== coldStartGeneration || !isCurrentAuthEpoch(epoch)) {
      return;
    }
    // The mount bumps the generation when it takes over, and
    // `persistQueryClientRestore` hydrates internally without a hook, so the
    // fence lives in a wrapped `restoreClient`: it reports no blob (and the
    // library therefore does nothing) whenever the generation moved or the
    // auth epoch changed while the KV read was in flight. A late restore can
    // never hydrate after the authoritative identity has taken over or a
    // sign-in/sign-out has moved the epoch.
    const fencedPersister: Persister = {
      ...persister,
      restoreClient: async () => {
        const restored = await persister.restoreClient();
        return generation === coldStartGeneration && isCurrentAuthEpoch(epoch)
          ? restored
          : undefined;
      },
    };
    await persistQueryClientRestore({
      queryClient,
      persister: fencedPersister,
      maxAge: READ_CACHE_MAX_AGE_MS,
      buster: String(SCHEMA_VERSION),
    });
    if (generation !== coldStartGeneration || !isCurrentAuthEpoch(epoch)) {
      // The mount took over, or the auth epoch changed, while the restore was
      // in flight: the late restore is abandoned and must not claim a scope.
      return;
    }
    coldStartRestoredScope = readCacheScope(hintUserId);
  } catch {
    // Best effort: a failed or interrupted restore never blocks startup.
  }
}

/**
 * Marks the authenticated mount as the cache owner: any still-pending cold-
 * start restore is abandoned, and the scope a completed restore hydrated is
 * returned (and cleared from the module) for identity comparison.
 */
export function takeOverColdStartRestore(): string | null {
  coldStartGeneration += 1;
  const scope = coldStartRestoredScope;
  coldStartRestoredScope = null;
  return scope;
}

/**
 * The restored scope to clear when it belongs to another account than the
 * authoritative `userId`; null when there is nothing to clear. The hint only
 * survives an interrupted teardown, and authoritative identity wins.
 */
export function mismatchedRestoredScope(
  restoredScope: string | null,
  userId: string
): string | null {
  if (restoredScope === null || restoredScope === readCacheScope(userId)) {
    return null;
  }
  return restoredScope;
}

// ── Sign-out cleanup ───────────────────────────────────────────────────────

/**
 * Removes the signed-out user's read-cache scope, or every `cache:` scope
 * when the identity is unknown — privacy wins over a warm start. Best effort:
 * a storage failure is swallowed so a failed cleanup can never abort sign-out;
 * the stale blob only costs a future warm start.
 */
export async function clearCacheScopeForSignOut(knownUserId: string | null): Promise<void> {
  const kv = getBoundReadCacheKv();
  if (!kv) {
    return;
  }
  try {
    await (knownUserId
      ? kv.clearScope(readCacheScope(knownUserId))
      : kv.clearScopePrefix(CACHE_SCOPE_PREFIX));
  } catch {
    // Best effort: query and auth state reset still run after this returns.
  }
}
