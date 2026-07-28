// Module-level bridge for the current diff selection (path + side + line
// range + the actual selected line text). The diff side calls
// `setDiffSelection` when the user taps a line range; the comment composer
// route reads it via `getDiffSelection` on focus and clears it on blur so
// a stale selection never leaks into the next visit. S7a implements the
// producer side (the diff component) and the consumer side (the composer
// sheet) in the same slice that adds the final pending-comment fields.
//
// The selection carries its owning PR identity so a selection made in one
// PR can never be consumed by another PR's composer if both entries remain
// mounted in the navigation stack: `getDiffSelection` returns null unless
// the requested PR matches the stored selection.

export type DiffSelectionSide = 'LEFT' | 'RIGHT';

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

let selection: DiffSelection | null = null;

function samePr(a: PrIdentity, b: PrIdentity): boolean {
  return (
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.repo.toLowerCase() === b.repo.toLowerCase() &&
    a.number === b.number
  );
}

export function setDiffSelection(next: DiffSelection) {
  selection = next;
}

export function getDiffSelection(pr: PrIdentity): DiffSelection | null {
  if (!selection || !samePr(selection, pr)) {
    return null;
  }
  return selection;
}

export function clearDiffSelection() {
  selection = null;
}
