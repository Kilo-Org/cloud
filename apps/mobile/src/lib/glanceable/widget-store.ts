import {
  type GatedSecureStore,
  readGatedValueForUpdate,
  widgetSecureStore,
  writeGatedValue,
} from '@/lib/auth/secure-store-gated';

/**
 * The SecureStore items of the Home widget, the glanceable mirror and the
 * followed session cards, and the one-time upgrade to the class they are
 * written with.
 *
 * These items are not credentials: they carry counts, statuses, timestamps and
 * an opaque scope key. A push and a background task mirror and read them while
 * the phone is locked, so the widget store writes them
 * `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`, and an install that stored them under
 * the expo-secure-store default (`WHEN_UNLOCKED`) is upgraded by
 * `migrateWidgetStoreAccessibility` the first time the app runs unlocked.
 */

export const HOME_WIDGET_DATA_KEY = 'home-widget-data';
export const GLANCEABLE_SNAPSHOT_KEY = 'glanceable-snapshot';
/** The previous release wrote the scope key beside the snapshot; this is read only. */
export const GLANCEABLE_LEGACY_SCOPE_KEY = 'glanceable-scope-key';
export const SESSION_CARD_SCOPE_KEY = 'glanceable-session-card-scopes';

/** Every item the widget store owns, so the upgrade covers all of them. */
const WIDGET_STORE_KEYS = [
  HOME_WIDGET_DATA_KEY,
  GLANCEABLE_SNAPSHOT_KEY,
  GLANCEABLE_LEGACY_SCOPE_KEY,
  SESSION_CARD_SCOPE_KEY,
] as const;

// SecureStore cannot report the class an existing item was written with, so the
// upgrade records itself beside the items: absent, every item is rewritten with
// the widget class once; present, that rewrite already happened. A read that
// fails leaves it unwritten, so the upgrade runs at the next start rather than
// being skipped for good.
const ACCESSIBILITY_MARKER_KEY = 'widget-store-accessibility';
const ACCESSIBILITY_MARKER_VALUE = 'after-first-unlock';

/**
 * Rewrite one item through the widget store. `false` when the keychain refused
 * the read or the write, so the upgrade stops rather than recording a marker
 * over an item it never reached.
 */
async function upgradeWidgetItem(
  resolveStore: () => GatedSecureStore,
  key: string
): Promise<boolean> {
  const stored = await readGatedValueForUpdate(resolveStore, key);
  if (stored.status === 'unreadable') {
    return false;
  }
  return stored.value === null || (await writeGatedValue(resolveStore, key, stored.value));
}

/**
 * Rewrite every widget item with the class `widgetSecureStore` writes, once.
 *
 * An earlier release wrote these items `WHEN_UNLOCKED`, so a background push
 * could not read them on a locked phone. Each record is read and written back
 * through the widget store: an overwrite that carries the class upgrades the
 * item in place, and it also re-adds a record an older expo-secure-store wrote
 * under its legacy service, which the current read still accepts.
 *
 * A device that has not been unlocked since boot cannot read the items, so the
 * attempt returns without the marker and the next unlocked run finishes it. The
 * marker is written after every item, never before: a half-finished upgrade is
 * never recorded as done, and a rewrite that already landed is simply repeated.
 */
export async function migrateWidgetStoreAccessibility(
  resolveStore: () => GatedSecureStore = widgetSecureStore
): Promise<void> {
  const marker = await readGatedValueForUpdate(resolveStore, ACCESSIBILITY_MARKER_KEY);
  if (marker.status === 'unreadable' || marker.value === ACCESSIBILITY_MARKER_VALUE) {
    return;
  }
  for (const key of WIDGET_STORE_KEYS) {
    // eslint-disable-next-line no-await-in-loop -- one item at a time: a device that has not been unlocked since boot refuses every call, and the upgrade must stop after the first refusal instead of firing the rest of them
    if (!(await upgradeWidgetItem(resolveStore, key))) {
      return;
    }
  }
  await writeGatedValue(resolveStore, ACCESSIBILITY_MARKER_KEY, ACCESSIBILITY_MARKER_VALUE);
}
