import { useSyncExternalStore } from 'react';
import { z } from 'zod';

import { chainSave } from '@/lib/hooks/save-chain';
import { USER_SESSION_TITLES_KEY } from '@/lib/storage-keys';

/**
 * Durable record of the titles the app's own rename flow wrote for sessions
 * whose stored title the backend's placeholder pattern would otherwise
 * classify as unnamed.
 *
 * The backend names an unnamed session with a raw ISO placeholder such as
 * `New session - 2026-09-22T02:05:22.778Z`, and the rename API accepts any
 * nonblank title, so a user may choose a title that is textually identical to
 * that placeholder. Stored text alone cannot prove who wrote it, so the app
 * records the titles its rename flow wrote and never hides those as unnamed.
 * The record is persisted to the encrypted KV store (DEC-01) and hydrated at
 * module init, so it survives an app restart. A process-local map lost it on a
 * cold start and the user's own title reverted to the localized unnamed label.
 *
 * Only a placeholder-shaped title needs recording — every other title is
 * returned as-is without consulting this store — so the caller filters before
 * writing and the record stays tiny.
 *
 * The encrypted KV is loaded lazily so the synchronous store API stays free of
 * the native SQLCipher chain (and importable in node tests). Until hydration
 * completes the store is empty, so a title the user chose before the restart is
 * hidden for the first frames; `useUserSessionTitlesRevision` re-renders the
 * consumers once it lands.
 */

/** Item key for the single serialized titles blob under the storage scope. */
const USER_SESSION_TITLES_ENTRY_KEY = 'entries';

const persistedTitleSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
});

const persistedTitlesSchema = z.array(persistedTitleSchema);

type UserSessionTitlesStore = {
  listeners: Set<() => void>;
  titles: Map<string, string>;
  revision: number;
};

const STORE_KEY = '__kiloUserSessionTitlesStore__';
const globalScope = globalThis as typeof globalThis & { [STORE_KEY]?: UserSessionTitlesStore };
const store: UserSessionTitlesStore = (globalScope[STORE_KEY] ??= {
  listeners: new Set<() => void>(),
  titles: new Map<string, string>(),
  revision: 0,
});

// ── Encrypted KV (lazy) ─────────────────────────────────────────────────────

/** The three encrypted-KV calls this module uses, kept structural so the lazy
 * import never pulls the native SQLCipher chain into this module's types. */
type UserSessionTitlesKv = {
  getItem: (scope: string, k: string) => Promise<string | null>;
  setItem: (scope: string, k: string, v: string) => Promise<void>;
  clearScope: (scope: string) => Promise<void>;
};

let kvModulePromise: Promise<UserSessionTitlesKv | null> | null = null;

// eslint-disable-next-line require-await, @typescript-eslint/require-await -- single-flight must memoize the lazy import synchronously before any await; the awaits live inside the memoized import chain (same pattern as openDatabase in encrypted-kv.ts)
async function loadKv(): Promise<UserSessionTitlesKv | null> {
  kvModulePromise ??= (async () => {
    try {
      return await import('@/lib/persist/encrypted-kv');
    } catch {
      // The native SQLCipher chain cannot load in a node test environment.
      // Treat it as "KV unavailable": the in-memory store stays authoritative.
      return null;
    }
  })();
  return kvModulePromise;
}

// ── Persistence ─────────────────────────────────────────────────────────────

function serializeTitles(): string {
  const titles: { sessionId: string; title: string }[] = [];
  for (const [sessionId, title] of store.titles) {
    titles.push({ sessionId, title });
  }
  return JSON.stringify(titles);
}

async function writeTitlesSafely(serialized: string): Promise<void> {
  const kv = await loadKv();
  if (!kv) {
    return;
  }
  try {
    await kv.setItem(USER_SESSION_TITLES_KEY, USER_SESSION_TITLES_ENTRY_KEY, serialized);
  } catch {
    // Swallow: a failed write keeps the in-memory store authoritative and the
    // next remember retries the whole blob.
  }
}

// Writes are chained through `chainSave` so the last remember lands last; each
// write is fire-and-forget and never rejects.
let lastWrite: Promise<void> | null = null;

function persistTitles(): void {
  lastWrite = chainSave(USER_SESSION_TITLES_KEY, async () => {
    // Serialize only after hydration settles. A remember that lands during the
    // hydration window must not overwrite the persisted blob before the
    // hydrated titles are applied, or it erases other sessions' titles.
    await hydrationPromise;
    const serialized = serializeTitles();
    await writeTitlesSafely(serialized);
  });
}

// ── Hydration ───────────────────────────────────────────────────────────────

