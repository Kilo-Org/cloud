import { describe, expect, it } from 'vitest';

import {
  claimRowPress,
  createSheetRowTapGuardState,
  markScreenReturned,
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

  it('accepts a row press on a fresh state that never returned either', () => {
    const state = freshState();

    expect(state).toEqual({ closedAt: 0, returnedAt: 0 });
    expect(claimRowPress(state, T0)).toBe(true);
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

    expect(claimRowPress(state, T0 + 1000 + SHEET_ROW_TAP_GUARD_MS - 1)).toBe(false);
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

  it('drops the second tap of the burst that closed a child screen', () => {
    const state = freshState();
    markScreenReturned(state, T0);

    expect(claimRowPress(state, T0 + 40)).toBe(false);
    expect(claimRowPress(state, T0 + 300)).toBe(false);
  });

  it('accepts a press at the return boundary and drops the one before it', () => {
    const state = freshState();
    markScreenReturned(state, T0);

    expect(claimRowPress(state, T0 + SHEET_ROW_TAP_GUARD_MS - 1)).toBe(false);
    expect(claimRowPress(state, T0 + SHEET_ROW_TAP_GUARD_MS)).toBe(true);
  });

  it('drops a press while the return window alone is open', () => {
    const state = freshState();
    markSheetClosed(state, T0 - 2000);
    markScreenReturned(state, T0);

    expect(claimRowPress(state, T0 + 40)).toBe(false);
  });

  it('drops a press while the sheet window alone is open', () => {
    const state = freshState();
    markSheetClosed(state, T0);
    markScreenReturned(state, T0 - 2000);

    expect(claimRowPress(state, T0 + 40)).toBe(false);
  });

  it('accepts only once both windows have passed', () => {
    const state = freshState();
    markSheetClosed(state, T0);
    markScreenReturned(state, T0 + 1000);

    // The sheet's window has passed, the return's has not.
    expect(claimRowPress(state, T0 + 1000 + SHEET_ROW_TAP_GUARD_MS - 1)).toBe(false);
    expect(claimRowPress(state, T0 + 1000 + SHEET_ROW_TAP_GUARD_MS)).toBe(true);
  });

  it('does not extend either window when a press is dropped', () => {
    const state = freshState();
    markSheetClosed(state, T0);
    markScreenReturned(state, T0);
    claimRowPress(state, T0 + 10);

    expect(state.returnedAt).toBe(T0);
    expect(state.closedAt).toBe(T0);
    expect(claimRowPress(state, T0 + SHEET_ROW_TAP_GUARD_MS)).toBe(true);
  });

  it('re-arms the return window when the screen is returned to again', () => {
    const state = freshState();
    markScreenReturned(state, T0);
    markScreenReturned(state, T0 + 1000);

    expect(claimRowPress(state, T0 + 1000 + SHEET_ROW_TAP_GUARD_MS - 1)).toBe(false);
    expect(claimRowPress(state, T0 + 1000 + SHEET_ROW_TAP_GUARD_MS)).toBe(true);
    expect(state.returnedAt).toBe(T0 + 1000);
  });

  it('reads a backwards clock step as no burst instead of latching the guard', () => {
    const state = freshState();
    markSheetClosed(state, T0);
    markScreenReturned(state, T0);

    expect(claimRowPress(state, T0 - 1000)).toBe(true);
  });
});
