import { useSyncExternalStore } from 'react';

import { createSecureStorePreference } from '@/lib/hooks/secure-store-preference';
import { type RepoPlatform } from '@/lib/picker-bridge';
import { COLLAPSED_CONNECT_CTAS_KEY } from '@/lib/storage-keys';

/** Every provider that renders a connect card on the new-session screen. */
const KNOWN_PLATFORMS: ReadonlySet<string> = new Set(['github', 'gitlab', 'bitbucket']);

/**
 * Parses the stored collapsed-CTA platform list. `null`, malformed JSON, a
 * non-array value, and unknown platform strings all drop, so a corrupt write
 * reads back as "nothing collapsed" instead of blocking the screen.
 */
export function parseCollapsedConnectCtas(raw: string | null): RepoPlatform[] {
  if (raw === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const platforms = parsed.filter(
      (entry): entry is RepoPlatform =>
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON parse boundary: JSON.parse output is untrusted, so each entry's runtime type is checked before it enters the domain
        typeof entry === 'string' && KNOWN_PLATFORMS.has(entry)
    );
    // De-duplicate, keeping the input order: one entry per collapsed platform.
    return [...new Set(platforms)];
  } catch {
    return [];
  }
}

// A JSON array of the provider platforms whose connect CTA is collapsed.
// Empty default: every CTA starts expanded.
const store = createSecureStorePreference<RepoPlatform[]>({
  key: COLLAPSED_CONNECT_CTAS_KEY,
  defaultValue: [],
  parse: parseCollapsedConnectCtas,
  serialize: value => JSON.stringify(value),
  mergeOnLoad: (disk, pending) => [...new Set([...disk, ...pending])],
});

// Warm the store as soon as this module is imported: the connect card gates
// its first paint on `hasLoaded`, so the disk read must start before the
// new-session screen mounts (same reason as use-trusted-hosts).
store.preload();

export function useCollapsedConnectCtas() {
  const collapsedCtas = useSyncExternalStore(store.subscribe, store.get);
  const hasLoaded = useSyncExternalStore(store.subscribe, store.getHasLoaded);
  return { collapsedCtas, hasLoaded };
}

export function setConnectCtaCollapsed(platform: RepoPlatform, collapsed: boolean): void {
  // Start the disk read if it has not run, so the write merges with the
  // persisted list instead of replacing it with the empty default.
  store.preload();
  const current = store.get();
  const isCollapsed = current.includes(platform);
  // No membership change: skip the write, so useSyncExternalStore never loops
  // on a store notification that carries the same value.
  if (isCollapsed === collapsed) {
    return;
  }
  store.set(collapsed ? [...current, platform] : current.filter(item => item !== platform));
}

export function clearCollapsedConnectCtasPreference(): void {
  store.clear();
}
