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
 * Per-screen instance of the tap-burst guard for a list whose row actions sit
 * underneath something that closes itself.
 *
 * The screen's own sheet closing arms it through `markClosed`. A screen that
 * also pushes a child which closes itself after its save asks for the second
 * arm with `{ onReturn: true }`: from then on, regaining focus from that child
 * arms the same window through the focus effect below, which skips the first
 * focus so a fresh mount does not deaden its own rows. A screen whose children
 * stay open keeps `onReturn` off, so returning from a sheet it opened never
 * costs the reader the first press.
 *
 * The clock is read at the press, so the window needs no timer and no render.
 * Each screen keeps its own instance through the hook's ref.
 */
export function useSheetRowTapGuard(
  options: Readonly<{ onReturn?: boolean }> = {}
): SheetRowTapGuard {
  const state = useRef(createSheetRowTapGuardState());
  const onReturn = options.onReturn === true;
  // A screen that has focused once has already been returned to the reader
  // once; only a later focus means a child closed.
  const hasFocused = useRef(false);

  useFocusEffect(
    useCallback(() => {
      if (!hasFocused.current) {
        hasFocused.current = true;
        return;
      }
      if (onReturn) {
        markScreenReturned(state.current, Date.now());
      }
    }, [onReturn])
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
