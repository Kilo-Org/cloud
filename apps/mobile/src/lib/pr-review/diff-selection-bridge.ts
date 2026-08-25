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

import { prDiffSelectionSlot, prRouteKey } from '../route-registry';

type DiffSelectionSide = 'LEFT' | 'RIGHT';

export type PrIdentity = {
  owner: string;
  repo: string;
  number: number;
};

export type DiffSelection = PrIdentity & {
  path: string;
  side: DiffSelectionSide;
  line: number;
  startLine?: number;
  selectedText: string;
};

export function setDiffSelection(next: DiffSelection) {
  prDiffSelectionSlot.set(prRouteKey(next), next);
}

export function getDiffSelection(pr: PrIdentity): DiffSelection | null {
  return prDiffSelectionSlot.get(prRouteKey(pr)) ?? null;
}

export function clearDiffSelection() {
  prDiffSelectionSlot.clearAll();
}
