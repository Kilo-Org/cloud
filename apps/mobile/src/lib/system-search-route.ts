/**
 * Bridges a tap on one of the app's own results in the phone's search
 * (Spotlight on iOS, app search on Android) to the pending deep-link slot.
 *
 * The native module keeps the tapped result's identifier in a single-shot
 * slot; this file resolves that identifier to an in-app route and stashes it
 * for the root layout's existing consumer (`_layout.tsx` → `pending-navigation`).
 * A warm tap wakes the app through `onSystemSearchOpen`; a cold tap has its
 * launch Intent read by that same native consume before JS boots, which is why
 * the launch capture runs at `_layout.tsx` module scope.
 */

import { captureTelemetry } from '@/lib/telemetry/error-sink';

import { setPendingDeepLink } from './deep-link-launch';
import {
  addSystemSearchOpenListener,
  consumePendingSystemSearchRoute,
} from './native-system-search';
import { systemSearchHrefFromRoute } from './system-search-entries';

/**
 * Resolve one identifier the OS handed back and stash the route it names.
 *
 * Both forms a platform returns arrive here: the bare in-app id iOS writes
 * from the Spotlight item's `uniqueIdentifier`, and the `kiloapp://` link the
 * Android module stores and hands back.
 *
 * A null or unrecognised identifier returns silently: the result was not for a
 * screen this app issued (a stale index, a hand-made link), so it must never
 * navigate, and it must never throw.
 */
export function routeSystemSearchOpen(routeId: string | null): void {
  if (routeId === null) {
    return;
  }
  const href = systemSearchHrefFromRoute(routeId);
  if (href === null) {
    return;
  }
  setPendingDeepLink(href, 'system-search');
}

/**
 * One report per failed slot read, tagged so the subsystem is filterable. The
 * native read is a get-and-clear, so a rejection means the tap is gone and the
 * report is its only trace. Never log the identifier.
 */
function reportSystemSearchRouteFailure(error: unknown): void {
  captureTelemetry({
    error,
    level: 'warning',
    tags: { 'error.subsystem': 'system-search', 'error.operation': 'consume-route' },
  });
}

/**
 * Reads the single-shot slot and stashes the route it resolves to.
 *
 * The native read is asynchronous — the module resolves the identifier on its
 * own queue, so a blocking index scan never runs on the JavaScript thread — so
 * the route lands a turn later. The root layout consumes the pending slot
 * reactively, so a later fill still navigates.
 *
 * The inner handler owns the rejection, so a failed read can never surface as
 * an unhandled rejection and is reported instead of dropped silently.
 */
function consumeAndRoute(): void {
  void (async () => {
    try {
      routeSystemSearchOpen(await consumePendingSystemSearchRoute());
    } catch (error) {
      reportSystemSearchRouteFailure(error);
    }
  })();
}

/**
 * SINGLE-SHOT capture of a search tap that launched this process. Called at
 * `_layout.tsx` module scope: the native subscriber has already run by the time
 * JS boots, so the slot's identifier is waiting to be read.
 */
export function captureSystemSearchLaunch(): void {
  consumeAndRoute();
}

/**
 * Read the single-shot slot once more now that the app tree is mounted.
 *
 * The module-scope capture can land before Android's activity exists:
 * `takeLaunchIdentifier()` returns null in that window without consuming the
 * launch Intent, deliberately keeping it for a later read rather than
 * forfeiting the tap for the process's life. Nothing else consumed the slot
 * again on a cold launch, so this retry is that later read; when the launch
 * capture already took the tap the read finds an empty slot and is a no-op.
 */
export function consumeSystemSearchRouteOnce(): void {
  consumeAndRoute();
}

/**
 * Subscribe to the native `onSystemSearchOpen` wake-up. The event is only a
 * signal: the handler re-reads the native slot, so a warm tap cannot route
 * twice (the read is a get-and-clear) and a payload cannot be lost (the slot,
 * not the event, carries it).
 *
 * Returns a no-op subscription when the native module is absent.
 */
export function registerSystemSearchOpenListener(): { remove(): void } {
  const subscription = addSystemSearchOpenListener(consumeAndRoute);
  return subscription ?? { remove: () => undefined };
}
