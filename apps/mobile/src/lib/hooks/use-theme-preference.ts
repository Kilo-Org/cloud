import { useSyncExternalStore } from 'react';
import { Appearance } from 'react-native';
import { colorScheme } from 'react-native-css';

import { createSecureStorePreference } from '@/lib/hooks/secure-store-preference';
import { THEME_PREFERENCE_KEY } from '@/lib/storage-keys';

export type ThemePreference = 'system' | 'light' | 'dark';

/** What the device reports, including the no-preference sentinels. */
export type DeviceColorScheme = ReturnType<typeof Appearance.getColorScheme>;

/** A scheme we can paint: 'system' has already been resolved against the device. */
export type ResolvedColorScheme = 'light' | 'dark';

const store = createSecureStorePreference<ThemePreference>({
  key: THEME_PREFERENCE_KEY,
  defaultValue: 'system',
  parse: raw => {
    if (raw === 'light' || raw === 'dark' || raw === 'system') {
      return raw;
    }
    return 'system';
  },
  serialize: value => value,
});

// The app-level override currently set on the native Appearance module, or null
// for 'system' (no override). Tracked so re-applying 'system' at startup does
// not re-send the no-op 'unspecified' override, which on iOS rewrites the JS
// scheme cache from a possibly-stale native read.
let appliedScheme: ResolvedColorScheme | null = null;

// Cancels the in-flight forced republish of the device scheme, if any.
let cancelRepublish: (() => void) | null = null;

/**
 * Paints react-native-css from the current Appearance scheme. Call only once
 * the scheme has settled: either from a change event, which React Native emits
 * after it has refreshed the JS cache, or from the bounded fallback when the
 * cache already matched the device. An explicit preference owns the paint and
 * cancels the republish, so the store is the guard that this still applies to
 * System.
 */
function paintSettledDeviceScheme(): void {
  if (store.get() !== 'system') {
    return;
  }
  const resolved = resolveColorScheme('system', Appearance.getColorScheme());
  if (resolved !== null) {
    colorScheme.set(resolved);
  }
}

/**
 * React Native caches the device scheme when the Appearance module first loads
 * and only refreshes that cache from the native `appearanceChanged` handler,
 * which runs after the window's trait changes. After a fast refresh or a
 * relaunch that reuses the native module, the cache can still hold the scheme
 * from before the device turned dark. With no override set, clearing to
 * 'unspecified' changes no trait, so no event arrives and both
 * `useColorScheme()` and react-native-css keep painting the stale light for
 * System.
 *
 * Re-asserting the cached scheme moves the window trait away from the device,
 * and clearing it again makes the trait change back, which makes the native
 * module publish the real device scheme asynchronously. That event refreshes
 * the JS cache before notifying listeners, so painting from the change event is
 * the settled device scheme. When the cache already matched the device, the
 * clear changes no trait and no event arrives, so a bounded fallback paints the
 * cached read, which then is the device scheme.
 *
 * The immediate post-clear read is never painted: on iOS it is still the stale
 * `_currentColorScheme`, because the native module only republishes on the
 * async trait change (RCTAppearance.mm appearanceChanged:).
 */
function republishDeviceScheme(): void {
  cancelRepublish?.();

  const cached = Appearance.getColorScheme();

  let subscription: { remove: () => void } | null = null;
  let clearTimer: ReturnType<typeof setTimeout> | null = null;
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;

  function finish(): void {
    if (settled) {
      return;
    }
    settled = true;
    subscription?.remove();
    subscription = null;
    if (clearTimer !== null) {
      clearTimeout(clearTimer);
      clearTimer = null;
    }
    if (fallbackTimer !== null) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
    if (cancelRepublish === finish) {
      cancelRepublish = null;
    }
  }

  function paint(): void {
    finish();
    paintSettledDeviceScheme();
  }

  // The change event fires after React Native has refreshed the JS cache
  // (Appearance.js updates `state.appearance` before emitting). An event that
  // still reports the cached scheme is the re-assert republishing it, not the
  // device scheme the clear delivers; keep waiting for the latter.
  function paintFromDeviceEvent(): void {
    if (Appearance.getColorScheme() === cached) {
      return;
    }
    paint();
  }

  subscription = Appearance.addChangeListener(paintFromDeviceEvent);

  if (cached !== 'light' && cached !== 'dark') {
    // No cached scheme to re-assert: clear any override and let the device
    // event paint. The bounded fallback only stops waiting; an unresolved
    // scheme paints nothing.
    Appearance.setColorScheme('unspecified');
    fallbackTimer = setTimeout(finish, 250);
    cancelRepublish = finish;
    return;
  }

  Appearance.setColorScheme(cached);
  // Let the re-asserted trait apply before clearing, or UIKit coalesces the two
  // override changes and no trait change is seen, so the device event never
  // fires.
  clearTimer = setTimeout(() => {
    Appearance.setColorScheme('unspecified');
    // If the cache already matched the device, the clear changes no trait and
    // no event arrives; the bounded fallback then paints the (correct) read.
    fallbackTimer = setTimeout(paint, 250);
  }, 250);

  cancelRepublish = finish;
}

export function colorSchemeForPreference(pref: ThemePreference): 'light' | 'dark' | null {
  if (pref === 'system') {
    return null;
  }
  return pref;
}

/**
 * Resolves the scheme to paint. 'system' follows the device; a device that
 * reports no preference is treated as light. Returns null while the device
 * scheme is unknown so the caller can leave the current paint untouched instead
 * of flashing light.
 */
export function resolveColorScheme(
  pref: ThemePreference,
  systemScheme: DeviceColorScheme
): ResolvedColorScheme | null {
  const explicit = colorSchemeForPreference(pref);
  if (explicit !== null) {
    return explicit;
  }
  if (systemScheme === 'light' || systemScheme === 'dark') {
    return systemScheme;
  }
  return null;
}

export function applyThemePreference(pref: ThemePreference): void {
  // Set or clear the app-level override so the native windows follow the
  // choice. 'unspecified' hands control back to the device for 'system'; skip
  // it when no override is set so startup never rewrites the scheme cache.
  const explicit = colorSchemeForPreference(pref);
  if (explicit === null) {
    if (appliedScheme !== null) {
      Appearance.setColorScheme('unspecified');
      appliedScheme = null;
    }

    // System paints from the device scheme the republish delivers once the
    // trait settles. The pre-settle read can still hold the stale cache, so
    // never paint it here.
    republishDeviceScheme();
    return;
  }

  cancelRepublish?.();
  cancelRepublish = null;
  Appearance.setColorScheme(explicit);
  appliedScheme = explicit;
  colorScheme.set(explicit);
}

export function setThemePreference(pref: ThemePreference): void {
  store.set(pref);
  // Apply synchronously so a same-render useColorScheme() read sees the new
  // value without waiting for the async disk persist to settle.
  applyThemePreference(pref);
}

/** Start the theme-preference disk read at module scope, before React mounts. */
export function preloadThemePreference(): void {
  store.preload();
}

export function useThemePreference() {
  const preference = useSyncExternalStore(store.subscribe, store.get);
  const hasLoaded = useSyncExternalStore(store.subscribe, store.getHasLoaded);
  return { preference, hasLoaded };
}
