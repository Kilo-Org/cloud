import { z } from 'zod';

import {
  type GatedSecureStore,
  readGatedValueForUpdate,
  widgetSecureStore,
  writeGatedValue,
} from '@/lib/auth/secure-store-gated';

import { SESSION_TOKEN_IDENTITY_KEY } from './widget-store';

/**
 * The tokens each followed session's server row was written with.
 *
 * A row's identity on the server is the account, the device token and the
 * session (`apps/web/src/routers/user-router.ts`). Expo can rotate the device
 * token between a follow and its unfollow, and a process that never learned the
 * token an upsert was accepted with would delete a token no row carries: the
 * delete reports success and the row outlives the follow. So the token an
 * upsert is sent with is recorded here, beside a memory mirror that answers
 * first: a same-process release needs no keychain read, and a fresh process — a
 * headless notification action — can still name the row it has to delete.
 *
 * A rotation adds to the list instead of replacing it, because the previous
 * token may be the one an earlier upsert landed with. The record is bounded and
 * holds session ids and opaque push tokens only, scoped by account, and is
 * cleared when the device leaves the scope.
 */

/** The account a token identity belongs to. */
export type SessionTokenScope = { readonly userId: string; readonly organizationId: string | null };

/**
 * Tokens one session's row was written with, newest kept last, and the version
 * that names this exact record: a retirement reads one and may drop only it.
 */
type SessionTokenIdentity = SessionTokenScope & {
  readonly version: number;
  readonly tokens: readonly string[];
};

const storedRecordSchema = z.object({
  version: z.literal(1),
  sessions: z.record(
    z.string().min(1),
    z.object({
      userId: z.string().min(1),
      organizationId: z.string().min(1).nullable(),
      /** Absent in a record written before versions, which reads as 0. */
      version: z.number().int().nonnegative().optional(),
      tokens: z.array(z.string().min(1)),
    })
  ),
});

/** The newest tokens a row of one session may have been written with. */
const MAX_TOKENS_PER_SESSION = 3;

/** The newest sessions kept; an older entry is dropped whole. */
const MAX_SESSIONS = 32;

/** What this process knows, authoritative over the store while it runs. */
const identities = new Map<string, SessionTokenIdentity>();

/** The highest version issued here or read from the store, so a restart cannot repeat one. */
let lastIssuedVersion = 0;

function nextVersion(): number {
  lastIssuedVersion += 1;
  return lastIssuedVersion;
}

// Test-only override so pure suites do not load expo-secure-store
// (→ expo-modules-core → RN), as `lib/glanceable/persist.ts` does.
let secureStoreForTests: GatedSecureStore | null = null;

function getSecureStore(): GatedSecureStore {
  return secureStoreForTests ?? widgetSecureStore();
}

/** The stored record, or null when it cannot be read now (a locked keychain). */
async function readStoredIdentities(): Promise<Map<string, SessionTokenIdentity> | null> {
  const stored = await readGatedValueForUpdate(getSecureStore, SESSION_TOKEN_IDENTITY_KEY);
  if (stored.status === 'unreadable') {
    return null;
  }
  if (stored.value === null) {
    return new Map();
  }
  try {
    const parsed = storedRecordSchema.safeParse(JSON.parse(stored.value));
    if (!parsed.success) {
      return new Map();
    }
    const records = new Map<string, SessionTokenIdentity>();
    for (const [sessionId, identity] of Object.entries(parsed.data.sessions)) {
      records.set(sessionId, {
        userId: identity.userId,
        organizationId: identity.organizationId,
        version: identity.version ?? 0,
        tokens: identity.tokens,
      });
    }
    return records;
  } catch {
    return new Map();
  }
}

/** True when a record belongs to the account a caller asked about; a null scope asks about any. */
function belongsTo(identity: SessionTokenIdentity, scope: SessionTokenScope | null): boolean {
  return (
    scope === null ||
    (identity.userId === scope.userId && identity.organizationId === scope.organizationId)
  );
}

/**
 * One session's record after a restart: what the previous process wrote first,
 * then what this one recorded, with the bound applied to the merged list. A
 * re-registration after a rotation must not replace the token an earlier upsert
 * landed with, or the old row can never be named again.
 */
function mergedIdentity(
  persisted: SessionTokenIdentity,
  current: SessionTokenIdentity
): SessionTokenIdentity {
  if (persisted.userId !== current.userId || persisted.organizationId !== current.organizationId) {
    // Another account's row is not this one's to delete.
    return current;
  }
  const tokens = [
    ...persisted.tokens.filter(token => !current.tokens.includes(token)),
    ...current.tokens,
  ];
  return { ...current, tokens: tokens.slice(-MAX_TOKENS_PER_SESSION) };
}

async function loadFromStore(): Promise<boolean> {
  const stored = await readStoredIdentities();
  if (stored === null) {
    return false;
  }
  for (const [sessionId, persisted] of stored) {
    lastIssuedVersion = Math.max(lastIssuedVersion, persisted.version);
    const current = identities.get(sessionId);
    identities.set(
      sessionId,
      current === undefined ? persisted : mergedIdentity(persisted, current)
    );
  }
  return true;
}

let hydration: Promise<boolean> | null = null;

/**
 * Load the store once before any write: a write persists the whole map, so it
 * may not run over sessions this process has not read. `false` when the store
 * cannot be read now, which leaves the write for a later call.
 */
