import { resolveIncomingUrl } from '@kilocode/app-shared/universal-links';

type DeepLinkSource = 'universal-link' | 'notification';

type GetLinkingURL = () => string | null;

let pendingDeepLink: string | null = null;
let pendingSource: DeepLinkSource | null = null;
let launchLinkHandled = false;

// Test-only override so captureLaunchDeepLink can stay synchronous without
// pulling expo-linking (→ RN) into suites that only touch the pending slot.
let getLinkingURLForTests: GetLinkingURL | null = null;

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
    return;
  }
  // notification
  if (pendingDeepLink === null || pendingSource === 'notification') {
    pendingDeepLink = href;
    pendingSource = source;
  }
}

/** Get-and-clear. Single consumer is `_layout.tsx`. */
export function getPendingDeepLink(): string | null {
  const href = pendingDeepLink;
  pendingDeepLink = null;
  pendingSource = null;
  return href;
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

/** Test-only: reset module-private latch and pending slot between cases. */
export function _resetDeepLinkLaunchForTests(): void {
  pendingDeepLink = null;
  pendingSource = null;
  launchLinkHandled = false;
  getLinkingURLForTests = null;
}

/** Test-only: stub the synchronous launch-URL reader without loading expo-linking. */
export function _setGetLinkingURLForTests(fn: GetLinkingURL | null): void {
  getLinkingURLForTests = fn;
}
