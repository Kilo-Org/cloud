import * as SecureStore from 'expo-secure-store';
import { hashKey, type Query, type QueryClient } from '@tanstack/react-query';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import {
  type AsyncStorage,
  type Persister,
  persistQueryClientRestore,
} from '@tanstack/react-query-persist-client';
import { z } from 'zod';

import { buildAgentSessionListInput } from '@/lib/agent-session-input';
import {
  type AuthenticatedOwner,
  getAuthenticatedOwner,
  isAuthenticatedOwner,
} from '@/lib/context-scope';
import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { isSignOutActive, setSignOutActive } from '@/lib/auth/sign-out-state';
import * as encryptedKv from '@/lib/persist/encrypted-kv';
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

// Test-only: resets the cold-start restore state and the shared sign-out flag
// so a test can drive each lifecycle from a clean module (the same pattern as
// `resetEncryptedKvOpenForTests` in encrypted-kv.ts).
export function resetReadCacheForTests(): void {
  coldStartGeneration = 0;
  coldStartRestoredScope = null;
  setSignOutActive(false);
}

// ── Allowlist ──────────────────────────────────────────────────────────────

// The exact tRPC query key for `user.getMe` (path segment array plus the
// `{ type: 'query' }` meta), as built by the `@trpc/tanstack-react-query`
// proxy that `useCurrentUserId` consumes. The publication fence and sign-out
// read the authoritative user id from this key without a React context.
const GET_ME_QUERY_KEY: readonly unknown[] = [['user', 'getMe'], { type: 'query' }];

type QueryCacheReader = { getQueryData?: QueryClient['getQueryData'] };

const cachedUserSchema = z.object({ id: z.string().min(1) });

/** Cached getMe identifies a user only after this generation's network response proves the same owner. */
export function readCachedUserId(queryClient: QueryCacheReader): string | null {
  const data = queryClient.getQueryData?.(GET_ME_QUERY_KEY);
  const parsed = cachedUserSchema.safeParse(data);
  const owner = getAuthenticatedOwner();
  return parsed.success && isAuthenticatedOwner(owner) && parsed.data.id === owner.userId
    ? owner.userId
    : null;
}

const queryKeyMetaSchema = z.object({ input: z.unknown().optional() });
const plainObjectSchema = z.record(z.string(), z.unknown());

/** The `input` field of a tRPC query key's meta segment, when it is a plain object. */
function metaInput(meta: unknown): Record<string, unknown> | undefined {
  const parsedMeta = queryKeyMetaSchema.safeParse(meta);
  if (!parsedMeta.success) {
    return undefined;
  }
  const parsedInput = plainObjectSchema.safeParse(parsedMeta.data.input);
  return parsedInput.success ? parsedInput.data : undefined;
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
// JSON omits undefined input fields. Match the canonical stock key when restoring legacy blobs;
// do not relax the live allowlist or change the query-key positions used by permission eviction.
const SERIALIZED_SESSION_LIST_KEYS = new Set(
  ['query', 'infinite'].map(type =>
    hashKey([['cliSessionsV2', 'list'], { type, input: DEFAULT_SESSION_LIST_INPUT }])
  )
);

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
      if (input === undefined) {
        return true;
      }
      return input.organizationId == null;
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
      if (input === undefined) {
        return false;
      }
      if (Object.keys(input).length !== DEFAULT_SESSION_LIST_KEY_COUNT) {
        return false;
      }
      return (
        input.limit === DEFAULT_SESSION_LIST_INPUT.limit &&
        input.orderBy === DEFAULT_SESSION_LIST_INPUT.orderBy &&
        input.includeChildren === DEFAULT_SESSION_LIST_INPUT.includeChildren &&
        input.createdOnPlatform === DEFAULT_SESSION_LIST_INPUT.createdOnPlatform &&
        input.gitUrl === DEFAULT_SESSION_LIST_INPUT.gitUrl &&
        (input.organizationId === null || input.organizationId === undefined)
      );
    },
  },
];

/**
 * True when a query key is an allowlisted tRPC shape. The exact-path allowlist
 * is the only filter: every other path — transcript pages, patches, diffs,
 * tokens, secrets, kiloclaw — is denied because it is not on the list.
 */
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
  const allowed = ALLOWED_PROCEDURES.find(procedure => procedure.path === path);
  return allowed?.isAllowedInput(queryKey[1]) ?? false;
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
  // The allowlist guarantees an array key with a meta segment.
  const meta = query.queryKey[1] as { type?: unknown } | null | undefined;
  if (meta?.type !== 'infinite') {
    return true;
  }
  const data = query.state.data as { pageParams?: unknown[] } | undefined;
  return (data?.pageParams?.length ?? 1) <= 1;
}

// ── Persister ──────────────────────────────────────────────────────────────

