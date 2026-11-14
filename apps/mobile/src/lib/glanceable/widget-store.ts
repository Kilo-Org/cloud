import {
  type GatedSecureStore,
  LOCK_READABLE_METADATA_KEYS,
  upgradeGatedValue,
  WIDGET_STORE_CLASS_MARKER,
  widgetSecureStore,
  widgetStoreClassApplied,
  widgetStoreDefaultClass,
  writeGatedValue,
} from '@/lib/auth/secure-store-gated';
import { chainSave } from '@/lib/hooks/save-chain';

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

// The identity hints have an owner with its own per-key serializer.
const lockReadableKeys: ReadonlySet<string> = new Set(LOCK_READABLE_METADATA_KEYS);

/**
 * Upgrade one item, on the chain its owner serializes on.
 *
 * The two identity hints belong to `lib/auth/account-metadata-write`, whose
 * writes and deletes chain on `chainSave`, so their rewrite joins that chain: a
 * sign-out delete or an organization save that lands meanwhile is either the
 * value this read repeats or the value that wins after it, never an older id
 * restored over it. The other items have no writer outside this module and are
 * serialized by `upgradeGatedValue`'s own per-key queue.
 */
function upgradeWidgetStoreItem(
  resolveStore: () => GatedSecureStore,
  resolveDefaultClassStore: () => GatedSecureStore,
  key: string
): Promise<boolean> {
  if (lockReadableKeys.has(key)) {
    return chainSave(key, () => upgradeGatedValue(resolveStore, key, resolveDefaultClassStore));
  }
  return upgradeGatedValue(resolveStore, key, resolveDefaultClassStore);
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
 * The marker is the whole point. It is written with the same class and only
 * after every item, so its presence is what lets an absent record read as absent
 * rather than unreadable (`lib/auth/secure-store-gated`). An empty read counts as
 * done only after a default-class canary write proves the device is unlocked, so
 * a pass that starts or runs on with the screen locked never records an item it
 * could not read; the marker stays unwritten and the next unlocked start
 * finishes the upgrade, which is the safe direction.
 */
export async function migrateWidgetStoreAccessibility(
  resolveStore: () => GatedSecureStore = widgetSecureStore,
  resolveDefaultClassStore: () => GatedSecureStore = widgetStoreDefaultClass
): Promise<void> {
  if (await widgetStoreClassApplied(resolveStore)) {
    return;
  }
  for (const key of WIDGET_STORE_KEYS) {
    // eslint-disable-next-line no-await-in-loop -- one item at a time: a device that has not been unlocked since boot refuses every call, and the upgrade must stop after the first refusal instead of firing the rest of them
    if (!(await upgradeWidgetStoreItem(resolveStore, resolveDefaultClassStore, key))) {
      return;
    }
  }
  await writeGatedValue(
    resolveStore,
    WIDGET_STORE_CLASS_MARKER.key,
    WIDGET_STORE_CLASS_MARKER.value
  );
}
