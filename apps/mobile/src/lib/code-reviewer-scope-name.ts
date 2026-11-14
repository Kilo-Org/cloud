import { z } from 'zod';

import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { chainSave } from '@/lib/hooks/save-chain';
import { ACTIVE_USER_ID_KEY, REVIEWER_SCOPE_NAMES_KEY } from '@/lib/storage-keys';
import { reportSecureStoreFailure } from '@/lib/telemetry/secure-store-events';

/**
 * The scope names this app last showed, so a Code Reviewer header can still
 * name an organization after the reader loses the membership.
 *
 * `organizations.list` names only live memberships, and the analytics read
 * denies exactly the organizations the reader is no longer a member of, so a
 * lost membership leaves no server-side name to paint: the denied header would
 * fall back to the generic label exactly when naming the organization matters
 * most. The client remembers the name it painted while access still held.
 *
 * The in-memory map is the source of truth for the current JS run; SecureStore
 * is only a mirror so the names survive a restart. The record carries the
 * account it was written for, so one account's names never paint under another
 * account's header: a record for a different account reads as absent, and the
 * account boundary clears both the map and the mirror.
 */

type ScopeNameEntry = {
  organizationId: string;
  organizationName: string;
  /** When this name was last seen; older entries carry an older stamp. */
  seenAt: number;
};

const scopeNamesSchema = z.object({
  version: z.literal(1),
  userId: z.string().min(1),
  entries: z.array(
    z.object({
      organizationId: z.string().min(1).max(256),
      organizationName: z.string().min(1).max(256),
      seenAt: z.number(),
    })
  ),
});

type ScopeNamesRecord = z.infer<typeof scopeNamesSchema>;

/** Names past this are dropped, oldest first: the record stays one small read. */
const MAX_REMEMBERED_SCOPE_NAMES = 20;

type SecureStoreLike = {
  setItemAsync: (key: string, value: string) => Promise<void>;
  getItemAsync: (key: string) => Promise<string | null>;
  deleteItemAsync: (key: string) => Promise<void>;
};

// Injection seam so the pure suites never load expo-secure-store
// (→ expo-modules-core → RN). Mirrors the last-route pattern.
let secureStoreForTests: SecureStoreLike | null = null;

function getSecureStore(): SecureStoreLike | null {
  if (secureStoreForTests) {
    return secureStoreForTests;
  }
  try {
    // eslint-disable-next-line typescript-eslint/no-require-imports, typescript-eslint/no-var-requires, unicorn/prefer-module -- lazy native load
    return require('expo-secure-store') as SecureStoreLike;
  } catch {
    // A runner, or a development client built before the module landed, has no
    // secure store. The names in memory still paint the header, and the next
    // signed-in launch mirrors them again.
    return null;
  }
}

// organizationId → the name to paint. The map's own insertion order is the
// recency, oldest first, so `trimNames` drops from the front and the record
// writes the reverse.
const names = new Map<string, string>();
// The account the names in memory belong to. Null until the restart read names
// one; a name remembered before then still paints, and its write waits for the
// account (see `rememberScopeName`).
let recordUserId: string | null = null;
let hydration: Promise<void> | null = null;
// Bumped at an account boundary. A restart read captures it before its first
// await and drops every result once it moved, so a read already past the
// account lookup cannot commit the previous account's names or its id after
// `clearScopeNames` ran.
let generation = 0;
// The latest queued mirror write. Held so the pure suite can await the chain
// rather than guess at a delay; every operation swallows its own failure, so
// this never rejects.
let lastWrite: Promise<void> | null = null;
const listeners = new Set<() => void>();
// One flush per turn. A remember or a restored name that lands inside a
// component's mount effect must not re-render a sibling that has not finished
// mounting yet — React reports that as an update on a component that has not
// mounted — so the listeners run after the current turn instead.
let flushScheduled = false;

