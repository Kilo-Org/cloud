import { type Href } from 'expo-router';

/**
 * Guard window for one navigation. Two presses on the same destination inside
 * this window belong to the same burst, and the second would push the route
 * again, so the reader would need two Back presses to return. The window can be
 * generous because the guard also clears when the screen regains focus, so a
 * press right after a return is never dropped.
 */
export const SINGLE_PUSH_GUARD_MS = 1000;

/** Mutable guard state. Each screen keeps one instance in a ref. */
export type SinglePushGuardState = {
  /** `Date.now()` of the last accepted push. `0` means no push yet. */
  lastPushAt: number;
  /** Destination key of the last accepted push. Empty until the first push. */
  lastKey: string;
};

/**
 * Identify a destination so two presses that would stack the same screen share
 * a key. Pushes to different destinations never block each other: a screen with
 * several rows or header actions needs every one of them to stay responsive.
 *
 * `Href` is a route string or a pathname object, and both encode to a distinct
 * JSON text, so one serialization covers the two shapes.
 */
export function hrefKey(href: Href): string {
  return JSON.stringify(href);
}

/**
 * Claim the single-push window for `key`: `true` when the caller may push,
 * `false` when this call repeats the previous destination inside the window.
 * Writes the accepted destination before returning, so a re-entrant call cannot
 * claim the same window twice.
 */
export function claimSinglePush(state: SinglePushGuardState, now: number, key: string): boolean {
  if (state.lastKey === key && now - state.lastPushAt < SINGLE_PUSH_GUARD_MS) {
    return false;
  }
  state.lastKey = key;
  state.lastPushAt = now;
  return true;
}
