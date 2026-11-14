import { type Query, type QueryClient } from '@tanstack/react-query';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import {
  type AsyncStorage,
  type PersistedClient,
  type Persister,
  persistQueryClientRestore,
} from '@tanstack/react-query-persist-client';
import { z } from 'zod';

import { buildAgentSessionListInput } from '@/lib/agent-session-input';
import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { readStoredValueWithRetry } from '@/lib/auth/secure-store-read';
import { isSignOutActive, setSignOutActive } from '@/lib/auth/sign-out-state';
import { READ_CACHE_SCOPE_PREFIX, readCacheScope } from '@/lib/persist/cache-scope';
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

// Scope derivation and the schema-version constant live in a module with no
// native dependency, so the briefing surfaces (and anything else that keys its
// own persisted records into this scope) never pull the SQLCipher store into
// their import graph. Re-exported here: the existing callers import them from
// this module.
export { readCacheScope, SCHEMA_VERSION } from '@/lib/persist/cache-scope';

export const READ_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const READ_CACHE_MAX_BYTES = 2 * 1024 * 1024;

const READ_CACHE_KEY = 'read-cache';

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

/** Authoritative user id from the cached `user.getMe` result, or null. */
export function readCachedUserId(queryClient: QueryCacheReader): string | null {
  const data = queryClient.getQueryData?.(GET_ME_QUERY_KEY);
  const parsed = cachedUserSchema.safeParse(data);
  return parsed.success ? parsed.data.id : null;
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
  /**
   * Present only for a procedure whose payload can name an organization. Such
   * an entry persists the payloads this accepts and nothing else. The key rule
   * decides which scope an entry may hold at all; this rule decides which
   * content that scope may keep, because the key does not name the organization
   * of every row a result carries.
   */
  isAllowedPayload?: (data: unknown) => boolean;
};

/**
 * The exact default first-page input the app builds for the personal session
 * list (`buildAgentSessionListInput({ organizationId: null })`). The app's
 * list callers always pass the organization context, and personal context is
 * `null`, so the persisted snapshot must match this shape field for field.
 */
const DEFAULT_SESSION_LIST_INPUT = buildAgentSessionListInput({ organizationId: null });

// A list that names an organization is not cached at all: those rows are read
// from the server, which owns the access decision. The payload rule below reads
// the content a snapshot holds, and an empty page holds no report whose context
// could name the organization, so the key is the only place that can deny the
// organization scope itself. `organizationId` stays declared as absent-only
// because the callers pass it as `undefined` for the other scopes, and a strict
// object rejects an own key it does not declare.
const briefingListCacheInputSchema = z
  .object({
    scope: z.enum(['all', 'personal']).optional(),
    organizationId: z.undefined().optional(),
    currentOnly: z.boolean(),
    limit: z.union([z.literal(1), z.literal(30), z.literal(100)]),
    cursor: z.undefined().optional(),
  })
  .strict();
const briefingDetailCacheInputSchema = z.object({ reportId: z.string().min(1) }).strict();

// A briefing payload carries the context it belongs to, so its own shape says
// whether it holds organization data. Only a payload every part of which names
// no organization is restored: an organization snapshot is read from the
// server, which owns the access decision, and never painted from this cache.
const briefingContextPayloadSchema = z.object({ organizationId: z.string().nullable() });
const briefingContextRefPayloadSchema = z.object({ context: briefingContextPayloadSchema });
const briefingListPageSchema = z.object({ reports: z.array(briefingContextRefPayloadSchema) });
const briefingListPagesSchema = z.object({ pages: z.array(briefingListPageSchema) });
const briefingPreferencesPayloadSchema = z.object({
  contexts: z.array(briefingContextRefPayloadSchema),
});

function isPersonalBriefingPage(page: z.infer<typeof briefingListPageSchema>): boolean {
  return page.reports.every(report => report.context.organizationId === null);
}

function isPersonalBriefingList(data: unknown): boolean {
  const pages = briefingListPagesSchema.safeParse(data);
  if (pages.success) {
    return pages.data.pages.every(isPersonalBriefingPage);
  }
  const page = briefingListPageSchema.safeParse(data);
  return page.success && isPersonalBriefingPage(page.data);
}

