import { type StoredValueRead } from '@/lib/auth/secure-store-value';
import { ACTIVE_USER_ID_KEY, ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';
import { reportSecureStoreFailure } from '@/lib/telemetry/secure-store-events';

/**
 * Gated SecureStore calls on a store the caller resolves, and the store the
 * widget and glanceable scope items live in.
 *
 * `lib/auth/secure-store-value` applies this same policy to the native module,
 * but it imports `expo-secure-store` at module load, and the modules that own
 * their store (the glanceable mirrors, the session-card scope records) are
 * imported by pure suites that must not load that graph. They hand their own
 * accessor to this module instead, so their calls still pass the one report: a
 * failure that is not a keychain refusal is filed once, named by the operation
 * that failed, and a refusal leaves a breadcrumb.
 *
 * These items are not credentials. They carry counts, statuses, timestamps and
 * an opaque scope key, and a push or a background task mirrors them while the
 * phone is locked, so `widgetSecureStore` writes them
 * `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` instead of the `WHEN_UNLOCKED` class
 * expo-secure-store defaults to. That class is readable while locked once the
 * device has been unlocked after boot, so the calls below are attempted in the
 * background rather than skipped; only a refusal before that first unlock
 * fails.
 *
 * A read is still never proof of absence: iOS can answer `null` for an item it
 * will not hand over, the cached protected-data state cannot be trusted to
 * notice the phone locking while the app was suspended, and an item still on the
 * default class answers `null` on a locked device even while a class-bearing item
 * answers. The proof is the upgrade marker instead
 * ({@link WIDGET_STORE_CLASS_MARKER}): it is written with the class and only
 * after every item, so its presence means each of them carries the class and the
 * keychain is open for it. Only then is a `null` an absent record; before it
 * lands, every absence reads as unreadable.
 *
 * The bearer tokens never reach this module. They keep
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY` (`credentials.ts`), which a locked device
 * cannot read, and the credential reads keep their own guard.
 *
 * The accessor runs inside the call rather than at the caller. Those modules
 * resolve their store lazily, so resolving it can itself fail, and a mirror
 * write that is never awaited must not reject: both the resolution and the call
 * land in the same catch.
 */

/** The `expo-secure-store` options these calls build; only a write carries one. */
type GatedStoreOptions = { keychainAccessible?: number };

/**
 * The two account ids the glanceable fences compare, and the only account
 * metadata written with the widget class: a push must resolve the account it
 * acts for with the screen locked. Neither is a credential.
 * `lib/auth/account-metadata-write` writes them with the class, and
 * `lib/glanceable/widget-store` upgrades an existing install's pair once.
 */
export const LOCK_READABLE_METADATA_KEYS = [ACTIVE_USER_ID_KEY, ORGANIZATION_STORAGE_KEY] as const;

/**
 * The marker that records the class upgrade finished. Its presence is the proof
 * a `null` record needs: it is written with the same class, so it answers only
 * while the keychain is open for that class, and it is written after every item,
 * so every item carries the class by the time it lands. Until then "nothing
 * stored" and "not readable" are indistinguishable, and a `null` reads as an
 * unreadable one.
 */
export const WIDGET_STORE_CLASS_MARKER = {
  key: 'widget-store-accessibility',
  value: 'after-first-unlock',
} as const;

/**
 * The item the upgrade writes with expo-secure-store's default class to prove the
 * device is unlocked right now. A `WHEN_UNLOCKED` write is refused while the
 * device is locked (`SecureStoreModule.swift`: `setValueWithKeyAsync` throws for
 * every status but success and duplicate), so a successful write is the one
 * positive answer to "may I read a not-yet-upgraded item's absence as absent?".
 */
export const WIDGET_STORE_UNLOCK_CANARY = {
  key: 'widget-store-unlock-canary',
  value: 'unlocked',
} as const;

/** The read half of a store; a caller that only reads can supply exactly that. */
export type GatedReadStore = {
  getItemAsync(key: string, options?: GatedStoreOptions): Promise<string | null>;
};

/** The SecureStore surface a caller supplies; the native module satisfies it. */
export type GatedSecureStore = GatedReadStore & {
  setItemAsync(key: string, value: string, options?: GatedStoreOptions): Promise<void>;
};

/**
 * The native module plus the constants it resolves at load.
 * `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` is one of them; Android's module declares
 * none, and the class does not exist there, so an absent value is ignored by the
 * write instead of changing what Android stores.
 */
export type NativeWidgetStore = GatedSecureStore & {
  readonly AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY?: number;
};

/**
 * Bind the widget accessibility to a store. Every write lands
 * `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`, which an unlocked-once device hands
 * back while it is locked, so a background push can read the record it mirrors.
 * An overwrite carries the class too: expo-secure-store keeps an existing item's
 * class only when the option is omitted, so the same call upgrades a record an
 * earlier release wrote `WHEN_UNLOCKED`.
 *
 * A read passes no class: it filters by key and service, never by accessibility.
 */
export function withWidgetAccessibility(store: NativeWidgetStore): GatedSecureStore {
  const options: GatedStoreOptions = {
    keychainAccessible: store.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  };
  return {
    getItemAsync: key => store.getItemAsync(key),
    setItemAsync: (key, value) => store.setItemAsync(key, value, options),
  };
}

/** The widget and glanceable scope store, as the app resolves it for real. */
export function widgetSecureStore(): GatedSecureStore {
  // eslint-disable-next-line typescript-eslint/no-require-imports, typescript-eslint/no-var-requires, unicorn/prefer-module -- headless-safe lazy native load: the pure suites that import this module must not load expo-modules-core
  return withWidgetAccessibility(require('expo-secure-store') as NativeWidgetStore);
}

/**
 * The same keychain written with expo-secure-store's default `WHEN_UNLOCKED`
 * class. Only the upgrade's canary uses it: that class cannot be written while
 * the device is locked, which makes a successful write the proof that a `null`
 * from a not-yet-upgraded item is an absence rather than a locked read.
 */
export function widgetStoreDefaultClass(): GatedSecureStore {
  // eslint-disable-next-line typescript-eslint/no-require-imports, typescript-eslint/no-var-requires, unicorn/prefer-module -- headless-safe lazy native load: the pure suites that import this module must not load expo-modules-core
  return require('expo-secure-store') as GatedSecureStore;
}

/** `true` only when a default-class write lands right now, so the device is unlocked. */
async function deviceIsUnlocked(resolveStore: () => GatedSecureStore): Promise<boolean> {
  try {
    await resolveStore().setItemAsync(
      WIDGET_STORE_UNLOCK_CANARY.key,
      WIDGET_STORE_UNLOCK_CANARY.value
    );
    return true;
  } catch (error) {
    reportSecureStoreFailure('write', error);
    return false;
  }
}

/**
 * `true` only when the upgrade marker reads back, which means every item in the
 * widget store carries the class and the keychain is open for it. A closed
 * keychain cannot prove absence, and neither can an install the upgrade has not
 * finished: a record still on expo-secure-store's default class answers `null`
 * on a locked device, so the class is what makes a `null` mean "absent".
 */
export async function widgetStoreClassApplied(
  resolveStore: () => GatedReadStore
): Promise<boolean> {
  try {
    const marker = await resolveStore().getItemAsync(WIDGET_STORE_CLASS_MARKER.key);
    return marker === WIDGET_STORE_CLASS_MARKER.value;
  } catch (error) {
    reportSecureStoreFailure('read', error);
    return false;
  }
}

// One queue per key, shared by every writer and by the class upgrade. A publish
// runs while a background push can be mirroring the same key, so a write and a
// rewrite have to land whole and in order.
const queues = new Map<string, Promise<unknown>>();

function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = (async (): Promise<T> => {
    await previous;
    return task();
  })();
  queues.set(
    key,
    (async (): Promise<void> => {
      try {
        await next;
      } catch {
        // A step the caller sees rejected still releases the queue behind it;
        // the rejection itself reaches the caller through `next`.
      }
    })()
  );
  return next;
}

