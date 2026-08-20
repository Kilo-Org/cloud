import * as Sentry from '@sentry/react-native';
import * as z from 'zod';

import { resolveIncomingUrl } from '@kilocode/app-shared/universal-links';

import { PENDING_DEEP_LINK_KEY } from './storage-keys';

type DeepLinkSource = 'universal-link' | 'notification';

type GetLinkingURL = () => string | null;

/** Minimal SecureStore surface used by the durable mirror. */
type SecureStoreLike = {
  setItemAsync: (key: string, value: string) => Promise<void>;
  deleteItemAsync: (key: string) => Promise<void>;
  getItemAsync: (key: string) => Promise<string | null>;
};

/** Persisted shape of the pending slot, mirroring the in-memory slot. */
type PendingDeepLinkRecord = {
  href: string;
  source: DeepLinkSource;
  storedAt: number;
  /** Signed-in user id at persist time, or null when captured while signed out. */
  userId: string | null;
};

/** A persisted record older than this is discarded on restore. */
const PENDING_DEEP_LINK_TTL_MS = 24 * 60 * 60 * 1000;

let pendingDeepLink: string | null = null;
let pendingSource: DeepLinkSource | null = null;
let launchLinkHandled = false;

// The signed-in user id at persist time, bound to each durable record so a
// destination captured for one account is never restored for another. The
// auth context sets it on sign-in (with the new user id) and on sign-out
// (with null). A null value means "captured while signed out", which still
// restores.
let currentDeepLinkUserId: string | null = null;

/** Sets the signed-in user id that `persistPendingDeepLink` records. */
export function setCurrentDeepLinkUserId(userId: string | null): void {
  currentDeepLinkUserId = userId;
}

// Monotonic epoch bumped on every set, consume, and clear. Restore captures it
// before its async read and only fills when it is unchanged, so a live capture
// or consume that happens during the read can never be overwritten or re-armed.
let pendingDeepLinkEpoch = 0;

// Observable slot: listeners are notified whenever the pending slot changes,
// so the layout can consume through useSyncExternalStore instead of waiting
// for an unrelated dependency change.
const pendingDeepLinkListeners = new Set<() => void>();

// Test-only override so captureLaunchDeepLink can stay synchronous without
// pulling expo-linking (→ RN) into suites that only touch the pending slot.
let getLinkingURLForTests: GetLinkingURL | null = null;

// Test-only override so the durable mirror can be exercised without loading
// expo-secure-store (→ expo-modules-core → RN) into unit-test graphs.
let secureStoreForTests: SecureStoreLike | null = null;

function notifyPendingDeepLinkListeners(): void {
  for (const listener of pendingDeepLinkListeners) {
    listener();
  }
}

// Lazy require so modules that only use the pending slot (e.g. notifications →
// unread-counts tests) do not load expo-secure-store (→ expo-modules-core → RN)
// at import time. Static `import` would pull RN into those unit-test graphs.
function getSecureStore(): SecureStoreLike {
  if (secureStoreForTests) {
    return secureStoreForTests;
  }
  // eslint-disable-next-line typescript-eslint/no-require-imports, typescript-eslint/no-var-requires, unicorn/prefer-module -- lazy native load; see comment above
  return require('expo-secure-store') as SecureStoreLike;
}

// Serializes every SecureStore write to PENDING_DEEP_LINK_KEY through one FIFO
// chain so a later delete (consume or sign-out) always lands after an earlier
// persist. Each write stays fire-and-forget from the caller's view, but chains
// onto the previous write so call order is preserved.
// eslint-disable-next-line prefer-await-to-then -- Promise.resolve() is the empty-chain sentinel; there is no async context to await in
let pendingDeepLinkWriteChain: Promise<void> = Promise.resolve();

function enqueuePendingDeepLinkWrite(write: () => Promise<void>): void {
  const previous = pendingDeepLinkWriteChain;
  pendingDeepLinkWriteChain = (async () => {
    try {
      await previous;
      await write();
    } catch (error) {
      Sentry.captureException(error);
    }
  })();
}

