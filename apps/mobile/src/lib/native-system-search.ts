import { type NativeModule, requireOptionalNativeModule } from 'expo';

/** One entity the app writes into the phone's own search index. */
export type SystemSearchDocument = {
  id: string;
  title: string;
  description: string;
  keywords: string[];
  /**
   * The OS-facing link for this entry. Android stores it and hands it back
   * when the entry is picked; iOS ignores it and returns `id` instead.
   */
  route: string;
  fingerprint: string;
};

export type SystemSearchUpdate = {
  add: SystemSearchDocument[];
  removeIds: string[];
};

type SystemSearchEvents = {
  onSystemSearchOpen: () => void;
};

type SystemSearchNativeModule = InstanceType<typeof NativeModule<SystemSearchEvents>> & {
  applyUpdate: (add: SystemSearchDocument[], removeIds: string[]) => Promise<void>;
  indexedFingerprints: () => Promise<Record<string, string>>;
  clear: () => Promise<void>;
  consumePendingRoute: () => Promise<string | null>;
};

// Absent in a development client built before this module shipped: every export
// below then answers empty instead of throwing.
const nativeModule = requireOptionalNativeModule<SystemSearchNativeModule>('KiloSystemSearch');

export const isSystemSearchAvailable = nativeModule !== null;

/** The fingerprint the index holds per record id, for the caller's own ledger diff. */
export async function indexedSystemSearchFingerprints(): Promise<Record<string, string>> {
  return (await nativeModule?.indexedFingerprints()) ?? {};
}

/**
 * Applies one index delta. A rejection means the platform index did not accept
 * the change and carries its own message; the caller owns the retry.
 */
export async function applySystemSearchUpdate(update: SystemSearchUpdate): Promise<void> {
  await nativeModule?.applyUpdate(update.add, update.removeIds);
}

export async function clearSystemSearchIndex(): Promise<void> {
  await nativeModule?.clear();
}

/**
 * The identifier of the last search result the user opened, read and cleared in
 * one step. `null` when there is none. The caller resolves the identifier to a
 * screen, so no id lookup lives here.
 *
 * Asynchronous because the native side answers on its module queue: resolving
 * an Android identifier that is not already a route reads the app-search index,
 * and that read must not run on the JavaScript thread.
 */
export async function consumePendingSystemSearchRoute(): Promise<string | null> {
  return (await nativeModule?.consumePendingRoute()) ?? null;
}

export function addSystemSearchOpenListener(listener: () => void): { remove: () => void } | null {
  return nativeModule?.addListener('onSystemSearchOpen', listener) ?? null;
}
