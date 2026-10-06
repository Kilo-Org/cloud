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

const IPV6_HOSTNAME_PATTERN = /^\[[0-9a-f:.]+\]$/;
const REGISTERED_HOSTNAME_PATTERN = /^[a-z0-9\u00A1-\uFFFF._-]+$/;
const PORT_PATTERN = /^\d+$/;

/**
 * Splits an authority's host and port. Returns null for any authority shape
 * the native client would not resolve to that exact host, so an unusual
 * authority fails closed instead of keying as a host the request never
 * reaches. An IPv6 host keeps its brackets; every other host is lowercased
 * and restricted to registered-name characters.
 */
function parseAuthorityHost(hostPort: string): { hostname: string; port: string } | null {
  let hostname = '';
  let port = '';
  if (hostPort.startsWith('[')) {
    const close = hostPort.indexOf(']');
    if (close === -1) {
      return null;
    }
    hostname = hostPort.slice(0, close + 1).toLowerCase();
    const afterBracket = hostPort.slice(close + 1);
    if (afterBracket === '') {
      port = '';
    } else if (afterBracket.startsWith(':')) {
      port = afterBracket.slice(1);
    } else {
      return null;
    }
    if (!IPV6_HOSTNAME_PATTERN.test(hostname)) {
      return null;
    }
  } else {
    const colon = hostPort.indexOf(':');
    hostname = (colon === -1 ? hostPort : hostPort.slice(0, colon)).toLowerCase();
    port = colon === -1 ? '' : hostPort.slice(colon + 1);
    if (port.includes(':') || !REGISTERED_HOSTNAME_PATTERN.test(hostname)) {
      return null;
    }
  }
  if (port !== '' && !PORT_PATTERN.test(port)) {
    return null;
  }
  return { hostname, port };
}

/**
 * Display and match key for an image's host: lowercased hostname, plus ":port"
 * only when the port is not the protocol default. Returns null when the URI is
 * not http(s), carries no valid host, or cannot be parsed, so a malformed URI
 * is never trusted and never auto-loads.
 *
 * React Native's `URL` is a regex-based polyfill whose `hostname` lets `[^@]+`
 * cross a path separator, so `https://attacker.com/x@trusted.com/p.png` keys
 * as `trusted.com` even though the native client connects to `attacker.com`.
 * Deriving the key from the authority we delimit ourselves keeps the key on the
 * host the request actually reaches, so a path `@` can never satisfy a
 * different host's opt-in.
 */
export function formatTrustedImageHost(uri: string): string | null {
  const schemeEnd = uri.indexOf('://');
  if (schemeEnd === -1) {
    return null;
  }
  const protocol = uri.slice(0, schemeEnd).toLowerCase();
  if (protocol !== 'http' && protocol !== 'https') {
    return null;
  }
  // The authority ends at the first path, query, fragment, or backslash
  // delimiter. A backslash is a path separator for http(s) under WHATWG
  // parsing, so it must end the authority here too.
  const remainder = uri.slice(schemeEnd + 3);
  const authorityEnd = remainder.search(/[/?#\\]/);
  const authority = authorityEnd === -1 ? remainder : remainder.slice(0, authorityEnd);
  // Userinfo ends at the last '@' in the authority; a path '@' is already
  // excluded above and can never be promoted to the host.
  const host = parseAuthorityHost(authority.slice(authority.lastIndexOf('@') + 1));
  if (host === null) {
    return null;
  }
  // WHATWG parses the port as a number: leading zeros drop and a port above
  // the 16-bit maximum fails, so the native client would never resolve it.
  // Canonicalize to that numeric endpoint or fail closed, so `:0443` keys as
  // the same authority as `:443` instead of a distinct, never-matching host.
  let port = '';
  if (host.port !== '') {
    const portNumber = Number(host.port);
    if (portNumber > 65_535) {
      return null;
    }
    port = String(portNumber);
  }
  const isDefaultPort =
    port === '' ||
    (protocol === 'http' && port === '80') ||
    (protocol === 'https' && port === '443');
  return isDefaultPort ? host.hostname : `${host.hostname}:${port}`;
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
