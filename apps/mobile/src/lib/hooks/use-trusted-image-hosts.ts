import { useSyncExternalStore } from 'react';

import { createSecureStorePreference } from '@/lib/hooks/secure-store-preference';
import { TRUSTED_IMAGE_HOSTS_KEY } from '@/lib/storage-keys';

/**
 * Parses the stored trusted-image-host key array. Malformed JSON, a non-array
 * value, and a list holding any non-string or empty entry all fall back to an
 * empty list: a corrupt or tampered write must never auto-load an image, so one
 * bad entry fails the whole list closed rather than keeping a partial allowlist.
 */
function parseTrustedImageHosts(raw: string | null): string[] {
  if (raw === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON parse boundary: only an all-string list is trusted, so a non-string entry fails the list closed
    const strings = parsed.filter((host): host is string => typeof host === 'string');
    if (strings.length !== parsed.length) {
      return [];
    }
    const hosts = strings.filter(host => host.length > 0);
    return hosts.length === strings.length ? hosts : [];
  } catch {
    return [];
  }
}

/**
 * Display and match key for an image's host: lowercased hostname, plus ":port"
 * only when the port is not the protocol default. Returns null when the URL
 * cannot be parsed or carries no hostname, so a malformed URI is never trusted
 * and never auto-loads.
 */
export function formatTrustedImageHost(uri: string): string | null {
  try {
    const url = new URL(uri);
    const hostname = url.hostname.toLowerCase();
    if (hostname === '') {
      return null;
    }
    const port = url.port;
    const isDefaultPort =
      (url.protocol === 'http:' && (port === '' || port === '80')) ||
      (url.protocol === 'https:' && (port === '' || port === '443'));
    return port !== '' && !isDefaultPort ? `${hostname}:${port}` : hostname;
  } catch {
    return null;
  }
}

// A JSON string array of host keys (lowercased hostname plus a non-default
// port). Empty default: nothing is trusted until the user opts in.
const store = createSecureStorePreference<string[]>({
  key: TRUSTED_IMAGE_HOSTS_KEY,
  defaultValue: [],
  parse: parseTrustedImageHosts,
  serialize: value => JSON.stringify(value),
  mergeOnLoad: (disk, pending) => [...new Set([...disk, ...pending])],
});

// Warm the store as soon as any image-trust-aware module is imported, so a host
// trusted in a prior session auto-loads on a cold start without waiting for a
// screen to mount.
store.preload();

export function useTrustedImageHosts() {
  const trustedImageHosts = useSyncExternalStore(store.subscribe, store.get);
  const hasLoaded = useSyncExternalStore(store.subscribe, store.getHasLoaded);
  return { trustedImageHosts, hasLoaded };
}

export function subscribeTrustedImageHosts(listener: () => void): () => void {
  return store.subscribe(listener);
}

export function isTrustedImageHost(host: string): boolean {
  return store.get().includes(host);
}

export function trustImageHost(host: string): void {
  // Start the disk read if it has not run, so the trust write merges with the
  // persisted list instead of replacing it with the empty default.
  store.preload();
  const current = store.get();
  if (current.includes(host)) {
    return;
  }
  store.set([...current, host]);
}

export function revokeImageHost(host: string): void {
  store.set(store.get().filter(item => item !== host));
}

export function clearTrustedImageHosts(): void {
  store.clear();
}

export function getTrustedImageHostsHasLoaded(): boolean {
  return store.getHasLoaded();
}
