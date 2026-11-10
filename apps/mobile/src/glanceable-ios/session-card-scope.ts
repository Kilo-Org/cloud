import { z } from 'zod';

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
 * cannot be read — a locked keychain, or a value this build cannot parse —
 * reads as unavailable, and its cards are left exactly as they are: only a
 * record the app can read may end a card.
 */

const STORE_KEY = 'glanceable-session-card-scopes';

const storedScopeSchema = z.object({
  userId: z.string().min(1),
  /** The organization, or null for the personal scope. */
  organizationId: z.string().min(1).nullable(),
});

const storedScopesSchema = z.object({
  version: z.literal(1),
  cards: z.record(z.string().min(1), storedScopeSchema),
});

export type SessionCardScope = z.infer<typeof storedScopeSchema>;

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

export type SessionCardScopeStore = {
  setItemAsync: (key: string, value: string) => Promise<void>;
  getItemAsync: (key: string) => Promise<string | null>;
};

// Test-only override so pure suites do not load expo-secure-store
// (→ expo-modules-core → RN), as `lib/glanceable/persist.ts` does.
let secureStoreForTests: SessionCardScopeStore | null = null;

function getSecureStore(): SessionCardScopeStore {
  if (secureStoreForTests !== null) {
    return secureStoreForTests;
  }
  // eslint-disable-next-line typescript-eslint/no-require-imports, typescript-eslint/no-var-requires, unicorn/prefer-module -- lazy native load
  return require('expo-secure-store') as SessionCardScopeStore;
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
      // A failed write costs the record, never the follow: the card stays, and
      // the next follow or restore writes again.
    }
  })();
}

/**
 * The scope recorded for each followed session, or null when the records
 * cannot be read now. A null answer leaves the cards as they are.
 */
export async function readSessionCardScopes(): Promise<Map<string, SessionCardScope> | null> {
  try {
    const raw = await getSecureStore().getItemAsync(STORE_KEY);
    if (raw === null) {
      return new Map();
    }
    const parsed = storedScopesSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return null;
    }
    return new Map(Object.entries(parsed.data.cards));
  } catch {
    return null;
  }
}

async function writeStored(scopes: Map<string, SessionCardScope>): Promise<void> {
  const cards: Record<string, SessionCardScope> = {};
  for (const [sessionId, scope] of scopes) {
    cards[sessionId] = scope;
  }
  await getSecureStore().setItemAsync(STORE_KEY, JSON.stringify({ version: 1, cards }));
}

/** Record the scope one session was followed under. */
export function rememberSessionCardScope(sessionId: string, scope: SessionCardScope): void {
  enqueue(async () => {
    const scopes = await readSessionCardScopes();
    if (scopes === null) {
      return;
    }
    scopes.set(sessionId, { userId: scope.userId, organizationId: scope.organizationId });
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
 * record written after it (a follow that landed meanwhile) is newer than the
 * decision and stays.
 */
export function pruneSessionCardScopes(
  kept: readonly string[],
  snapshot: Map<string, SessionCardScope>
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
      const unchanged =
        seen !== undefined &&
        seen.userId === scope.userId &&
        seen.organizationId === scope.organizationId;
      if (!keep.has(sessionId) && unchanged) {
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

export function _setSessionCardScopeStoreForTests(store: SessionCardScopeStore | null): void {
  secureStoreForTests = store;
}

export function _resetSessionCardScopeStoreForTests(): void {
  secureStoreForTests = null;
  writes = Promise.resolve();
}

/** Resolve once every queued write has landed. */
export function _settleSessionCardScopeWritesForTests(): Promise<void> {
  return writes;
}