/** Fire-and-forget durable mirror. A failure is reported to Sentry; the
 *  in-memory slot still works for the live process. */
function persistPendingDeepLink(href: string, source: DeepLinkSource): void {
  const record: PendingDeepLinkRecord = {
    href,
    source,
    storedAt: Date.now(),
    userId: currentDeepLinkUserId,
  };
  enqueuePendingDeepLinkWrite(async () => {
    await getSecureStore().setItemAsync(PENDING_DEEP_LINK_KEY, JSON.stringify(record));
  });
}

/** Fire-and-forget delete of the durable mirror. */
function deletePersistedPendingDeepLink(): void {
  enqueuePendingDeepLinkWrite(async () => {
    await getSecureStore().deleteItemAsync(PENDING_DEEP_LINK_KEY);
  });
}

/**
 * Stash a deep-link href for the root layout to consume after gates clear.
 * Source is required so the type checker enforces precedence:
 * - `'universal-link'` always wins (overwrites anything).
 * - `'notification'` applies only when the slot is empty or already a notification.
 * Rationale: `getLastNotificationResponse()` can return a *stale* response on a
 * launch actually caused by a link, so the link is the better evidence of what
 * started this process.
 */
export function setPendingDeepLink(href: string, source: DeepLinkSource): void {
  if (source === 'universal-link') {
    pendingDeepLink = href;
    pendingSource = source;
  } else if (pendingDeepLink === null || pendingSource === 'notification') {
    // notification
    pendingDeepLink = href;
    pendingSource = source;
  } else {
    return;
  }
  pendingDeepLinkEpoch += 1;
  persistPendingDeepLink(href, source);
  notifyPendingDeepLinkListeners();
}

/** Get-and-clear. Single consumer is `_layout.tsx`. */
export function getPendingDeepLink(): string | null {
  const href = pendingDeepLink;
  pendingDeepLink = null;
  pendingSource = null;
  pendingDeepLinkEpoch += 1;
  deletePersistedPendingDeepLink();
  notifyPendingDeepLinkListeners();
  return href;
}

/**
 * Drop the pending destination in memory AND persist. Used by sign-out so a
 * different account signed in later in this process cannot navigate to the
 * previous account's destination. The in-memory clear is synchronous; the
 * persisted delete chains behind any in-flight persist on the write chain.
 */
export function clearPendingDeepLink(): void {
  pendingDeepLink = null;
  pendingSource = null;
  pendingDeepLinkEpoch += 1;
  deletePersistedPendingDeepLink();
  notifyPendingDeepLinkListeners();
}

/** Current pending href without clearing. For `useSyncExternalStore`. */
export function getPendingDeepLinkSnapshot(): string | null {
  return pendingDeepLink;
}

/** Subscribe to pending-slot changes. Returns an unsubscribe function. */
export function subscribeToPendingDeepLink(listener: () => void): () => void {
  pendingDeepLinkListeners.add(listener);
  return () => {
    pendingDeepLinkListeners.delete(listener);
  };
}

/**
 * Restore a destination persisted before process death. Reads the record,
 * discards it when older than 24 h or when it fails to parse, and otherwise
 * feeds it back through `setPendingDeepLink` (precedence rules unchanged).
 *
 * Fills ONLY an empty slot: a live capture (`checkInitialNotification`,
 * `captureLaunchDeepLink`) already ran at module scope and owns the slot, so a
 * stale persisted record must never overwrite a fresh live one, re-arm a
 * consumed slot, or wipe a live persist.
 */
