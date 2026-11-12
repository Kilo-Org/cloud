import {
  ensureWidgetStoreProbe,
  type GatedSecureStore,
  LOCK_READABLE_METADATA_KEYS,
  readGatedValueForUpdate,
  upgradeGatedValue,
  widgetSecureStore,
  writeGatedValue,
} from '@/lib/auth/secure-store-gated';

/**
 * The SecureStore items of the Home widget, the glanceable mirror, the followed
 * session cards, and the two identity hints the glanceable fences compare.
 *
 * None of them is a credential: they carry counts, statuses, timestamps, an
 * opaque scope key and two account ids. A push and a background task mirror,
 * read and fence them while the phone is locked, so the widget store writes them
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
  // The two identity hints are written by `lib/auth/account-metadata-write` with
  // this store's class; the upgrade owns that class for every item, so it
  // upgrades them too.
  ...LOCK_READABLE_METADATA_KEYS,
] as const;

// SecureStore cannot report the class an existing item was written with, so the
// upgrade records itself beside the items: absent, every item is rewritten with
// the widget class once; present, that rewrite already happened. A read that
// fails leaves it unwritten, so the upgrade runs at the next start rather than
// being skipped for good.
const ACCESSIBILITY_MARKER_KEY = 'widget-store-accessibility';
const ACCESSIBILITY_MARKER_VALUE = 'after-first-unlock';

/**
 * Rewrite every widget item with the class `widgetSecureStore` writes, once.
 *
 * An earlier release wrote these items `WHEN_UNLOCKED`, so a background push
 * could not read them on a locked phone. Each record is read and written back
 * through the widget store: an overwrite that carries the class upgrades the
 * item in place, and it also re-adds a record an older expo-secure-store wrote
 * under its legacy service, which the current read still accepts. The upgrade
 * runs on the item's own write queue (`upgradeGatedValue`), so a publish that
 * lands while it runs is either the value it repeats or the value that wins
 * after it — never a newer record replaced by an older one.
 *
 * A device that has not been unlocked since boot cannot read the items, so the
 * attempt returns without the marker and the next unlocked run finishes it. The
 * marker is written after every item, never before: a half-finished upgrade is
 * never recorded as done, and a rewrite that already landed is simply repeated.
 *
 * The probe goes first. It is written with the same class, so planting it proves
 * the keychain is open for every item below, and its presence is what lets a
 * `null` record read as an absent one instead of an unreadable one.
 */
export async function migrateWidgetStoreAccessibility(
  resolveStore: () => GatedSecureStore = widgetSecureStore
): Promise<void> {
  if (!(await ensureWidgetStoreProbe(resolveStore))) {
    return;
  }
  const marker = await readGatedValueForUpdate(resolveStore, ACCESSIBILITY_MARKER_KEY);
  if (marker.status === 'unreadable' || marker.value === ACCESSIBILITY_MARKER_VALUE) {
    return;
  }
  for (const key of WIDGET_STORE_KEYS) {
    // eslint-disable-next-line no-await-in-loop -- one item at a time: a device that has not been unlocked since boot refuses every call, and the upgrade must stop after the first refusal instead of firing the rest of them
    if (!(await upgradeGatedValue(resolveStore, key))) {
      return;
    }
  }
  await writeGatedValue(resolveStore, ACCESSIBILITY_MARKER_KEY, ACCESSIBILITY_MARKER_VALUE);
}
