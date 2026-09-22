import {
  buildOpaqueScopeKey,
  type GlanceableSessionRow,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { z } from 'zod';

import { CLOUD_AGENT_CONNECTION_ID } from '@/lib/active-sessions-live';

import { getLocalScopeKey } from './persist';

/**
 * One durable record of the oldest waiting ask: the session the activity's
 * Approve and Open buttons name.
 *
 * The glanceable snapshot is privacy-minimal by contract — status, counts,
 * timestamps and an opaque scope key, never a session id — so the id the
 * buttons need is kept beside it, locally, while the tray rows that carry `id`
 * are still in scope. Exactly one ask is stored: the app publishes one scope at
 * a time, so the tray's current scope is the only ask that can be actioned.
 *
 * Writes go to SecureStore under one key behind the same lazy `require` guard
 * `persist.ts` uses, so the pure vitest project never loads the native module.
 */

export type WaitingAsk = {
  kiloSessionId: string;
  /** 'permission' | 'question' | 'retry' — the tray row's status. */
  status: string;
  /** True when the row came from the cloud-agent control plane. */
  isCloudAgent: boolean;
  /**
   * The snapshot scope key the ask was recorded under. Read on hydration to
   * fence the mirror to the scope this process currently publishes.
   */
  scopeKey: string;
  organizationId: string | null;
  userId: string;
  recordedAt: number;
};

/**
 * One tray row as the publisher reads it. `id` is optional so the publisher
 * keeps accepting the status-only rows its tests pass; a waiting row without an
 * id is skipped, because a button that cannot name a session cannot action one.
 */
export type WaitingAskRow = GlanceableSessionRow & {
  id?: string;
  connectionId?: string | null;
};

export type WaitingAskContext = {
  userId: string;
  organizationId: string | null;
};

/** The statuses that name a waiting agent the user can approve. */
const ASKING_STATUSES = new Set(['permission', 'question']);

// SecureStore key owned by this module; nothing else owns it.
const WAITING_ASK_KEY = 'glanceable-waiting-ask';

const waitingAskSchema = z.object({
  kiloSessionId: z.string().min(1),
  status: z.string(),
  isCloudAgent: z.boolean(),
  scopeKey: z.string().min(1),
  organizationId: z.string().nullable(),
  userId: z.string(),
  recordedAt: z.number(),
});

/**
 * Epoch ms for a row's status time. An absent or unparseable value sorts after
 * every dated row, so a row whose wait cannot be timed never displaces one that
 * can, and still wins when it is the only row waiting.
 */
function readStatusTime(statusUpdatedAt: string | undefined): number {
  if (statusUpdatedAt === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  const at = Date.parse(statusUpdatedAt);
  return Number.isNaN(at) ? Number.POSITIVE_INFINITY : at;
}

function isAskingRow(row: WaitingAskRow): row is WaitingAskRow & { id: string } {
  return row.id !== undefined && ASKING_STATUSES.has(row.status);
}

/**
 * The waiting ask the action buttons should name, or null when nothing waits.
 *
 * The oldest `statusUpdatedAt` wins; ties keep the first row in tray order,
 * which is the order the publisher already relies on. `isCloudAgent` marks the
 * row the cloud-agent control plane merged in (the sentinel connection id in
 * `active-sessions-live.ts`); a row with no `connectionId` is not cloud-agent.
 */
export function selectWaitingAsk(
  rows: readonly WaitingAskRow[],
  ctx: WaitingAskContext,
  now: number
): WaitingAsk | null {
  let chosen: (WaitingAskRow & { id: string }) | null = null;
  let chosenAt = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    if (isAskingRow(row)) {
      const at = readStatusTime(row.statusUpdatedAt);
      if (chosen === null || at < chosenAt) {
        chosen = row;
        chosenAt = at;
      }
    }
  }
  if (chosen === null) {
    return null;
  }
  return {
    kiloSessionId: chosen.id,
    status: chosen.status,
    isCloudAgent: chosen.connectionId === CLOUD_AGENT_CONNECTION_ID,
    // The snapshot's own scope key, so a sink can fence the ask against the
    // surface it belongs to without re-deriving the hash.
    scopeKey: buildOpaqueScopeKey({ userId: ctx.userId, organizationId: ctx.organizationId }),
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    recordedAt: now,
  };
}

// ── Store ───────────────────────────────────────────────────────────────────

type SecureStoreLike = {
  setItemAsync: (key: string, value: string) => Promise<void>;
  getItemAsync: (key: string) => Promise<string | null>;
  deleteItemAsync: (key: string) => Promise<void>;
};

// Test-only override so pure suites do not load expo-secure-store
// (→ expo-modules-core → RN). Mirrors the persist.ts pattern.
let secureStoreForTests: SecureStoreLike | null = null;

function getSecureStore(): SecureStoreLike {
  if (secureStoreForTests) {
    return secureStoreForTests;
  }
  // eslint-disable-next-line typescript-eslint/no-require-imports, typescript-eslint/no-var-requires, unicorn/prefer-module -- lazy native load
  return require('expo-secure-store') as SecureStoreLike;
}

let currentAsk: WaitingAsk | null = null;

// Monotonic epoch bumped on every in-memory write. Hydration captures it before
// its async read and only fills when it is unchanged, so a live record during
// the read can never be clobbered by a stale persisted record.
let waitingAskEpoch = 0;

// True once this process has recorded (or cleared) an ask. That record's mirror
// write may still be in the chain behind a slower write, so the mirror can hold
// a value this process has already superseded — an ask whose delete is queued.
// Hydration fills only for a process that has not written yet: otherwise a
// record this run made (or cleared) is authoritative, mirror or not.
let recordedInProcess = false;

// The mirror writes, chained one after the other. A later record's write is
// issued only once the previous one has settled, so two rapid records can never
// land out of order on disk, and no rejection escapes: the in-memory value is
// authoritative and the next record repopulates a failed mirror.
let mirrorWrite: Promise<void> | null = null;

async function mirrorAskAfter(
  previous: Promise<void> | null,
  ask: WaitingAsk | null
): Promise<void> {
  if (previous !== null) {
    await previous;
  }
  try {
    const store = getSecureStore();
    await (ask === null
      ? store.deleteItemAsync(WAITING_ASK_KEY)
      : store.setItemAsync(WAITING_ASK_KEY, JSON.stringify(ask)));
  } catch {
    // A missing mirror keeps the in-memory value authoritative.
  }
}

function mirrorAsk(ask: WaitingAsk | null): void {
  mirrorWrite = mirrorAskAfter(mirrorWrite, ask);
}

function parseStoredAsk(raw: string): WaitingAsk | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = waitingAskSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * True when a mirrored ask belongs to the scope this process currently
 * publishes. The mirror outlives a sign-out or an org switch, and the ask names
 * both the session and the organization an action would answer, so an ask
 * recorded for another scope must never reach a surface or an approval.
 *
 * Fails closed: a null local scope means no snapshot scope was restored (an
 * absent mirror, a failed read, or a process that has not published yet), so
 * this process cannot prove the ask belongs to the account it would answer for.
 * Accepting it there let a stale session/org record reach Open and Approve on
 * the strength of nothing. The live path is unaffected: `recordWaitingAsk`
 * stores the ask with the publisher's own context, and hydration — the one
 * boundary where the mirror enters the process — only fills a cold process that
 * has recorded nothing.
 */
function isAskInCurrentScope(ask: WaitingAsk): boolean {
  const localScopeKey = getLocalScopeKey();
  return localScopeKey !== null && ask.scopeKey === localScopeKey;
}

/**
 * Replace the one ask and mirror it to SecureStore. `null` clears both. The
 * mirror is fire-and-forget: the in-memory value is authoritative for the sinks
 * of this run, and a failed mirror is treated as absent after a restart. The
 * writes are serialized so a burst of records cannot land out of order, and a
 * failing native module must never break the publisher that calls this.
 */
export function recordWaitingAsk(ask: WaitingAsk | null): void {
  waitingAskEpoch += 1;
  currentAsk = ask;
  recordedInProcess = true;
  mirrorAsk(ask);
}

/** The hydrated in-memory ask; the sinks read this synchronously. */
export function getWaitingAsk(): WaitingAsk | null {
  return currentAsk;
}

let hydrationPromise: Promise<void> | null = null;

/**
 * One read of the mirror, epoch-guarded exactly like
 * `restorePersistedGlanceable`: a record that lands during the read owns the
 * state, and an already-set in-memory ask is never overwritten. A process that
 * has recorded anything itself is not hydrated either, because the mirror it
 * would read can still hold the value that record replaced — a cleared ask
 * whose delete is queued behind the write chain. Best effort — a failed or
 * malformed read leaves the in-memory state alone. A record from another scope
 * is dropped here, at the one boundary where the mirror enters the process.
 */
async function hydrateStoredAsk(): Promise<void> {
  const startEpoch = waitingAskEpoch;
  try {
    const raw = await getSecureStore().getItemAsync(WAITING_ASK_KEY);
    if (waitingAskEpoch !== startEpoch) {
      return;
    }
    if (raw !== null && currentAsk === null && !recordedInProcess) {
      const parsed = parseStoredAsk(raw);
      if (parsed !== null && isAskInCurrentScope(parsed)) {
        currentAsk = parsed;
      }
    }
  } catch {
    // A malformed mirror is treated as absent; the next record repopulates it.
  }
}

/**
 * Hydrate from SecureStore once and return the current ask. The headless
 * background paths (a push wake with no React context) call this; the sinks use
 * the synchronous `getWaitingAsk`.
 */
export async function readWaitingAsk(): Promise<WaitingAsk | null> {
  hydrationPromise ??= hydrateStoredAsk();
  await hydrationPromise;
  return currentAsk;
}

// ── Test-only helpers ──────────────────────────────────────────────────────

export function _setSecureStoreForTests(store: SecureStoreLike | null): void {
  secureStoreForTests = store;
}

/** Settle the mirror chain so a case can assert what landed on disk. */
export async function _flushWaitingAskMirrorForTests(): Promise<void> {
  await mirrorWrite;
}

export function _resetWaitingAskForTests(): void {
  currentAsk = null;
  waitingAskEpoch = 0;
  recordedInProcess = false;
  hydrationPromise = null;
  mirrorWrite = null;
  secureStoreForTests = null;
}