export async function restorePersistedPendingDeepLink(): Promise<void> {
  // Capture the epoch before the async read. If any set, consume, or clear
  // happens during the read, the live state wins and restore must not fill.
  const startEpoch = pendingDeepLinkEpoch;
  const raw = await readPersistedPendingDeepLink();
  if (raw === null) {
    return;
  }

  // A live capture or consume happened during the read: leave the slot alone.
  if (pendingDeepLinkEpoch !== startEpoch) {
    return;
  }

  const record = parsePendingDeepLinkRecord(raw);

  // A live capture owns the slot: leave both the slot and the persisted record
  // alone. Deleting here would wipe the live persist still queued on the chain.
  if (getPendingDeepLinkSnapshot() !== null) {
    return;
  }

  if (record === null || Date.now() - record.storedAt > PENDING_DEEP_LINK_TTL_MS) {
    deletePersistedPendingDeepLink();
    return;
  }

  // A record captured for a different signed-in user must never navigate the
  // current account. A null record userId (captured while signed out) still
  // restores.
  if (record.userId !== null && record.userId !== currentDeepLinkUserId) {
    deletePersistedPendingDeepLink();
    return;
  }

  setPendingDeepLink(record.href, record.source);
}

async function readPersistedPendingDeepLink(): Promise<string | null> {
  try {
    return await getSecureStore().getItemAsync(PENDING_DEEP_LINK_KEY);
  } catch (error) {
    Sentry.captureException(error);
    return null;
  }
}

const pendingDeepLinkRecordSchema = z.object({
  href: z.string(),
  source: z.enum(['universal-link', 'notification']),
  storedAt: z.number(),
  userId: z.string().nullable(),
});

function parsePendingDeepLinkRecord(raw: string): PendingDeepLinkRecord | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = pendingDeepLinkRecordSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function readLaunchUrl(): string | null {
  if (getLinkingURLForTests) {
    return getLinkingURLForTests();
  }
  // Synchronous native read. Lazy require so modules that only use the pending
  // slot (e.g. notifications → unread-counts tests) do not load expo-linking at
  // import time. Static `import` would pull RN into those unit-test graphs.
  // eslint-disable-next-line typescript-eslint/no-require-imports, typescript-eslint/no-var-requires, unicorn/prefer-module -- sync launch capture; see comment above
  const linking = require('expo-linking') as { getLinkingURL: GetLinkingURL };
  return linking.getLinkingURL();
}

/**
 * SYNCHRONOUS capture of the OS launch URL into the pending slot.
 * Called at `_layout.tsx` module scope so the slot is populated before any effect.
 *
 * Why `getLinkingURL()` (not `getInitialURL()`): expo-router's Android cold path
 * races `Linking.getInitialURL()` against a 150ms timeout and substitutes the app
 * root URL on timeout, so the launch URL can vanish with no error. `getLinkingURL()`
 * is native-populated at activity `onCreate` and cannot be lost that way. No
 * `Platform.OS` check — it is the correct source on both platforms.
 *
 * Do NOT call `clearInitialURL()` — expo-router's own cold path reads the same value.
 */
export function captureLaunchDeepLink(): void {
  if (launchLinkHandled) {
    return;
  }
  const url = readLaunchUrl();
  if (!url) {
    return;
  }
  const href = resolveIncomingUrl(url);
  if (href) {
    setPendingDeepLink(href, 'universal-link');
    launchLinkHandled = true;
  }
}

/** Whether the synchronous launch capture already stashed this process's launch link. */
export function wasLaunchLinkHandled(): boolean {
  return launchLinkHandled;
}

/** Test-only: reset module-private latch, pending slot, and listeners between cases. */
export function _resetDeepLinkLaunchForTests(): void {
  pendingDeepLink = null;
  pendingSource = null;
  launchLinkHandled = false;
  getLinkingURLForTests = null;
  pendingDeepLinkListeners.clear();
  currentDeepLinkUserId = null;
  // eslint-disable-next-line prefer-await-to-then -- reset the chain to the empty sentinel
  pendingDeepLinkWriteChain = Promise.resolve();
}

/** Test-only: stub the synchronous launch-URL reader without loading expo-linking. */
export function _setGetLinkingURLForTests(fn: GetLinkingURL | null): void {
  getLinkingURLForTests = fn;
}

/** Test-only: stub the SecureStore surface without loading expo-secure-store. */
export function _setSecureStoreForTests(store: SecureStoreLike | null): void {
  secureStoreForTests = store;
}
