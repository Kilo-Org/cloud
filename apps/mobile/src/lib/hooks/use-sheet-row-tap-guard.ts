import { useFocusEffect } from 'expo-router';
import { useCallback, useRef } from 'react';

import {
  claimRowPress,
  createSheetRowTapGuardState,
  markScreenReturned,
  markSheetClosed,
} from '@/lib/hooks/sheet-row-tap-guard';

type SheetRowTapGuard = {
  /** Record the close of the list's form sheet. Call it in the one close path. */
  markClosed: () => void;
  /**
   * Wrap a press so the presses that belong to the burst which dismissed the
   * sheet or closed the pushed child screen are dropped instead of reaching the
   * row or header action underneath it.
   */
  guard: <Args extends unknown[]>(action: (...args: Args) => void) => (...args: Args) => void;
};

/**
 * Per-screen instance of the tap-burst guard for a list that a sheet or a
 * pushed child screen hands the reader back to.
 *
 * Two hand-backs arm it: the screen's own sheet closing (through `markClosed`)
 * and the screen regaining focus from a child it pushed (through the focus
 * effect below, which skips the first focus so a fresh mount does not deaden
 * its own rows).
 *
 * The clock is read at the press, so the window needs no timer and no render.
 * Each screen keeps its own instance through the hook's ref.
 */
export function useSheetRowTapGuard(): SheetRowTapGuard {
  const state = useRef(createSheetRowTapGuardState());
  // A screen that has focused once has already been returned to the reader
  // once; only a later focus means a child closed.
  const hasFocused = useRef(false);

  useFocusEffect(
    useCallback(() => {
      if (!hasFocused.current) {
        hasFocused.current = true;
        return;
      }
      markScreenReturned(state.current, Date.now());
    }, [])
  );

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
