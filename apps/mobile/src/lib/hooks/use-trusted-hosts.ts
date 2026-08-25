import { useSyncExternalStore } from 'react';

import { createSecureStorePreference } from '@/lib/hooks/secure-store-preference';
import { TRUSTED_HOSTS_KEY } from '@/lib/storage-keys';

/**
 * Parses the stored trusted-host key array. Malformed JSON, a non-array
 * value, and non-string entries all fall back to an empty list so a corrupt
 * write can never block link confirmations.
 */
export function parseTrustedHosts(raw: string | null): string[] {
  if (raw === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON parse boundary: filter unknown entries down to strings before they enter the domain
    return parsed.filter((host): host is string => typeof host === 'string');
  } catch {
    return [];
  }
}

// A JSON string array of host keys (lowercased hostname plus a non-default
// port). Empty default: nothing is trusted until the user opts in.
const store = createSecureStorePreference<string[]>({
  key: TRUSTED_HOSTS_KEY,
  defaultValue: [],
  parse: parseTrustedHosts,
  serialize: value => JSON.stringify(value),
});

// Warm the store as soon as any trust-aware module is imported, so a host
// trusted in a prior session skips the Alert on a cold start without waiting
// for Preferences to mount.
store.preload();

export function preloadTrustedHosts(): void {
  store.preload();
}

export function useTrustedHosts() {
  const trustedHosts = useSyncExternalStore(store.subscribe, store.get);
  const hasLoaded = useSyncExternalStore(store.subscribe, store.getHasLoaded);
  return { trustedHosts, hasLoaded };
}

export function isTrustedHost(host: string): boolean {
  return store.get().includes(host);
}

export function trustHost(host: string): void {
  // Start the disk read if it has not run, so the Trust write merges with the
  // persisted list instead of replacing it with the empty default.
  store.preload();
  const current = store.get();
  if (current.includes(host)) {
    return;
  }
  store.set([...current, host]);
}

export function revokeHost(host: string): void {
  store.set(store.get().filter(item => item !== host));
}

export function clearTrustedHosts(): void {
  store.clear();
}

export function getTrustedHostsHasLoaded(): boolean {
  return store.getHasLoaded();
}
