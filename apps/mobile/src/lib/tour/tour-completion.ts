import * as SecureStore from 'expo-secure-store';
import { useCallback, useSyncExternalStore } from 'react';

import { setAccountMetadata } from '@/lib/auth/account-metadata-write';
import { encodeStorageKey, TOUR_COMPLETED_KEY_PREFIX } from '@/lib/storage-keys';

/**
 * Per-account first-sign-in tour decision.
 *
 * The decision is one SecureStore record per user (`tour-completed-<hex>`), so
 * finishing or skipping the tour is remembered for that account and survives
 * sign-out and sign-in — exactly like the voice-network consent prefix. There
 * is deliberately no clear: replaying the tour from Profile is an explicit
 * action, never a re-arm, so nothing resets the decision.
 *
 * The module-level cache keyed by user id feeds `useTourCompletion` through
 * `useSyncExternalStore`. `recordCompleted` flips the in-memory value
 * synchronously the instant it is called (no debounce, no timing grace) and
 * persists in the background; callers never await it.
 */

export function tourCompletedKey(userId: string): string {
  return encodeStorageKey(TOUR_COMPLETED_KEY_PREFIX, userId);
}

/**
 * Reads the stored decision. A read failure (a keychain/keystore rejection) is
 * treated as not-completed and never throws: a fresh or unreadable record must
 * not block the tour.
 */
export async function readTourCompleted(userId: string): Promise<boolean> {
  try {
    const raw = await SecureStore.getItemAsync(tourCompletedKey(userId));
    return raw === '1';
  } catch {
    return false;
  }
}

/** Persists the decision through the epoch-fenced account-metadata write. */
export async function recordTourCompleted(userId: string): Promise<void> {
  await setAccountMetadata(tourCompletedKey(userId), '1');
}

type TourCompletionSnapshot = { isLoaded: boolean; isCompleted: boolean };

type TourCompletionEntry = {
  isLoaded: boolean;
  isCompleted: boolean;
  /** The disk read for this user has been started (once per module load). */
  started: boolean;
  /** Cached so `getSnapshot` is referentially stable for `useSyncExternalStore`. */
  snapshot: TourCompletionSnapshot;
};

const NOT_SIGNED_IN_SNAPSHOT: TourCompletionSnapshot = { isLoaded: false, isCompleted: false };

const entries = new Map<string, TourCompletionEntry>();
const listeners = new Set<() => void>();

function getEntry(userId: string): TourCompletionEntry {
  let entry = entries.get(userId);
  if (!entry) {
    entry = {
      isLoaded: false,
      isCompleted: false,
      started: false,
      snapshot: { isLoaded: false, isCompleted: false },
    };
    entries.set(userId, entry);
  }
  return entry;
}

function getSnapshotFor(userId: string | undefined): TourCompletionSnapshot {
  if (userId === undefined) {
    return NOT_SIGNED_IN_SNAPSHOT;
  }
  const entry = getEntry(userId);
  if (
    entry.snapshot.isLoaded !== entry.isLoaded ||
    entry.snapshot.isCompleted !== entry.isCompleted
  ) {
    entry.snapshot = { isLoaded: entry.isLoaded, isCompleted: entry.isCompleted };
  }
  return entry.snapshot;
}

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

async function loadEntry(userId: string, entry: TourCompletionEntry): Promise<void> {
  const completed = await readTourCompleted(userId);
  // A recordCompleted() that landed while the read was in flight wins: the
  // in-memory decision is authoritative once it exists.
  if (!entry.isCompleted) {
    entry.isCompleted = completed;
  }
  entry.isLoaded = true;
  emit();
}

function startLoad(userId: string): void {
  const entry = getEntry(userId);
  if (entry.started) {
    return;
  }
  entry.started = true;
  void loadEntry(userId, entry);
}

/**
 * Sets the decision in memory synchronously, then persists it in the
 * background. Never awaited, and never clears an existing decision.
 */
function recordCompletedInMemory(userId: string): void {
  const entry = getEntry(userId);
  entry.isCompleted = true;
  entry.isLoaded = true;
  emit();
  void recordTourCompleted(userId);
}

export function useTourCompletion(userId: string | undefined) {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (userId !== undefined) {
        startLoad(userId);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    [userId]
  );
  const getSnapshot = useCallback(() => getSnapshotFor(userId), [userId]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  const record = useCallback(() => {
    if (userId !== undefined) {
      recordCompletedInMemory(userId);
    }
  }, [userId]);
  return { isLoaded: snapshot.isLoaded, isCompleted: snapshot.isCompleted, recordCompleted: record };
}
