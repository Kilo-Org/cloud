// Route-scoped bridge for the current diff selection (path + side + line
// range + the actual selected line text). The diff side calls
// `setDiffSelection` when the user taps a line range; the comment composer
// route reads it via `getDiffSelection` on focus and the diff view clears it
// on blur so a stale selection never leaks into the next visit.
//
// The selection is stored in the route registry under the PR's route key, so
// a selection made in one PR can never be consumed by another PR's composer
// if both entries remain mounted in the navigation stack: `getDiffSelection`
// returns null unless the requested PR matches the stored selection.

import { prDiffSelectionSlot, prRouteKey, type RouteKey } from '../route-registry';
import { type ProviderPrRef, providerPrRefKey } from '@/lib/pr-review/provider-pr-ref';

type DiffSelectionSide = 'LEFT' | 'RIGHT';

export type PrIdentity = {
  owner: string;
  repo: string;
  number: number;
  /**
   * The provider ref (identity rule 17) this identity belongs to, when the
   * caller is on a provider surface. Present, the bridge key folds the
   * `providerPrRefKey` identity in — exactly like the viewed-files and draft
   * keys — so every slot key resolves under the full provider identity.
   * Absent, the key stays the legacy GitHub bytes.
   */
  ref?: ProviderPrRef;
};

export type DiffSelection = PrIdentity & {
  path: string;
  side: DiffSelectionSide;
  line: number;
  startLine?: number;
  selectedText: string;
};

/**
 * The bridge slot key for one PR identity. Mirrors `viewedFilesKey`: the
 * GitHub-shaped legacy bytes, suffixed with the provider ref identity when a
 * provider ref is present, so every slot resolves under the same
 * provider-scoped identity rule 17 the viewed-files and draft keys use.
 */
function bridgeRouteKey(pr: PrIdentity): RouteKey {
  const legacy = prRouteKey(pr);
  if (!pr.ref || pr.ref.platform === 'github') {
    return legacy;
  }
  return `${legacy}@${providerPrRefKey(pr.ref)}`;
}

export function setDiffSelection(next: DiffSelection) {
  prDiffSelectionSlot.set(bridgeRouteKey(next), next);
}

export function getDiffSelection(pr: PrIdentity): DiffSelection | null {
  return prDiffSelectionSlot.get(bridgeRouteKey(pr)) ?? null;
}

/**
 * Drops the selection stored for one PR. Scoped, not global: two PR entries
 * can sit on the navigation stack at once, and clearing the one on top must
 * not discard the selection the entry underneath is still holding.
 */
export function clearDiffSelection(pr: PrIdentity) {
  prDiffSelectionSlot.clear(bridgeRouteKey(pr));
}
