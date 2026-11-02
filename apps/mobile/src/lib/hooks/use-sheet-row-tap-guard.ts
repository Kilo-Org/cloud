import { useRef } from 'react';

import {
  claimRowPress,
  createSheetRowTapGuardState,
  markSheetClosed,
} from '@/lib/hooks/sheet-row-tap-guard';

type SheetRowTapGuard = {
  /** Record the close of the list's form sheet. Call it in the one close path. */
  markClosed: () => void;
  /**
   * Wrap a row action so the presses that belong to the burst that dismissed
   * the sheet are dropped instead of reaching the row underneath it.
   */
  guard: <Args extends unknown[]>(action: (...args: Args) => void) => (...args: Args) => void;
};

/**
 * Per-screen instance of the tap-burst guard for a list whose row actions sit
 * underneath a form sheet.
 *
 * The clock is read at the press, so the window needs no timer and no render.
 * Each screen keeps its own instance through the hook's ref.
 */
export function useSheetRowTapGuard(): SheetRowTapGuard {
  const state = useRef(createSheetRowTapGuardState());
  return {
    markClosed: () => {
      markSheetClosed(state.current, Date.now());
    },
    guard:
      <Args extends unknown[]>(action: (...args: Args) => void) =>
      (...args: Args) => {
        if (claimRowPress(state.current, Date.now())) {
          action(...args);
        }
      },
  };
}