function notify(): void {
  if (flushScheduled) {
    return;
  }
  flushScheduled = true;
  queueMicrotask(() => {
    flushScheduled = false;
    for (const listener of listeners) {
      listener();
    }
  });
}

/** Parse a stored record; a corrupt or unreadable mirror reads as absent. */
function parseStoredRecord(raw: string): ScopeNamesRecord | null {
  try {
    const result = scopeNamesSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Drop the oldest names past the cap. */
function trimNames(): void {
  while (names.size > MAX_REMEMBERED_SCOPE_NAMES) {
    const oldest = names.keys().next();
    if (oldest.done) {
      return;
    }
    names.delete(oldest.value);
  }
}

/**
 * The record as the mirror holds it. Serialized at write time, inside the
 * per-key chain, so the record always matches the names the reader has been
 * shown by the time the write runs.
 */
function serializeRecord(userId: string): string {
  const now = Date.now();
  // The record lists the newest name first and stamps each one counting down
  // from the write instant, so a load restores the order without reading a
  // clock per name.
  const entries: ScopeNameEntry[] = [...names]
    .toReversed()
    .map(([organizationId, organizationName], index) => ({
      organizationId,
      organizationName,
      seenAt: now - index,
    }));
  return JSON.stringify({ version: 1, userId, entries });
}

/**
 * Queue the mirror behind any earlier write for the same key, so two rapid
 * remembers land in order and a delete settles last.
 */
function queueWrite(operation: () => Promise<void>): void {
  lastWrite = chainSave(REVIEWER_SCOPE_NAMES_KEY, operation);
}

/**
 * Read the remembered names for the active account. Idempotent: a mount after
 * the first read only re-checks the active account, so an account switch in the
 * same process loads that account's own record and the same account is never
 * read twice.
 */
export function hydrateScopeNames(): Promise<void> {
  hydration ??= readRestartOnce();
  return hydration;
}

async function readRestartOnce(): Promise<void> {
  try {
    await restore();
  } finally {
    // The next mount re-checks the active account: `restore` short-circuits
    // when it is the one already loaded.
    hydration = null;
  }
}

async function restore(): Promise<void> {
  const store = getSecureStore();
  if (store === null) {
    return;
  }
  const startedAt = generation;
  try {
    const userId = await store.getItemAsync(ACTIVE_USER_ID_KEY);
    if (generation !== startedAt) {
      return;
    }
    if (userId === null || userId === recordUserId) {
      return;
    }
    // Names remembered for another account must never paint under this one.
    if (recordUserId !== null) {
      recordUserId = null;
      names.clear();
      notify();
    }
    const raw = await store.getItemAsync(REVIEWER_SCOPE_NAMES_KEY);
    // The clear that landed during this read owns the store now: its delete
    // covers the record this read would apply, and the empty map is the truth.
    if (generation !== startedAt) {
      return;
    }
    // Only a completed record read commits the account. A refused read leaves
    // it unset, so the next hydrate reaches the record again instead of
    // short-circuiting, and no remember can serialize a map that never saw it.
    recordUserId = userId;
    if (raw === null) {
      return;
    }
    const parsed = parseStoredRecord(raw);
    if (parsed === null || parsed.userId !== userId) {
      // A corrupt record, or one written for another account, reads as absent.
      return;
    }
    // The names already in memory were painted this run, so they are fresher
    // than anything the record holds: the restored ones fill in behind them,
    // taking the newest slots the cap leaves and landing oldest first.
    const restored = parsed.entries
      .filter(entry => !names.has(entry.organizationId))
      .slice(0, MAX_REMEMBERED_SCOPE_NAMES - names.size)
      .toReversed();
    if (restored.length === 0) {
      return;
    }
    const painted = [...names];
    names.clear();
    for (const entry of restored) {
      names.set(entry.organizationId, entry.organizationName);
    }
    for (const [organizationId, organizationName] of painted) {
      names.set(organizationId, organizationName);
    }
    notify();
  } catch (error) {
    // A mirror that cannot be read is treated as absent; the next remember
    // fills it.
    reportSecureStoreFailure('read', error);
  }
}

/** The name this app last showed for a scope, for a render path. */
export function readScopeName(scopeId: string): string | undefined {
  return names.get(scopeId);
}

/**
 * Remember the name the app just showed for a scope. An unchanged name is not
 * re-recorded: every mount would otherwise rewrite the device record and
 * re-order the recency for nothing.
 */
export function rememberScopeName(scopeId: string, name: string): void {
  if (scopeId.length === 0 || name.length === 0 || names.get(scopeId) === name) {
    return;
  }
  names.delete(scopeId);
  names.set(scopeId, name);
  trimNames();
  notify();
  // Captured as the name is painted: a sign-out or account switch after this
  // point must invalidate the write, exactly like `writeAccountMetadata`'s
  // fence. The fence and the per-key chain are inlined here because that helper
  // imports the SecureStore plumbing eagerly, which would load the native
  // module for every screen that titles a scope; this store stays lazy.
  const epoch = currentAuthEpoch();
  queueWrite(async () => {
    if (!isCurrentAuthEpoch(epoch)) {
      return;
    }
    // The account is known only once the restart read settles, so a name
    // remembered before it lands is written under the account that read names.
    await hydrateScopeNames();
    if (!isCurrentAuthEpoch(epoch) || recordUserId === null) {
      return;
    }
    const store = getSecureStore();
    if (store === null) {
      return;
    }
    try {
      await store.setItemAsync(REVIEWER_SCOPE_NAMES_KEY, serializeRecord(recordUserId));
    } catch (error) {
      // A failed mirror leaves the in-memory names authoritative and is
      // reported at warning level so a keychain failure is visible.
      reportSecureStoreFailure('write', error);
    }
  });
}

/**
 * Subscribe to name changes — the `useSyncExternalStore` contract, with
 * `readScopeName(scope)` as the snapshot. Registering is all it does: the
 * restart read belongs to the subscriber's own effect (`hydrateScopeNames`), so
 * mounting a subscription neither touches the keychain nor notifies.
 */
export function subscribeScopeNames(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Drop the remembered names at an account boundary: the map empties now, and
 * the mirror's delete is serialized behind any write already queued for the
 * same key, so it always lands last. A queued-but-unstarted write skips through
 * its own epoch check, which is the same ordering `deleteAccountMetadata`
 * relies on.
 */
export function clearScopeNames(): void {
  const hadNames = names.size > 0 || recordUserId !== null;
  // Bumped before the state moves, so a restart read already holding this
  // account cannot commit its names or its id after this clear.
  generation += 1;
  names.clear();
  recordUserId = null;
  hydration = null;
  if (hadNames) {
    notify();
  }
  queueWrite(async () => {
    const store = getSecureStore();
    if (store === null) {
      return;
    }
    try {
      await store.deleteItemAsync(REVIEWER_SCOPE_NAMES_KEY);
    } catch (error) {
      reportSecureStoreFailure('delete', error);
    }
  });
}

// ── Injection seams used by the pure suites ────────────────────────────────

export function _setSecureStoreForTests(store: SecureStoreLike | null): void {
  secureStoreForTests = store;
}

/** Await the mirror chain's latest write instead of guessing a delay. */
export async function _flushScopeNameWritesForTests(): Promise<void> {
  await lastWrite;
}

/** Re-run the restart read from the current mirror (a simulated restart). */
export async function _hydrateScopeNamesForTests(): Promise<void> {
  hydration = null;
  await hydrateScopeNames();
}

export function _resetScopeNamesForTests(): void {
  names.clear();
  recordUserId = null;
  hydration = null;
  flushScheduled = false;
  // Bumped, not zeroed: a restart read still in flight from an earlier test
  // must not commit into this one.
  generation += 1;
  lastWrite = null;
  listeners.clear();
  secureStoreForTests = null;
}