function parseTitles(raw: string): { sessionId: string; title: string }[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = persistedTitlesSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function applyHydratedTitles(raw: string): boolean {
  const titles = parseTitles(raw);
  if (!titles) {
    return false;
  }
  let applied = false;
  for (const entry of titles) {
    // A rename that landed after hydration began must win over the stale
    // persisted entry: a present in-memory entry means this session already
    // changed this run, so the persisted snapshot is out of date.
    if (!store.titles.has(entry.sessionId)) {
      store.titles.set(entry.sessionId, entry.title);
      applied = true;
    }
  }
  return applied;
}

let hydrationPromise: Promise<void> | null = null;

// eslint-disable-next-line require-await, @typescript-eslint/require-await -- single-flight must memoize hydration synchronously before any await; the awaits live inside the memoized hydration chain (same pattern as openDatabase in encrypted-kv.ts)
async function hydrate(): Promise<void> {
  if (hydrationPromise) {
    return hydrationPromise;
  }
  hydrationPromise = (async () => {
    const kv = await loadKv();
    if (!kv) {
      return;
    }
    try {
      const raw = await kv.getItem(USER_SESSION_TITLES_KEY, USER_SESSION_TITLES_ENTRY_KEY);
      if (raw !== null && applyHydratedTitles(raw)) {
        // A restored title changes what a row or header renders: notify
        // subscribers so they re-render and re-evaluate their title.
        bumpRevision();
      }
    } catch {
      // Unreadable KV: start empty; the backend placeholder stays hidden.
    }
  })();
  return hydrationPromise;
}

// Hydrate at module init, before the first read. The store stays empty until
// this completes, so a title chosen before the restart stays hidden in the
// meantime; a consumer subscribed to the revision repaints when it lands.
void hydrate();

// ── Store ───────────────────────────────────────────────────────────────────

function bumpRevision(): void {
  store.revision += 1;
  // Isolate subscribers: one throwing listener must not prevent the rest from
  // being notified of the revision change.
  for (const listener of store.listeners) {
    try {
      listener();
    } catch {
      // A subscriber's own error must not break store notification.
    }
  }
}

/** Notify subscribers and persist the new titles map. */
function commit(): void {
  bumpRevision();
  persistTitles();
}

export function subscribe(listener: () => void): () => void {
  store.listeners.add(listener);
  return () => {
    store.listeners.delete(listener);
  };
}

export function getRevisionSnapshot(): number {
  return store.revision;
}

/**
 * Server snapshot for `useSyncExternalStore`. Stable across calls so the hook
 * is SSR / RN-safe; the real revision is read on the client.
 */
function getServerSnapshot(): number {
  return 0;
}

/** Record one title the app's rename flow wrote for `sessionId`. */
export function rememberUserSessionTitle(sessionId: string, title: string): void {
  if (store.titles.get(sessionId) === title) {
    return;
  }
  store.titles.set(sessionId, title);
  commit();
}

/** The recorded user title for `sessionId`, or undefined when none is stored. */
export function getUserSessionTitle(sessionId: string): string | undefined {
  return store.titles.get(sessionId);
}

/**
 * Sign-out cleanup: drop every recorded title from memory and from the
 * encrypted KV.
 *
 * Titles carry the signed-out account's session ids, so they must not survive
 * the teardown — the next account hydrating this scope would read the previous
 * user's ids. The delete is chained through the same FIFO as the writes so a
 * queued remember cannot re-persist the blob afterwards, and hydration is
 * re-armed so the next account does not read the cleared blob through the
 * settled promise of this run.
 *
 * Best effort: a storage failure is swallowed so it can never abort sign-out.
 */
export async function clearUserSessionTitles(): Promise<void> {
  store.titles.clear();
  bumpRevision();
  lastWrite = chainSave(USER_SESSION_TITLES_KEY, async () => {
    const kv = await loadKv();
    if (!kv) {
      return;
    }
    try {
      await kv.clearScope(USER_SESSION_TITLES_KEY);
    } catch {
      // Swallow: the in-memory store is already empty.
    }
  });
  await lastWrite;
  // Re-arm hydration so the next account does not read the cleared blob
  // through the settled promise of this run.
  hydrationPromise = null;
}

/**
 * Subscribe a component to the record's revision counter. When the revision
 * changes, the component re-renders and re-evaluates `namedSessionTitle` for
 * its session.
 */
export function useUserSessionTitlesRevision(): number {
  return useSyncExternalStore(subscribe, getRevisionSnapshot, getServerSnapshot);
}

// ── Seams the suite drives directly ─────────────────────────────────────────

/**
 * Seam for the suite: clear the records in memory and reset the revision
 * counter so each case starts from a known state. Mirrors
 * `__resetSessionAttentionForTests` in `session-attention.ts`; no product path
 * calls it.
 */
export function __resetUserSessionTitlesForTests(): void {
  store.titles.clear();
  store.revision = 0;
  hydrationPromise = null;
  lastWrite = null;
}

/** Seam for the suite: re-run hydration (a simulated restart) and return its promise. */
export async function __hydrateUserSessionTitlesForTests(): Promise<void> {
  hydrationPromise = null;
  await hydrate();
}

/** Seam for the suite: await every queued fire-and-forget KV write. */
export async function __flushUserSessionTitlesWritesForTests(): Promise<void> {
  if (lastWrite) {
    await lastWrite;
  }
}

/** Seam for the suite: the recorded title for a session, or undefined when none. */
export function __peekUserSessionTitleForTests(sessionId: string): string | undefined {
  return store.titles.get(sessionId);
}