type ReadCachePersisterOptions = {
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
  const { queryClient, userId, epoch } = options;
  const owner = getAuthenticatedOwner();
  const scope = readCacheScope(userId);

  // Publication fence: every sign-in and sign-out bumps the epoch, and the
  // authoritative user id comes from the live getMe query, so an epoch or
  // user mismatch at write time means the session changed after creation.
  // The shared sign-out flag (`@/lib/auth/sign-out-state`, the same one the
  // auth context exposes as `isSigningOut`) is flipped synchronously at the
  // start of sign-out, so a write is also refused while teardown is still
  // clearing scopes — even from a persister created at the current epoch while
  // the old user id is cached.
  const isPublicationAllowed = (): boolean =>
    !isSignOutActive() &&
    isCurrentAuthEpoch(epoch) &&
    isAuthenticatedOwner(owner) &&
    owner.userId === userId &&
    readCachedUserId(queryClient) === userId;

  const storage: AsyncStorage = {
    getItem: async k => {
      if (!isPublicationAllowed()) {
        return null;
      }
      const value = await encryptedKv.getItem(scope, k);
      return isPublicationAllowed() ? value : null;
    },
    setItem: async (k, v) => {
      if (isPublicationAllowed()) {
        await encryptedKv.setItem(scope, k, v, isPublicationAllowed);
      }
    },
    removeItem: async k => {
      if (isPublicationAllowed()) {
        await encryptedKv.removeItem(scope, k, isPublicationAllowed);
      }
    },
  };
  const base = createAsyncStoragePersister({ storage, key: READ_CACHE_KEY });

  return {
    ...base,
    restoreClient: async () => {
      const client = await base.restoreClient();
      if (!client || !isPublicationAllowed()) {
        return undefined;
      }
      const identity = client.clientState.queries.find(
        query => JSON.stringify(query.queryKey) === JSON.stringify(GET_ME_QUERY_KEY)
      );
      const cachedOwner = cachedUserSchema.safeParse(identity?.state.data);
      if (!cachedOwner.success || cachedOwner.data.id !== userId) {
        return undefined;
      }
      return {
        ...client,
        clientState: {
          mutations: [],
          // Identity and membership must come from this generation's server responses, not disk.
          queries: client.clientState.queries.filter(query => {
            const path = JSON.stringify(query.queryKey[0]);
            return (
              query.state.status === 'success' &&
              (isReadCacheAllowedKey(query.queryKey) ||
                SERIALIZED_SESSION_LIST_KEYS.has(hashKey(query.queryKey))) &&
              path !== '["user","getMe"]' &&
              path !== '["organizations","list"]'
            );
          }),
        },
      };
    },
    persistClient: async client => {
      if (!isPublicationAllowed()) {
        return;
      }
      if (utf8ByteLength(JSON.stringify(client)) > READ_CACHE_MAX_BYTES) {
        await base.removeClient();
        return;
      }
      await base.persistClient(client);
    },
  };
}

/** The caller's owner proof, not active-user-id or a cached getMe, authorizes hydration. */
export async function restorePersistedCacheForOwner(
  queryClient: QueryClient,
  owner: AuthenticatedOwner,
  isCurrent: () => boolean
): Promise<void> {
  if (!isAuthenticatedOwner(owner) || owner.userId === null || !isCurrent()) {
    return;
  }
  const persister = createReadCachePersister({
    queryClient,
    userId: owner.userId,
    epoch: owner.authEpoch,
  });
  try {
    await persistQueryClientRestore({
      queryClient,
      maxAge: READ_CACHE_MAX_AGE_MS,
      persister: {
        ...persister,
        restoreClient: async () => {
          const client = await persister.restoreClient();
          return isAuthenticatedOwner(owner) && isCurrent() ? client : undefined;
        },
      },
    });
  } catch {
    // The library rethrows after its guarded cache cleanup. Cache failure must not block live data.
  }
}

// ── Cold-start restore ─────────────────────────────────────────────────────

let coldStartGeneration = 0;
let coldStartRestoredScope: string | null = null;

/**
 * Compatibility entry for the root layout. Capture the legacy identity hint without reading content.
 * Only restorePersistedCacheForOwner can hydrate, after this generation's authoritative identity resolves.
 * Remove the hint entry once the root layout no longer invokes the legacy cold-start contract.
 */
export async function restorePersistedCacheOnColdStart(_queryClient: QueryClient): Promise<void> {
  coldStartGeneration += 1;
  const generation = coldStartGeneration;
  const epoch = currentAuthEpoch();
  try {
    const hintUserId = await SecureStore.getItemAsync(ACTIVE_USER_ID_KEY);
    if (generation === coldStartGeneration && hintUserId && isCurrentAuthEpoch(epoch)) {
      // Compatibility entry for the root layout: retain only the hint, never hydrate content.
      // The authenticated mount reads the cache only after this generation's getMe proves ownership.
      coldStartRestoredScope = readCacheScope(hintUserId);
    }
  } catch {
    // A failed hint costs a warm start, never authorizes a different account.
  }
}

/**
 * Marks the authenticated mount as the cache owner: any still-pending cold-
 * start hint read is abandoned. Return and clear the hint scope; it never authorizes hydration.
 */
export function takeOverColdStartRestore(): string | null {
  coldStartGeneration += 1;
  const scope = coldStartRestoredScope;
  coldStartRestoredScope = null;
  return scope;
}

// ── Sign-out cleanup ───────────────────────────────────────────────────────

/**
 * Removes every read-cache scope of the signed-out user, or every `cache:`
 * scope when the identity is unknown — privacy wins over a warm start. The
 * user prefix ends in the scope separator, so it covers every schema version
 * (a bump would otherwise leave the previous version's blob on the device
 * forever) and matches neither another user's scope nor the `draft:` scopes.
 * Best effort: a storage failure is swallowed so a failed cleanup can never
 * abort sign-out; the stale blob only costs a future warm start.
 */
export async function clearCacheScopeForSignOut(knownUserId: string | null): Promise<void> {
  const owner = getAuthenticatedOwner();
  const epoch = currentAuthEpoch();
  const isCurrent = () =>
    isCurrentAuthEpoch(epoch) && getAuthenticatedOwner().generation === owner.generation;
  try {
    await encryptedKv.clearScopePrefix(
      knownUserId ? `${CACHE_SCOPE_PREFIX}${knownUserId}:` : CACHE_SCOPE_PREFIX,
      isCurrent,
      Boolean(knownUserId)
    );
  } catch {
    // Best effort: query and auth state reset still run after this returns.
  }
}
