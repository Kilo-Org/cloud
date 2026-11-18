// In-memory cross-route store for the post-merge "branch delete failed"
// partial-success banner. The merge sheet writes the reason here right
// before auto-dismissing; the PR review screen reads on focus and clears
// the entry so the banner does not reappear after the user navigates
// away and back.
//
// NOT persisted to AsyncStorage / SecureStore: the banner is ephemeral
// "you just did this thing and one part of it did not complete"
// feedback, not durable state. A cold reload can safely drop it.

import { type ProviderPrTriple } from '@/lib/pr-review/provider-pr-ref';

type PartialMergeSuccess = {
  /** Human-readable branch-delete failure reason from the server. */
  reason: string;
};

const store = new Map<string, PartialMergeSuccess>();

function key(ref: ProviderPrTriple): string {
  return `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`;
}

export function setMergePartialSuccess(ref: ProviderPrTriple, value: PartialMergeSuccess): void {
  store.set(key(ref), value);
}

export function consumeMergePartialSuccess(ref: ProviderPrTriple): PartialMergeSuccess | null {
  const k = key(ref);
  const value = store.get(k) ?? null;
  // Consume-on-read: the screen MUST render exactly once and then clear
  // so the banner does not flash on every focus.
  if (value) {
    store.delete(k);
  }
  return value;
}

export function clearMergePartialSuccess(ref: ProviderPrTriple): void {
  store.delete(key(ref));
}

/** Test-only: drop every entry. Never call from production code. */
export function __resetMergePartialSuccessStoreForTests(): void {
  store.clear();
}
