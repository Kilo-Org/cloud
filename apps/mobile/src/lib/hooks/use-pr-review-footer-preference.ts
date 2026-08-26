import { useSyncExternalStore } from 'react';

import { createSecureStorePreference } from '@/lib/hooks/secure-store-preference';
import { PR_REVIEW_FOOTER_KEY } from '@/lib/storage-keys';

/**
 * Default-on preference: only the exact stored string 'false' turns it off, so a
 * missing or unreadable value keeps the PR-review attribution footer the app
 * ships with.
 */
export function parsePrReviewFooter(raw: string | null): boolean {
  return raw !== 'false';
}

const store = createSecureStorePreference<boolean>({
  key: PR_REVIEW_FOOTER_KEY,
  defaultValue: true,
  parse: parsePrReviewFooter,
  serialize: value => (value ? 'true' : 'false'),
});

export function clearPrReviewFooterPreference() {
  store.clear();
}

function setPrReviewFooter(value: boolean) {
  store.set(value);
}

export function usePrReviewFooterPreference() {
  const prReviewFooter = useSyncExternalStore(store.subscribe, store.get);
  const hasLoaded = useSyncExternalStore(store.subscribe, store.getHasLoaded);
  return { prReviewFooter, hasLoaded, setPrReviewFooter };
}
