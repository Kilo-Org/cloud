import { type StoredValueRead } from '@/lib/auth/secure-store-value';
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
 * background rather than skipped; only a refusal before that first unlock fails,
 * and it reads as an unreadable value, never as "nothing stored": an absent
 * record and a record the app cannot reach must stay distinguishable by every
 * caller that acts on the difference.
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

/** The SecureStore surface a caller supplies; the native module satisfies it. */
export type GatedSecureStore = {
  getItemAsync(key: string, options?: GatedStoreOptions): Promise<string | null>;
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
 * Total read: `null` while the device has not been unlocked since boot or when
 * the read failed. For a caller whose outcome is the same whether the value is
 * absent or unreadable.
 */
export async function readGatedValue(
  resolveStore: () => GatedSecureStore,
  key: string
): Promise<string | null> {
  try {
    return await resolveStore().getItemAsync(key);
  } catch (error) {
    reportSecureStoreFailure('read', error);
    return null;
  }
}

/**
 * Read for a read-modify-write: `'unreadable'` when the read failed, so the
 * caller never persists a record derived from a value it never read.
 */
export async function readGatedValueForUpdate(
  resolveStore: () => GatedSecureStore,
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
 * Total write: `false` when the write failed. For a mirror whose in-memory value
 * is authoritative, so a skipped write costs the next restore rather than the
 * caller's operation.
 */
export async function writeGatedValue(
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
