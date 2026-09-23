import * as Sentry from '@sentry/react-native';
import * as z from 'zod';

import {
  type IncomingResume,
  resolveIncomingResume,
  SESSION_RESUME_ANCHOR_PARAM,
} from '@kilocode/app-shared/universal-links';

import { PENDING_DEEP_LINK_KEY } from './storage-keys';
import { APP_SCHEME, isSystemSearchFamilyLink } from './system-search-families';

type DeepLinkSource = 'universal-link' | 'notification' | 'system-search';

type GetLinkingURL = () => string | null;

/** Per-capture flags the precedence and account rules read back. */
type PendingDeepLinkOptions = {
  /** Only the cold-launch capture sets this; see the module flag below. */
  fromLaunchAppScheme?: boolean;
  /**
   * The destination belongs to the session that produced it and must not open
   * for another account. Set for an app-scheme launch URL that names a family
   * the phone's own search indexes: on Android that URL is how a tap on an
   * indexed result is delivered.
   */
  sessionBound?: boolean;
  /**
   * The organization the destination belongs to, when its source knew one
   * (a notification tap for a session in an organization). `null` means the
   * destination carries no organization: Personal, or a source that has none.
   */
  organizationId?: string | null;
};

/** Minimal SecureStore surface used by the durable mirror. */
type SecureStoreLike = {
  setItemAsync: (key: string, value: string) => Promise<void>;
  deleteItemAsync: (key: string) => Promise<void>;
  getItemAsync: (key: string) => Promise<string | null>;
};

/**
 * Persisted shape of the pending slot, mirroring the in-memory slot. Derived
 * from `pendingDeepLinkRecordSchema` (declared with the parser below) so the
 * durable record and the shape read back can never drift.
 */
type PendingDeepLinkRecord = z.infer<typeof pendingDeepLinkRecordSchema>;

/** A persisted record older than this is discarded on restore. */
const PENDING_DEEP_LINK_TTL_MS = 24 * 60 * 60 * 1000;

let pendingDeepLink: string | null = null;
let pendingSource: DeepLinkSource | null = null;
let launchLinkHandled = false;

// True while the pending slot holds a universal link the cold-launch capture
// derived from an app-scheme (`kiloapp://`) launch URL. On Android a tap on one
// of the app's own search results IS such a URL, delivered as the launch
// Intent; the shared web table maps it lossily (it strips the query string), so
// the lossless `system-search` route for the same tap is allowed to replace it.
// An `https://` universal link is never flagged, so an ordinary link keeps its
// precedence over a stale search slot.
let pendingUniversalLinkFromLaunch = false;

// The signed-in user id at persist time, bound to each durable record so a
// destination captured for one account is never restored for another. The
// auth context sets it on sign-in (with the new user id) and on sign-out
// (with null). A null value means "captured while signed out", which still
// restores.
let currentDeepLinkUserId: string | null = null;

// Whether the CURRENT in-memory slot holds a session-bound destination: one
// that belongs to the session that produced it (a system-search result, or the
// app-scheme launch URL that delivers one on Android) and so must never open
// for another account. A destination captured before any account is known is
// dropped when the account settles signed out.
let pendingDeepLinkSessionBound = false;

// The signed-in user id the CURRENT in-memory slot was captured for, or null
// when it was captured while signed out. Mirrors the persisted record's
// `userId` field so a sign-out can drop only an account-bound destination
// (one that belongs to the account being signed out) while keeping a
// signed-out destination (which any later sign-in may still want).
let pendingDeepLinkUserId: string | null = null;

// The organization the CURRENT in-memory slot's destination belongs to, or
// null when it carries none. Mirrors the persisted record's `organizationId`
// field so a notification tap can switch the app to the session's
// organization before the destination navigates. The transport is the same as
// `pendingDeepLinkUserId`: it rides with the pending slot and never switches
// anything on its own.
let pendingDeepLinkOrganizationId: string | null = null;

// Whether an account identity is known yet. A cold launch captures a
// system-search tap at module scope, before auth restores, so `currentDeepLinkUserId`
// is still null there; a system-search destination captured in that window is
// held in `deferredSystemSearchHref` and bound (or dropped) once the account
// settles, never stored account-independent.
let deepLinkUserSettled = false;

// A system-search destination captured before the account settled. It is
// in-memory only: a system-search result belongs to the session that indexed
// it, so it is never persisted until an account identity binds it.
let deferredSystemSearchHref: string | null = null;

