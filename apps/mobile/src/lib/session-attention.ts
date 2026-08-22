import { useSyncExternalStore } from 'react';
import { z } from 'zod';

import { chainSave } from '@/lib/hooks/save-chain';
import { SESSION_ATTENTION_KEY } from '@/lib/storage-keys';

/**
 * Durable session-attention ack store for the mobile Agents session list
 * "needs input" indicator.
 *
 * Acks are written only when the user successfully answers, skips, or
 * responds to a permission — never on merely opening the detail screen.
 * Entries are persisted to the encrypted KV store (DEC-01) under one storage
 * key and hydrated at module init, so an ack survives an app restart. No
 * secrets are persisted: entries hold only session ids, raise ids, the
 * attention status, and ack/expiry timestamps.
 *
 * Raise identity is `statusUpdatedAt ?? status` (stored rows carry server
 * `status_updated_at`; remote active-only rows carry none so identity
 * degrades to the status string). Priority and action are derived, never
 * stored: `question` sorts before `permission`, and the action is the
 * existing navigation to the session detail.
 *
 * The encrypted KV is loaded lazily so the synchronous store API stays free
 * of the native SQLCipher chain (and importable in node tests). Until
 * hydration completes the store is empty, so badges render from server status
 * alone; a restored ack then suppresses its raise.
 *
 * No backend, tRPC, or shared-package imports: this is a mobile-local
 * module so the web client can keep its own copy.
 */

const ATTENTION_STATUSES = new Set(['question', 'permission']);

/** Attention acks expire 7 days after the ack. */
export const SESSION_ATTENTION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/** Item key for the single serialized entries blob under the storage key. */
const SESSION_ATTENTION_ENTRY_KEY = 'entries';

const persistedEntrySchema = z.object({
  sessionId: z.string(),
  raiseId: z.string().nullable(),
  status: z.string().nullable(),
  ackedAt: z.number().nullable(),
  expiresAt: z.number().nullable(),
});

const persistedEntriesSchema = z.array(persistedEntrySchema);

export function sessionNeedsInput(status: string | null | undefined): boolean {
  return status != null && ATTENTION_STATUSES.has(status);
}

/**
 * One durable ack entry. `sessionId` is the map key and is added to the
 * persisted form at serialization time.
 *
 * `raiseId === null` marks a pending ack (acked, raise not yet observed).
 * `ackedAt === null` marks a cleared ack (a same-session re-raise replaced
 * the raise and cleared the ack so the badge returns).
 */
type AttentionEntry = {
  raiseId: string | null;
  status: string | null;
  ackedAt: number | null;
  expiresAt: number | null;
};

/** Serialized shape: one entry per session, `sessionId` included. */
type PersistedAttentionEntry = AttentionEntry & { sessionId: string };

type AttentionStore = {
  listeners: Set<() => void>;
  entries: Map<string, AttentionEntry>;
  revision: number;
};

const STORE_KEY = '__kiloSessionAttentionStore__';
const globalScope = globalThis as typeof globalThis & { [STORE_KEY]?: AttentionStore };
const store: AttentionStore = (globalScope[STORE_KEY] ??= {
  listeners: new Set<() => void>(),
  entries: new Map<string, AttentionEntry>(),
  revision: 0,
});

// ── Encrypted KV (lazy) ─────────────────────────────────────────────────────

/** The two encrypted-KV calls this module uses, kept structural so the lazy
 * import never pulls the native SQLCipher chain into this module's types. */
type AttentionKv = {
  getItem: (scope: string, k: string) => Promise<string | null>;
  setItem: (scope: string, k: string, v: string) => Promise<void>;
};

let kvModulePromise: Promise<AttentionKv | null> | null = null;