async function setGatedValue(
  resolveStore: () => GatedSecureStore,
  key: string,
  value: string
): Promise<boolean> {
  try {
    await resolveStore().setItemAsync(key, value);
    return true;
  } catch (error) {
    reportSecureStoreFailure('write', error);
    return false;
  }
}

/**
 * Read for a read-modify-write: `'unreadable'` when the value cannot be taken
 * at face value, so the caller never persists a record derived from a value it
 * never read. That covers a failed read and — the one that matters for a
 * surface — a `null` the class upgrade does not yet vouch for.
 */
export async function readGatedValueForUpdate(
  resolveStore: () => GatedReadStore,
  key: string
): Promise<StoredValueRead> {
  try {
    const value = await resolveStore().getItemAsync(key);
    if (value === null && !(await widgetStoreClassApplied(resolveStore))) {
      return { status: 'unreadable' };
    }
    return { status: 'value', value };
  } catch (error) {
    reportSecureStoreFailure('read', error);
    return { status: 'unreadable' };
  }
}

/**
 * Read for the upgrade only: a successful read is the item's contents, `null`
 * included, and only a rejection is unreadable. The upgrade runs in the
 * foreground, and a device that cannot read a legacy item cannot write its
 * marker either, so the marker still gates every absence read outside it.
 */
async function readGatedValueRaw(
  resolveStore: () => GatedReadStore,
  key: string
): Promise<StoredValueRead> {
  try {
    return { status: 'value', value: await resolveStore().getItemAsync(key) };
  } catch (error) {
    reportSecureStoreFailure('read', error);
    return { status: 'unreadable' };
  }
}

/**
 * Total write: `false` when the write failed. A mirror's in-memory value is
 * authoritative, so a failed write costs the next restore rather than the
 * caller's operation.
 */
export function writeGatedValue(
  resolveStore: () => GatedSecureStore,
  key: string,
  value: string
): Promise<boolean> {
  return serialized(key, () => setGatedValue(resolveStore, key, value));
}

/**
 * Rewrite one item with the store's class, keeping the value it holds, inside
 * the key's queue.
 *
 * The read and the write are one queue step, so the upgrade can never overwrite
 * a newer value: a write ordered before it is the value it reads and repeats,
 * and a write ordered after it wins. An empty read counts as done only when a
 * default-class canary write proves the device is unlocked — an item the upgrade
 * has not rewritten yet can answer `null` while locked, and the marker must never
 * claim such an item was upgraded. A refused canary or write reads as `false`,
 * so the caller stops without recording the upgrade.
 */
export function upgradeGatedValue(
  resolveStore: () => GatedSecureStore,
  key: string,
  resolveDefaultClassStore: () => GatedSecureStore = widgetStoreDefaultClass
): Promise<boolean> {
  return serialized(key, async () => {
    const stored = await readGatedValueRaw(resolveStore, key);
    if (stored.status === 'unreadable') {
      return false;
    }
    if (stored.value === null) {
      return deviceIsUnlocked(resolveDefaultClassStore);
    }
    return setGatedValue(resolveStore, key, stored.value);
  });
}