function isPersonalBriefingReport(data: unknown): boolean {
  const parsed = briefingContextRefPayloadSchema.safeParse(data);
  return parsed.success && parsed.data.context.organizationId === null;
}

function isPersonalBriefingPreferences(data: unknown): boolean {
  const parsed = briefingPreferencesPayloadSchema.safeParse(data);
  return parsed.success && parsed.data.contexts.every(item => item.context.organizationId === null);
}

// Initial allowlist. Verified against the mobile tRPC router
// (`packages/trpc/src/mobile.ts`) before coding.
const ALLOWED_PROCEDURES: readonly AllowedProcedure[] = [
  {
    path: 'agentBriefing.list',
    isAllowedInput: meta => briefingListCacheInputSchema.safeParse(metaInput(meta)).success,
    isAllowedPayload: isPersonalBriefingList,
  },
  {
    path: 'agentBriefing.get',
    isAllowedInput: meta => briefingDetailCacheInputSchema.safeParse(metaInput(meta)).success,
    isAllowedPayload: isPersonalBriefingReport,
  },
  {
    path: 'agentBriefing.preferences',
    isAllowedInput: () => true,
    isAllowedPayload: isPersonalBriefingPreferences,
  },
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
    //
    // Serialization drops `undefined` fields, so a restored key carries only
    // the fields the default builder set to a value. A missing field and an
    // `undefined` field are therefore the same input, and the comparison runs
    // field by field over the default instead of over the key count.
    isAllowedInput: meta => {
      const input = metaInput(meta);
      if (input === undefined) {
        return false;
      }
      const allowedFields = Object.keys(DEFAULT_SESSION_LIST_INPUT);
      return (
        Object.keys(input).every(field => allowedFields.includes(field)) &&
        Object.entries(DEFAULT_SESSION_LIST_INPUT).every(
          ([field, value]) => (input[field] ?? null) === (value ?? null)
        )
      );
    },
  },
];

/** The allowlist entry for this query path, or undefined. */
function allowedProcedureFor(queryKey: unknown): AllowedProcedure | undefined {
  if (!Array.isArray(queryKey) || queryKey.length < 2) {
    return undefined;
  }
  const segments = queryKey[0];
  if (!Array.isArray(segments) || segments.length === 0) {
    // Flat application keys (e.g. ['org-default-model', <id>]) and empty
    // paths are denied, never thrown on.
    return undefined;
  }
  const path = segments.join('.');
  return ALLOWED_PROCEDURES.find(procedure => procedure.path === path);
}

/** The allowlist entry that admits this query key and its input, or undefined. */
function admittedProcedure(queryKey: unknown): AllowedProcedure | undefined {
  const allowed = allowedProcedureFor(queryKey);
  if (!allowed || !Array.isArray(queryKey)) {
    return undefined;
  }
  return allowed.isAllowedInput(queryKey[1]) ? allowed : undefined;
}

/**
 * True when a query key is an allowlisted tRPC shape. The exact-path allowlist
 * is the only filter: every other path — transcript pages, patches, diffs,
 * tokens and secrets — is denied because it is not on the list.
 */
export function isReadCacheAllowedKey(queryKey: unknown): boolean {
  return admittedProcedure(queryKey) !== undefined;
}

/**
 * True when the payload holds no more than the first page. The tRPC adapter
 * strips `cursor`/`direction` from infinite-query keys, so every loaded page
 * shares the same key and only the loaded data can prove the snapshot is the
 * first page.
 */
function holdsFirstPageOnly(queryKey: unknown, data: unknown): boolean {
  // The allowlist guarantees an array key with a meta segment.
  const meta = (queryKey as readonly unknown[])[1] as { type?: unknown } | null | undefined;
  if (meta?.type !== 'infinite') {
    return true;
  }
  const page = data as { pageParams?: unknown[] } | undefined;
  return (page?.pageParams?.length ?? 1) <= 1;
}

/** True when the snapshot passes the entry's payload rule and holds the first page only. */
function snapshotAllowed(
  lookup: (queryKey: unknown) => AllowedProcedure | undefined,
  queryKey: unknown,
  state: { status: string; data: unknown }
): boolean {
  if (state.status !== 'success') {
    return false;
  }
  const allowed = lookup(queryKey);
  return (
    allowed !== undefined &&
    (allowed.isAllowedPayload === undefined || allowed.isAllowedPayload(state.data)) &&
    holdsFirstPageOnly(queryKey, state.data)
  );
}

