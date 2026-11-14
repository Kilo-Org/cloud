import { useSyncExternalStore } from 'react';

import { createSecureStorePreference } from '@/lib/hooks/secure-store-preference';
import { CONDENSE_TOOL_CALLS_KEY } from '@/lib/storage-keys';

/**
 * On unless the stored string is exactly `false`. A transcript that collapses
 * consecutive tool calls by default is the readable one on a phone, so the
 * preference only records the reader who turned it off; a missing value (a
 * fresh install, or a session stored before the preference existed) reads as on.
 */
export function parseCondenseToolCalls(raw: string | null): boolean {
  return raw === null ? true : raw === 'true';
}

const store = createSecureStorePreference<boolean>({
  key: CONDENSE_TOOL_CALLS_KEY,
  defaultValue: true,
  parse: parseCondenseToolCalls,
  serialize: value => (value ? 'true' : 'false'),
});

export function clearCondenseToolCallsPreference() {
  store.clear();
}

export function setCondenseToolCalls(value: boolean) {
  store.set(value);
}

/** The stored condense-tool-calls value for callers with no React tree. */
export function getCondenseToolCalls(): boolean {
  return store.getRequested();
}

export function useCondenseToolCallsPreference() {
  const condenseToolCalls = useSyncExternalStore(store.subscribe, store.get);
  const hasLoaded = useSyncExternalStore(store.subscribe, store.getHasLoaded);
  return { condenseToolCalls, hasLoaded, setCondenseToolCalls };
}
