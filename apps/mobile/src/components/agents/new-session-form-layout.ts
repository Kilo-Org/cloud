import { isShortViewport } from '@/lib/centered-state-layout';

/**
 * Narrowest short window that still gives each split column a usable width.
 * A phone held sideways is far wider than this (a 411x914dp window reports 914
 * once it rotates), so the guard only keeps a narrow, short window — a split
 * screen, a small floating window — in the stacked layout whose columns would
 * both be too narrow for the composer's mode/model pills and the repository
 * picker.
 */
export const NEW_SESSION_SPLIT_MIN_WIDTH = 600;

/** How the new-session form arranges its composer card and its setting rows. */
export type NewSessionFormLayout = 'stacked' | 'split';

/**
 * Whether the form splits into two columns.
 *
 * Stacked is the portrait layout and the only one that fits: the composer card
 * plus the rows under it scroll as one column. A short window — a phone held
 * sideways, which `isShortViewport` defines — leaves a ~211dp scroll frame
 * against a ~203dp composer card, so the card fills the viewport and the Run on
 * row and the repository picker sit entirely below the fold with nothing on
 * screen pointing at them. There the form splits: the card keeps the left
 * column and the setting rows scroll in the right one, so the run target and
 * the repository picker are on screen at the same time, as they are in
 * portrait.
 *
 * Pure: it reads the window only, so a rotation re-renders into the right
 * layout without a measurement pass.
 */
export function resolveNewSessionFormLayout(width: number, height: number): NewSessionFormLayout {
  if (!isShortViewport(width, height)) {
    return 'stacked';
  }
  return width >= NEW_SESSION_SPLIT_MIN_WIDTH ? 'split' : 'stacked';
}
