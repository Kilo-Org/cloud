import { describe, expect, it } from 'vitest';

import {
  claimRowPress,
  createSheetRowTapGuardState,
  markSheetClosed,
  SHEET_ROW_TAP_GUARD_MS,
  type SheetRowTapGuardState,
} from './sheet-row-tap-guard';

const T0 = 1_700_000_000_000;

function freshState(): SheetRowTapGuardState {
  return createSheetRowTapGuardState();
}

describe('claimRowPress', () => {
  it('accepts a row press before any sheet closed', () => {
    expect(claimRowPress(freshState(), T0)).toBe(true);
  });

  it('drops the second tap of the burst that closed the sheet', () => {
    const state = freshState();
    markSheetClosed(state, T0);

    expect(claimRowPress(state, T0 + 40)).toBe(false);
    expect(claimRowPress(state, T0 + 300)).toBe(false);
  });

  it('accepts a press at the window boundary and drops the one before it', () => {
    const state = freshState();
    markSheetClosed(state, T0);

    expect(claimRowPress(state, T0 + SHEET_ROW_TAP_GUARD_MS - 1)).toBe(false);
    expect(claimRowPress(state, T0 + SHEET_ROW_TAP_GUARD_MS)).toBe(true);
  });

  it('re-arms the window when another sheet closes', () => {
    const state = freshState();
    markSheetClosed(state, T0);
    markSheetClosed(state, T0 + 1000);

    expect(claimRowPress(state, T0 + SHEET_ROW_TAP_GUARD_MS)).toBe(false);
    expect(claimRowPress(state, T0 + 1000 + SHEET_ROW_TAP_GUARD_MS)).toBe(true);
    expect(state.closedAt).toBe(T0 + 1000);
  });

  it('does not extend the window when a row press is dropped', () => {
    const state = freshState();
    markSheetClosed(state, T0);
    claimRowPress(state, T0 + 10);

    expect(state.closedAt).toBe(T0);
    expect(claimRowPress(state, T0 + SHEET_ROW_TAP_GUARD_MS)).toBe(true);
  });
});