// eslint-disable-next-line require-await, @typescript-eslint/require-await -- single-flight must memoize the lazy import synchronously before any await; the awaits live inside the memoized import chain (same pattern as openDatabase in encrypted-kv.ts)
async function loadKv(): Promise<AttentionKv | null> {
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

function serializeEntries(): string {
  const entries: PersistedAttentionEntry[] = [];
  for (const [sessionId, entry] of store.entries) {
    entries.push({ sessionId, ...entry });
  }
  return JSON.stringify(entries);
}

async function writeEntriesSafely(serialized: string): Promise<void> {
  const kv = await loadKv();
  if (!kv) {
    return;
  }
  try {
    await kv.setItem(SESSION_ATTENTION_KEY, SESSION_ATTENTION_ENTRY_KEY, serialized);
  } catch {
    // Swallow: a failed write keeps the in-memory store authoritative and
    // retries on the next bump.
  }
}

// Writes are chained through `chainSave` so the last bump's state lands last;
// each write is fire-and-forget and never rejects.
let lastWrite: Promise<void> | null = null;

function persistEntries(): void {
  lastWrite = chainSave(SESSION_ATTENTION_KEY, async () => {
    // Serialize only after hydration settles. A write that lands during the
    // hydration window must not overwrite the persisted blob before the
    // hydrated entries are applied, or it erases other sessions' acks.
    await hydrationPromise;
    const serialized = serializeEntries();
    await writeEntriesSafely(serialized);
  });
}

// ── Hydration ───────────────────────────────────────────────────────────────

function parseEntries(raw: string): PersistedAttentionEntry[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = persistedEntriesSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function applyHydratedEntries(raw: string): boolean {
  const entries = parseEntries(raw);
  if (!entries) {
    return false;
  }
  const now = Date.now();
  const fresh = entries.filter(entry => entry.expiresAt === null || entry.expiresAt > now);
  let applied = false;
  for (const entry of fresh) {
    // A mutation that landed after hydration began must win over the stale
    // persisted entry: a present in-memory entry means this session already
    // changed this run, so the persisted snapshot is out of date.
    if (!store.entries.has(entry.sessionId)) {
      store.entries.set(entry.sessionId, {
        raiseId: entry.raiseId,
        status: entry.status,
        ackedAt: entry.ackedAt,
        expiresAt: entry.expiresAt,
      });
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
      const raw = await kv.getItem(SESSION_ATTENTION_KEY, SESSION_ATTENTION_ENTRY_KEY);
      if (raw !== null && applyHydratedEntries(raw)) {
        // Restored acks change badge decisions: notify subscribers so rows
        // re-render and re-evaluate `isAttentionAcked`.
        bumpRevision();
      }
    } catch {
      // Unreadable KV: start empty; badges re-derive from server status.
    }
  })();
  return hydrationPromise;
}

// Hydrate at module init, before the first read. The store stays empty until
// this completes, so badges render from server status in the meantime.
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

/** Notify subscribers and persist the new entries map. */
function commit(): void {
  bumpRevision();
  persistEntries();
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
 * Server snapshot for `useSyncExternalStore`. Stable across calls so the
 * hook is SSR / RN-safe; the real revision is read on the client.
 */
function getServerSnapshot(): number {
  return 0;
}

/**
 * Hide the needs-input badge immediately after a successful answer / skip /
 * permission response, before the server status round-trip lands.
 * `reconcileSessionAttention` clears the entry once status leaves attention.
 *
 * If the entry is already pending, nothing changes — skip the bump so we
 * don't fire a redundant global re-render.
 */
export function ackSessionAttention(sessionId: string): void {
  const entry = store.entries.get(sessionId);
  if (entry && entry.ackedAt !== null && entry.raiseId === null) {
    return;
  }
  const now = Date.now();
  store.entries.set(sessionId, {
    raiseId: null,
    status: null,
    ackedAt: now,
    expiresAt: now + SESSION_ATTENTION_EXPIRY_MS,
  });
  commit();
}

/**
 * Reconcile the ack store against the latest observed status.
 *
 * `raiseId = statusUpdatedAt ?? status`.
 *
 * - expired entry: delete it and notify
 * - non-attention status: delete the entry (if any) and notify
 * - attention + existing pending entry: resolve it to the current raise
 * - attention + resolved entry with a different raise: replace the raise and
 *   clear the ack (same-session re-raise) so the badge returns
 * - otherwise: no-op (does NOT bump the revision)
 */
export function reconcileSessionAttention(
  sessionId: string,
  status: string | null | undefined,
  statusUpdatedAt: string | null | undefined
): void {
  const existing = store.entries.get(sessionId);
  if (existing && existing.expiresAt !== null && existing.expiresAt <= Date.now()) {
    store.entries.delete(sessionId);
    commit();
    return;
  }

  if (!sessionNeedsInput(status)) {
    if (store.entries.delete(sessionId)) {
      commit();
    }
    return;
  }

  const raiseId = statusUpdatedAt ?? status ?? null;
  const entry = store.entries.get(sessionId);
  if (!entry) {
    return;
  }

  if (entry.ackedAt === null) {
    // Cleared ack (re-raise): keep tracking the current raise, still unacked.
    if (entry.raiseId !== raiseId) {
      store.entries.set(sessionId, {
        raiseId,
        status: status ?? null,
        ackedAt: null,
        expiresAt: null,
      });
      commit();
    }
    return;
  }

  if (entry.raiseId === null) {
    // Pending ack resolves to the current raise.
    store.entries.set(sessionId, {
      raiseId,
      status: status ?? null,
      ackedAt: entry.ackedAt,
      expiresAt: entry.expiresAt,
    });
    commit();
    return;
  }

  if (entry.raiseId !== raiseId) {
    // Same-session re-raise: replace the raise and clear the ack so the badge
    // returns.
    store.entries.set(sessionId, {
      raiseId,
      status: status ?? null,
      ackedAt: null,
      expiresAt: null,
    });
    commit();
  }
}

export function isAttentionAcked(sessionId: string, raiseId: string | null): boolean {
  const entry = store.entries.get(sessionId);
  if (!entry || entry.ackedAt === null) {
    return false;
  }
  return entry.raiseId === null || entry.raiseId === raiseId;
}

export function shouldShowNeedsInput({
  status,
  raiseId: _raiseId,
  isAcked,
}: {
  status: string | null | undefined;
  raiseId: string | null;
  isAcked: boolean;
}): boolean {
  return sessionNeedsInput(status) && !isAcked;
}

/**
 * Subscribe a component to the ack store's revision counter. When the
 * revision changes, the component re-renders and re-evaluates
 * `isAttentionAcked` for its session.
 */
export function useSessionAttentionRevision(): number {
  return useSyncExternalStore(subscribe, getRevisionSnapshot, getServerSnapshot);
}

// ── Test-only helpers ───────────────────────────────────────────────────────

/**
 * Test-only: clear all acks and reset the revision counter so each
 * test starts from a known state. Not for production use.
 */
export function __resetSessionAttentionForTests(): void {
  store.entries.clear();
  store.revision = 0;
  hydrationPromise = null;
  lastWrite = null;
}

/** Test-only: re-run hydration (a simulated restart) and return its promise. */
export async function __hydrateSessionAttentionForTests(): Promise<void> {
  hydrationPromise = null;
  await hydrate();
}

/** Test-only: await every queued fire-and-forget KV write. */
export async function __flushSessionAttentionWritesForTests(): Promise<void> {
  if (lastWrite) {
    await lastWrite;
  }
}

/**
 * Test-only: peek at a session's ack state (the `raiseId` projection) or
 * undefined when no entry exists. Kept as a projection for compatibility
 * with existing tests; use `__peekSessionAttentionEntryForTests` for the
 * full entry.
 */
export function __peekSessionAttentionForTests(
  sessionId: string
): { raiseId: string | null } | undefined {
  const entry = store.entries.get(sessionId);
  return entry ? { raiseId: entry.raiseId } : undefined;
}

/** Test-only: peek at the full entry for a session (or undefined). */
export function __peekSessionAttentionEntryForTests(sessionId: string): AttentionEntry | undefined {
  return store.entries.get(sessionId);
}