function ensureHydrated(): Promise<boolean> {
  hydration ??= (async () => {
    const ready = await loadFromStore();
    if (!ready) {
      hydration = null;
    }
    return ready;
  })();
  return hydration;
}

async function persist(): Promise<void> {
  const sessions: Record<string, SessionTokenIdentity> = {};
  for (const [sessionId, identity] of identities) {
    sessions[sessionId] = identity;
  }
  await writeGatedValue(
    getSecureStore,
    SESSION_TOKEN_IDENTITY_KEY,
    JSON.stringify({ version: 1, sessions })
  );
}

/** Persist the map once this process has read it; a failed read leaves memory authoritative. */
function persistWhenHydrated(): void {
  void (async () => {
    if (await ensureHydrated()) {
      await persist();
    }
  })();
}

/** One session's tokens, newest last, bounded to what a row may have been written with. */
function nextIdentity(
  previous: SessionTokenIdentity | undefined,
  scope: SessionTokenScope,
  token: string
): SessionTokenIdentity {
  const kept = (previous?.tokens ?? []).filter(one => one !== token);
  return {
    userId: scope.userId,
    organizationId: scope.organizationId,
    version: nextVersion(),
    tokens: [...kept, token].slice(-MAX_TOKENS_PER_SESSION),
  };
}

/** Record the token an upsert for this session is about to write. Memory answers first; the store is mirrored. */
export function rememberSessionTokenIdentity(
  sessionId: string,
  scope: SessionTokenScope,
  token: string
): void {
  const previous = identities.get(sessionId);
  // The newest session goes last, so the bound drops the one written longest ago.
  identities.delete(sessionId);
  identities.set(sessionId, nextIdentity(previous, scope, token));
  while (identities.size > MAX_SESSIONS) {
    const oldest = identities.keys().next();
    if (oldest.done === true) {
      break;
    }
    identities.delete(oldest.value);
  }
  persistWhenHydrated();
}

/** One session's identity and the version that names it, or null when this account has none. */
export async function readSessionTokenIdentity(
  sessionId: string,
  scope: SessionTokenScope | null
): Promise<{ readonly version: number; readonly tokens: readonly string[] } | null> {
  await ensureHydrated();
  const identity = identities.get(sessionId);
  if (identity === undefined || !belongsTo(identity, scope)) {
    return null;
  }
  return { version: identity.version, tokens: identity.tokens };
}

/** Every token this session's row may exist under, for this account when one is known. Memory first, then the store. */
export async function readSessionTokenIdentities(
  sessionId: string,
  scope: SessionTokenScope | null
): Promise<readonly string[]> {
  const identity = await readSessionTokenIdentity(sessionId, scope);
  return identity?.tokens ?? [];
}

/** Every recorded identity of one account, so a scope teardown can delete the rows they name. */
export async function readSessionTokenIdentitiesForScope(
  scope: SessionTokenScope | null
): Promise<
  readonly {
    readonly sessionId: string;
    readonly version: number;
    readonly tokens: readonly string[];
  }[]
> {
  await ensureHydrated();
  const records: { sessionId: string; version: number; tokens: readonly string[] }[] = [];
  for (const [sessionId, identity] of identities) {
    if (belongsTo(identity, scope)) {
      records.push({ sessionId, version: identity.version, tokens: identity.tokens });
    }
  }
  return records;
}

/**
 * Drop one session's identity, when it is still the record the caller read. Its
 * row is gone, so nothing may name it again; a newer follow that recorded its
 * own identity meanwhile owns the session now and stays.
 */
export function forgetSessionTokenIdentity(sessionId: string, version?: number): void {
  const current = identities.get(sessionId);
  if (version !== undefined && current?.version !== version) {
    return;
  }
  identities.delete(sessionId);
  void (async () => {
    if (!(await ensureHydrated())) {
      return;
    }
    // Hydration may have merged the record back in: retire only the version this call read.
    if (version !== undefined && identities.get(sessionId)?.version !== version) {
      return;
    }
    identities.delete(sessionId);
    await persist();
  })();
}

/**
 * Retire the identities of one account whose rows the teardown deleted. A
 * token whose delete failed stays recorded, because it still names a row the
 * next cleanup has to remove.
 */
export function retireSessionTokenIdentities(
  scope: SessionTokenScope | null,
  failed: ReadonlySet<string>
): void {
  void (async () => {
    if (!(await ensureHydrated())) {
      return;
    }
    let changed = false;
    for (const [sessionId, identity] of Array.from(identities)) {
      if (belongsTo(identity, scope)) {
        const kept = identity.tokens.filter(token => failed.has(token));
        if (kept.length !== identity.tokens.length) {
          changed = true;
          if (kept.length === 0) {
            identities.delete(sessionId);
          } else {
            identities.set(sessionId, { ...identity, version: nextVersion(), tokens: kept });
          }
        }
      }
    }
    if (changed) {
      await persist();
    }
  })();
}

// ── Test-only helpers ──────────────────────────────────────────────────────

export function _setSessionTokenIdentityStoreForTests(store: GatedSecureStore | null): void {
  secureStoreForTests = store;
}

export function _resetSessionTokenIdentityForTests(): void {
  secureStoreForTests = null;
  identities.clear();
  hydration = null;
  lastIssuedVersion = 0;
}
