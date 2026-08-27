import {
  type GlanceableAgentsSnapshot,
  glanceableAgentsSnapshotSchema,
} from '@kilocode/app-shared/glanceable-agents-snapshot';

import { type GlanceableSink } from './sink-registry';

/**
 * Durable mirror of the last glanceable snapshot and its scope key, for JS
 * restart fencing only. The snapshot holds generic status, counts, timestamps
 * and an opaque scope key — never titles, ids, or other raw content.
 *
 * iOS widgets read the snapshot through expo-widgets `updateSnapshot` /
 * `updateTimeline`; Android widgets read through `react-native-android-widget`
 * storage. This store exists so the background push handler can compare an
 * incoming scope key without React context.
 */

// SecureStore keys are defined here (not storage-keys.ts) so this module stays
// self-contained; nothing else owns these two keys.
const GLANCEABLE_SNAPSHOT_KEY = 'glanceable-snapshot';
const GLANCEABLE_SCOPE_KEY = 'glanceable-scope-key';

type SecureStoreLike = {
  setItemAsync: (key: string, value: string) => Promise<void>;
  getItemAsync: (key: string) => Promise<string | null>;
};

// Test-only override so pure suites do not load expo-secure-store
// (→ expo-modules-core → RN). Mirrors the deep-link-launch pattern.
let secureStoreForTests: SecureStoreLike | null = null;

function getSecureStore(): SecureStoreLike {
  if (secureStoreForTests) {
    return secureStoreForTests;
  }
  // eslint-disable-next-line typescript-eslint/no-require-imports, typescript-eslint/no-var-requires, unicorn/prefer-module -- lazy native load
  return require('expo-secure-store') as SecureStoreLike;
}

let lastSnapshot: GlanceableAgentsSnapshot | null = null;
let localScopeKey: string | null = null;

// Monotonic epoch bumped on every in-memory write. Restore captures it before
// its async read and only fills when it is unchanged, so a live publish during
// the read can never be clobbered by a stale persisted record.
let persistEpoch = 0;

export function getLastGlanceableSnapshot(): GlanceableAgentsSnapshot | null {
  return lastSnapshot;
}

export function getLocalScopeKey(): string | null {
  return localScopeKey;
}

/** In-memory write plus a fire-and-forget SecureStore mirror. */
function persistSnapshot(snapshot: GlanceableAgentsSnapshot): void {
  persistEpoch += 1;
  lastSnapshot = snapshot;
  localScopeKey = snapshot.scopeKey;
  void getSecureStore().setItemAsync(GLANCEABLE_SNAPSHOT_KEY, JSON.stringify(snapshot));
  void getSecureStore().setItemAsync(GLANCEABLE_SCOPE_KEY, snapshot.scopeKey);
}

/** Parse a stored record with the shared schema; a malformed record is absent. */
function parseStoredSnapshot(raw: string): GlanceableAgentsSnapshot | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = glanceableAgentsSnapshotSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Restore the in-memory state from SecureStore after a JS restart. Best
 * effort: a failed read keeps the null in-memory state. A live write during
 * the read owns the state, so the stale persisted record is skipped.
 */
export async function restorePersistedGlanceable(): Promise<void> {
  const startEpoch = persistEpoch;
  try {
    const [rawSnapshot, rawScope] = await Promise.all([
      getSecureStore().getItemAsync(GLANCEABLE_SNAPSHOT_KEY),
      getSecureStore().getItemAsync(GLANCEABLE_SCOPE_KEY),
    ]);
    // A live write landed during the read: it owns the state; skip the fill.
    if (persistEpoch !== startEpoch) {
      return;
    }
    if (rawSnapshot !== null) {
      const parsed = parseStoredSnapshot(rawSnapshot);
      if (parsed !== null) {
        lastSnapshot = parsed;
      }
    }
    if (rawScope !== null) {
      localScopeKey = rawScope;
    }
  } catch {
    // A malformed mirror is treated as absent; the publisher repopulates it.
  }
}

/** The persist sink owns no native surface, so endImmediate is a no-op. */
export const persistGlanceableSink: GlanceableSink = {
  publish(snapshot) {
    persistSnapshot(snapshot);
  },
  endImmediate() {
    // The widget snapshot stays for later reads; nothing to end.
  },
  startOrUpdate(snapshot) {
    persistSnapshot(snapshot);
  },
};

// ── Test-only helpers ──────────────────────────────────────────────────────

export function _setSecureStoreForTests(store: SecureStoreLike | null): void {
  secureStoreForTests = store;
}

export function _setLastGlanceableSnapshotForTests(
  snapshot: GlanceableAgentsSnapshot | null
): void {
  persistEpoch += 1;
  lastSnapshot = snapshot;
  localScopeKey = snapshot?.scopeKey ?? null;
}

export function _resetGlanceablePersistForTests(): void {
  persistEpoch = 0;
  lastSnapshot = null;
  localScopeKey = null;
  secureStoreForTests = null;
}