/** Sets the signed-in user id that `persistPendingDeepLink` records. */
export function setCurrentDeepLinkUserId(userId: string | null): void {
  currentDeepLinkUserId = userId;
  deepLinkUserSettled = true;
  // The account is now known: a system-search tap captured during bootstrap is
  // this account's to open, or it is dropped when the launch is signed out.
  const deferred = deferredSystemSearchHref;
  deferredSystemSearchHref = null;
  if (deferred !== null && userId !== null) {
    applyPendingDeepLink(deferred, 'system-search');
  }
  // A session-bound destination captured before the account settled (a cold
  // launch from the app-scheme URL a search tap uses) belongs to whoever was
  // signed in then. A signed-out settle means there was no such account, so
  // the destination must not open for whoever signs in later in this process.
  if (userId === null && pendingDeepLinkSessionBound) {
    clearPendingDeepLink();
  }
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
      Sentry.captureException(error, {
        tags: { 'error.subsystem': 'deep_link', 'error.operation': 'write_pending_link' },
      });
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
    sessionBound: pendingDeepLinkSessionBound,
    organizationId: pendingDeepLinkOrganizationId,
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
 * - `'system-search'` applies unless the slot holds a universal link: the user
 *   tapped a result, which is newer evidence than a pending notification. The
 *   one exception is a universal link the launch capture derived from an
 *   app-scheme URL (`fromLaunchAppScheme`), because that IS the Android search
 *   tap and the exact route is lossless where the web-table mapping is not.
 * - `'notification'` applies only when the slot is empty or already a notification.
 * Rationale: `getLastNotificationResponse()` can return a *stale* response on a
 * launch actually caused by a link, so the link is the better evidence of what
 * started this process.
 */
export function setPendingDeepLink(
  href: string,
  source: DeepLinkSource,
  options?: PendingDeepLinkOptions
): void {
  const sessionBound = source === 'system-search' || options?.sessionBound === true;
  if (sessionBound) {
    // A destination captured before the account is known. The native
    // system-search slot is single-shot, so its capture is held until the
    // settle binds or drops it. A session-bound launch capture is applied now
    // instead, because a link launch must keep a universal link's precedence
    // over that slot; the settle drops it when the launch is signed out.
    if (!deepLinkUserSettled && source === 'system-search') {
      deferredSystemSearchHref = href;
      return;
    }
    if (deepLinkUserSettled && currentDeepLinkUserId === null) {
      return;
    }
  }
  applyPendingDeepLink(href, source, options);
}

/** The precedence rules and the durable write, once the source is admitted. */
function applyPendingDeepLink(
  href: string,
  source: DeepLinkSource,
  options?: PendingDeepLinkOptions
): void {
  // A universal link always wins, except that the exact system-search route for
  // an app-scheme launch URL may replace the web table's lossy mapping of it —
  // and only when it names the same destination, so a stale search slot cannot
  // displace the unrelated link the launch actually opened. An https launch
  // link is never flagged, so it keeps its precedence over a stale slot.
  const supersedesLaunchAppSchemeLink =
    source === 'system-search' &&
    pendingSource === 'universal-link' &&
    pendingUniversalLinkFromLaunch &&
    pendingDeepLink !== null &&
    sameDestination(pendingDeepLink, href);
  if (
    source !== 'universal-link' &&
    pendingSource === 'universal-link' &&
    !supersedesLaunchAppSchemeLink
  ) {
    return;
  }
  // A notification applies only when the slot is empty or already a notification:
  // a system-search tap is newer evidence and must not be overwritten by a
  // stale notification response.
  if (source === 'notification' && pendingDeepLink !== null && pendingSource !== 'notification') {
    return;
  }
  pendingDeepLink = href;
  pendingSource = source;
  pendingDeepLinkUserId = currentDeepLinkUserId;
  pendingUniversalLinkFromLaunch = options?.fromLaunchAppScheme === true;
  pendingDeepLinkSessionBound = source === 'system-search' || options?.sessionBound === true;
  pendingDeepLinkOrganizationId = options?.organizationId ?? null;
  pendingDeepLinkEpoch += 1;
  persistPendingDeepLink(href, source);
  notifyPendingDeepLinkListeners();
}

/** The href without its query or fragment, so the lossy web-table mapping of an
 *  app-scheme launch link still matches the exact search route for the same
 *  tap while a different destination never does. */
function sameDestination(left: string, right: string): boolean {
  return withoutQuery(left) === withoutQuery(right);
}

function withoutQuery(href: string): string {
  const cut = href.search(/[?#]/);
  return cut === -1 ? href : href.slice(0, cut);
}

/** Get-and-clear. Single consumer is `_layout.tsx`. */
export function getPendingDeepLink(): string | null {
  return consumePendingDeepLink()?.href ?? null;
}

/**
 * Get-and-clear of the pending destination together with the organization it
 * belongs to. The single gated consumer in `_layout.tsx` reads both: the
 * organization switches the app before the href navigates, so the route's
 * first fetch runs in the session's context. `organizationId` is null when the
 * destination carries none (Personal, or a source that never had one).
 */
export function consumePendingDeepLink(): { href: string; organizationId: string | null } | null {
  const result =
    pendingDeepLink === null
      ? null
      : { href: pendingDeepLink, organizationId: pendingDeepLinkOrganizationId };
  clearPendingDeepLink();
  return result;
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
  pendingDeepLinkUserId = null;
  pendingUniversalLinkFromLaunch = false;
  pendingDeepLinkSessionBound = false;
  pendingDeepLinkOrganizationId = null;
  deferredSystemSearchHref = null;
  pendingDeepLinkEpoch += 1;
  deletePersistedPendingDeepLink();
  notifyPendingDeepLinkListeners();
}

/**
 * Sign-out drop: clear an account-bound destination (captured while a user was
 * signed in), any system-search destination, and any session-bound launch
 * capture (bound to the session that indexed it, so it must never survive into
 * another account). A universal link or notification captured while signed out
 * is account-independent — it is the link the user opened before signing in —
 * so a redundant sign-out must not drop it. The in-memory clear is synchronous;
 * the persisted delete chains behind any in-flight persist.
 */
export function clearAccountBoundPendingDeepLink(): void {
  deferredSystemSearchHref = null;
  if (
    pendingDeepLinkUserId !== null ||
    pendingSource === 'system-search' ||
    pendingDeepLinkSessionBound
  ) {
    clearPendingDeepLink();
  }
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
  // restores, except for a session-bound destination: that belongs to the
  // session that produced it, so a record without an account identity is never
  // trusted.
  if (record.userId !== null && record.userId !== currentDeepLinkUserId) {
    deletePersistedPendingDeepLink();
    return;
  }
  if (record.userId === null && (record.source === 'system-search' || record.sessionBound)) {
    deletePersistedPendingDeepLink();
    return;
  }

  const { href, source, sessionBound, organizationId } = record;
  setPendingDeepLink(href, source, { sessionBound, organizationId });
}

async function readPersistedPendingDeepLink(): Promise<string | null> {
  try {
    return await getSecureStore().getItemAsync(PENDING_DEEP_LINK_KEY);
  } catch (error) {
    Sentry.captureException(error, {
      tags: { 'error.subsystem': 'deep_link', 'error.operation': 'read_pending_link' },
    });
    return null;
  }
}

const pendingDeepLinkRecordSchema = z.object({
  href: z.string(),
  source: z.enum(['universal-link', 'notification', 'system-search']),
  storedAt: z.number(),
  // Signed-in user id at persist time, or null when captured while signed out.
  userId: z.string().nullable(),
  // Absent in a record written before the session binding existed: such a
  // record can only be an account-independent destination (a link or a
  // notification), which is what the default restores as.
  sessionBound: z.boolean().default(false),
  // Absent in a record written before the organization rode with the pending
  // slot: such a record restores as no organization, which leaves the
  // selection unchanged on the tap.
  organizationId: z.string().nullable().default(null),
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
 * App href with the `?at=` resume anchor appended. A link without an anchor
 * keeps its href byte-identical. The synchronous launch capture and
 * `redirectSystemPath` both stash through this one function, so a cold launch
 * and a warm open of the same resume link can never format the anchor
 * differently.
 */
export function resumeDeepLinkHref({ href, anchorMessageId }: IncomingResume): string {
  return anchorMessageId === null
    ? href
    : `${href}?${SESSION_RESUME_ANCHOR_PARAM}=${encodeURIComponent(anchorMessageId)}`;
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
 *
 * Uses `resolveIncomingResume` (not the bare `resolveIncomingUrl`) so the anchor
 * of a session resume link rides into the stash: on a cold launch this capture
 * owns the slot, and expo-router's later cold path must not restash. Capturing
 * the bare href here would open a resumed session at the bottom.
 */
export function captureLaunchDeepLink(): void {
  if (launchLinkHandled) {
    return;
  }
  const url = readLaunchUrl();
  if (!url) {
    return;
  }
  const resume = resolveIncomingResume(url);
  if (resume) {
    // An app-scheme launch URL is the shape the Android system-search tap
    // delivers; flag it so the exact `system-search` route for that tap may
    // replace this lossy web-table mapping. An `https://` link is never flagged.
    // An app-scheme URL that names a family the phone's search indexes is a
    // search result's identifier, so it is session-bound: it must not open for
    // the account that signs in after the one that indexed it.
    setPendingDeepLink(resumeDeepLinkHref(resume), 'universal-link', {
      fromLaunchAppScheme: url.startsWith(APP_SCHEME),
      sessionBound: isSystemSearchFamilyLink(url),
    });
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
  pendingDeepLinkUserId = null;
  pendingUniversalLinkFromLaunch = false;
  pendingDeepLinkSessionBound = false;
  pendingDeepLinkOrganizationId = null;
  launchLinkHandled = false;
  getLinkingURLForTests = null;
  pendingDeepLinkListeners.clear();
  currentDeepLinkUserId = null;
  deepLinkUserSettled = false;
  deferredSystemSearchHref = null;
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
