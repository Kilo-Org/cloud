import { z } from 'zod';

import {
  type GatedSecureStore,
  readGatedValueForUpdate,
  widgetSecureStore,
  writeGatedValue,
} from '@/lib/auth/secure-store-gated';
import { SESSION_CARD_SCOPE_KEY } from '@/lib/glanceable/widget-store';

/**
 * The account and organization each followed session card belongs to
 * (`.specs/mobile-session-live-activity.md` "Follow scope").
 *
 * A card outlives the process that started it, and the server replaces its
 * whole ActivityKit content state on every push, so the card itself cannot keep
 * the scope it was followed under: the app keeps it here, keyed by the session
 * id the card carries. The launch/foreground restore reads these records and
 * re-registers a card only for the account and organization the keychain holds
 * now.
 *
 * A record written by an earlier build does not exist, so its card is out of
 * scope at the first restore after the update and is ended there. A store that
 * cannot be read — a device that has not been unlocked since boot, or a value
 * this build cannot parse — reads as unavailable, and its cards are left exactly
 * as they are: only a record the app can read may end a card. The record lives
 * in the widget store (`lib/glanceable/widget-store`), which is readable while
 * the phone is locked so a push can re-register a card without waking the app.
 */

const storedScopeSchema = z.object({
  userId: z.string().min(1),
  /** The organization, or null for the personal scope. */
  organizationId: z.string().min(1).nullable(),
});

const storedRecordSchema = storedScopeSchema.extend({
  /** The write that put the record there; a record from an earlier build reads as 0. */
  revision: z.number().int().nonnegative().optional(),
});

const storedScopesSchema = z.object({
  version: z.literal(1),
  cards: z.record(z.string().min(1), storedRecordSchema),
});

/** The account a card was followed under. */
export type SessionCardScope = z.infer<typeof storedScopeSchema>;

/** A stored record: the account, and the write that put it there. */
export type SessionCardRecord = SessionCardScope & { readonly revision: number };

/**
 * The highest revision this process issued, so a revision never repeats even
 * after the record it belonged to was pruned.
 */
let lastIssuedRevision = 0;

/**
 * A revision above every persisted record and every one issued here: unique
 * across restarts without a clock, so a restart or a clock correction cannot
 * repeat one.
 */
function nextRevision(scopes: Map<string, SessionCardRecord>): number {
  let highest = lastIssuedRevision;
  for (const record of scopes.values()) {
    highest = Math.max(highest, record.revision);
  }
  lastIssuedRevision = highest + 1;
  return lastIssuedRevision;
}

/**
 * True when a card's recorded scope is the given account and organization. A
 * card with no record has no scope, so it is never current.
 */
export function isSessionCardScopeCurrent(
  scope: SessionCardScope | undefined,
  ctx: SessionCardScope
): boolean {
  return (
    scope !== undefined &&
    scope.userId === ctx.userId &&
    scope.organizationId === ctx.organizationId
  );
}

// Test-only override so pure suites do not load expo-secure-store
// (→ expo-modules-core → RN), as `lib/glanceable/persist.ts` does.
let secureStoreForTests: GatedSecureStore | null = null;

function getSecureStore(): GatedSecureStore {
  return secureStoreForTests ?? widgetSecureStore();
}

// Every write is a read-modify-write of one key, so they run one at a time: a
// follow that lands while a restore prunes must not be dropped by the prune.
let writes: Promise<void> = Promise.resolve();

function enqueue(write: () => Promise<void>): void {
  const previous = writes;
  writes = (async (): Promise<void> => {
    await previous;
    try {
      await write();
    } catch {
      // A gated write reports and resolves instead of rejecting, so this only
      // keeps one unexpected rejection from poisoning the chain every later
      // write awaits. A lost write costs the record, never the follow: the card
      // stays, and the next follow or restore writes again.
    }
  })();
}

/**
 * The scope recorded for each followed session, or null when the records
 * cannot be read now. A null answer leaves the cards as they are.
 */