/**
 * True when a snapshot of this query may enter — or leave — the persisted
 * cache: an allowlisted key whose input and payload the entry accepts, holding
 * the first page only. The restore applies the same rule, so a stored entry the
 * write path would not keep never hydrates.
 */
function isPersistableSnapshot(
  queryKey: unknown,
  state: { status: string; data: unknown }
): boolean {
  return snapshotAllowed(admittedProcedure, queryKey, state);
}

/** Persist only successful queries whose snapshot this build restores. */
export function shouldPersistReadCacheQuery(query: Query): boolean {
  return isPersistableSnapshot(query.queryKey, query.state);
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
    !isSignOutActive() && isCurrentAuthEpoch(epoch) && readCachedUserId(queryClient) === userId;

  const storage: AsyncStorage = {
    getItem: async k => {
      const value = await encryptedKv.getItem(scope, k);
      return value;
    },
    setItem: async (k, v) => {
      // The fence also guards the storage write: the async-storage persister
      // throttles saves, so the actual write can happen after teardown.
      if (!isPublicationAllowed()) {
        return;
      }
      // The budget is enforced here, on the string the library already
      // serialized for this throttled save, so the un-throttled per-change
      // path never serializes the blob or scans it for its byte length.
      if (utf8ByteLength(v) > READ_CACHE_MAX_BYTES) {
        // Oversized blobs are never written partially: the previous blob for
        // this scope is removed so a stale snapshot cannot survive the write
        // that replaced it.
        await encryptedKv.removeItem(scope, k);
        return;
      }
      await encryptedKv.setItem(scope, k, v);
    },
    removeItem: async k => {
      await encryptedKv.removeItem(scope, k);
    },
  };

  // The library's `persistClient` is the throttle itself and is the only
  // serializer: it serializes once per save and hands that string to `setItem`,
  // which holds the publication fence and the 2 MB budget. No wrapper may
  // serialize on the un-throttled per-change path.
  return createAsyncStoragePersister({ storage, key: READ_CACHE_KEY });
}

// ── Cold-start restore ─────────────────────────────────────────────────────

let coldStartGeneration = 0;
let coldStartRestoredScope: string | null = null;

/**
 * Drops restored queries this build would not restore. A blob written by an
 * earlier build can hold an entry the current rule never hydrates, and a cold
 * start must not paint it once and fetch it after.
 */
function withoutUnrestorableQueries(persisted: PersistedClient): PersistedClient {
  const { queries } = persisted.clientState;
  const restorable = queries.filter(query => isPersistableSnapshot(query.queryKey, query.state));
  if (restorable.length === queries.length) {
    return persisted;
  }
  return { ...persisted, clientState: { ...persisted.clientState, queries: restorable } };
}

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
  // Capture the epoch before the first stored-value read: a sign-in or sign-out
  // that lands while the hint read or the KV read is in flight fences the
  // whole restore, so it can never hydrate (or claim a scope) after the auth
  // epoch moved — including after a logout that cleared the query client.
  const epoch = currentAuthEpoch();
  try {
    // The identity hint read is retried on a transient keychain rejection: a
    // rejected read must not abandon the restore, or the profile's cached
    // identity is never hydrated and the first foreground refetch has nothing
    // to render.
    const hintUserId = await readStoredValueWithRetry(ACTIVE_USER_ID_KEY);
    if (generation !== coldStartGeneration || !hintUserId || !isCurrentAuthEpoch(epoch)) {
      return;
    }
    const persister = createReadCachePersister({
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
        return generation === coldStartGeneration && isCurrentAuthEpoch(epoch) && restored
          ? withoutUnrestorableQueries(restored)
          : undefined;
      },
    };
    // No `buster`: the scope segment already carries the schema version, so a
    // blob written by an older schema lives in another scope and is never read.
    await persistQueryClientRestore({
      queryClient,
      persister: fencedPersister,
      maxAge: READ_CACHE_MAX_AGE_MS,
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
  try {
    await encryptedKv.clearScopePrefix(
      knownUserId ? `${READ_CACHE_SCOPE_PREFIX}${knownUserId}:` : READ_CACHE_SCOPE_PREFIX
    );
  } catch {
    // Best effort: query and auth state reset still run after this returns.
  }
}