export async function readSessionCardScopes(): Promise<Map<string, SessionCardRecord> | null> {
  const stored = await readGatedValueForUpdate(getSecureStore, SESSION_CARD_SCOPE_KEY);
  // A locked device reads as unconfirmed, not as empty: an empty map here would
  // make every followed card out of scope and end it.
  if (stored.status === 'unreadable') {
    return null;
  }
  if (stored.value === null) {
    return new Map();
  }
  try {
    const parsed = storedScopesSchema.safeParse(JSON.parse(stored.value));
    if (!parsed.success) {
      return null;
    }
    const records = new Map<string, SessionCardRecord>();
    for (const [sessionId, record] of Object.entries(parsed.data.cards)) {
      records.set(sessionId, {
        userId: record.userId,
        organizationId: record.organizationId,
        revision: record.revision ?? 0,
      });
    }
    return records;
  } catch {
    return null;
  }
}

async function writeStored(scopes: Map<string, SessionCardRecord>): Promise<void> {
  const cards: Record<string, SessionCardRecord> = {};
  for (const [sessionId, scope] of scopes) {
    cards[sessionId] = scope;
  }
  await writeGatedValue(
    getSecureStore,
    SESSION_CARD_SCOPE_KEY,
    JSON.stringify({ version: 1, cards })
  );
}

/** Record the scope one session was followed under. */
export function rememberSessionCardScope(sessionId: string, scope: SessionCardScope): void {
  enqueue(async () => {
    const scopes = await readSessionCardScopes();
    if (scopes === null) {
      return;
    }
    /* The revision is issued here, inside the serialized read-modify-write, so
       a re-follow of a session under the same account is a different write. */
    scopes.set(sessionId, {
      userId: scope.userId,
      organizationId: scope.organizationId,
      revision: nextRevision(scopes),
    });
    await writeStored(scopes);
  });
}

/** Forget the records of the cards that ended. */
export function forgetSessionCardScopes(sessionIds: readonly string[]): void {
  if (sessionIds.length === 0) {
    return;
  }
  enqueue(async () => {
    const scopes = await readSessionCardScopes();
    if (scopes === null) {
      return;
    }
    let changed = false;
    for (const sessionId of sessionIds) {
      changed = scopes.delete(sessionId) || changed;
    }
    if (changed) {
      await writeStored(scopes);
    }
  });
}

/** Forget every record: a teardown ended every card. */
export function clearSessionCardScopes(): void {
  enqueue(async () => {
    const scopes = await readSessionCardScopes();
    if (scopes === null || scopes.size === 0) {
      return;
    }
    await writeStored(new Map());
  });
}

/**
 * Keep only the records of the cards still followed, dropping the record of a
 * card the restore read but did not keep. `snapshot` is what that read saw: a
 * record written after it — a follow, even a re-follow of the same session
 * under the same account — carries a newer revision and stays.
 */
export function pruneSessionCardScopes(
  kept: readonly string[],
  snapshot: Map<string, SessionCardRecord>
): void {
  const keep = new Set(kept);
  enqueue(async () => {
    const scopes = await readSessionCardScopes();
    if (scopes === null) {
      return;
    }
    let changed = false;
    for (const [sessionId, scope] of scopes) {
      const seen = snapshot.get(sessionId);
      /* A record rewritten after the snapshot (a re-follow, even of the same
         account) is newer than the decision and stays. */
      if (!keep.has(sessionId) && seen !== undefined && seen.revision === scope.revision) {
        scopes.delete(sessionId);
        changed = true;
      }
    }
    if (changed) {
      await writeStored(scopes);
    }
  });
}

// ── Test-only helpers ──────────────────────────────────────────────────────

export function _setSessionCardScopeStoreForTests(store: GatedSecureStore | null): void {
  secureStoreForTests = store;
}

export function _resetSessionCardScopeStoreForTests(): void {
  secureStoreForTests = null;
  writes = Promise.resolve();
  lastIssuedRevision = 0;
}

/** Resolve once every queued write has landed. */
export function _settleSessionCardScopeWritesForTests(): Promise<void> {
  return writes;
}
