import { describe, expect, it } from 'vitest';

import {
  EMPTY_STATE_FULL_HEIGHT,
  getAgentsListBottomInset,
  getEmptyStatePresentation,
  SESSION_ROW_PITCH,
} from '@/lib/agents-bottom-chrome';

// The 420dp-tall Android landscape window: the chrome above the body ends at
// ~240dp, so the body keeps ~180dp and the full tab bar (81dp) + FAB band
// (72dp) reserve would leave ~27dp of list — less than one row.
const SHORT_AVAILABLE = 180;
const TAB_BAR = 81;
const FAB_BAND = 72;
const FULL_BAND = TAB_BAR + FAB_BAND;
// The gap the tabs layout reserves below the bar for scrolled content. The
// screen's surface replaces that inherited reservation so its centered states
// keep the bar alone (see `getEmptyStatePresentation`).
const TAB_GAP = 16;

describe('getAgentsListBottomInset', () => {
  it('reserves the whole band on the first, unmeasured frame', () => {
    expect(
      getAgentsListBottomInset({ available: null, tabBarHeight: TAB_BAR, fabBand: FAB_BAND })
    ).toEqual({ frame: FULL_BAND, content: 0 });
  });

  it('keeps the whole band and puts nothing on the content in a tall window', () => {
    expect(
      getAgentsListBottomInset({ available: 500, tabBarHeight: TAB_BAR, fabBand: FAB_BAND })
    ).toEqual({ frame: FULL_BAND, content: 0 });
  });

  it('clamps the frame to one row pitch in a short window and hands the rest to the content', () => {
    const inset = getAgentsListBottomInset({
      available: SHORT_AVAILABLE,
      tabBarHeight: TAB_BAR,
      fabBand: FAB_BAND,
    });
    // The viewport keeps exactly one row pitch above the reserve...
    expect(inset.frame).toBe(SHORT_AVAILABLE - SESSION_ROW_PITCH);
    // ...and the yielded part rides on the content so the last row can still
    // be scrolled clear of the FAB.
    expect(inset.content).toBe(FULL_BAND - inset.frame);
    expect(inset.frame + inset.content).toBe(FULL_BAND);
  });

  it('keeps the tab bar as a hard clearance when the window is shorter than the bar alone', () => {
    expect(
      getAgentsListBottomInset({ available: 40, tabBarHeight: TAB_BAR, fabBand: FAB_BAND })
    ).toEqual({ frame: TAB_BAR, content: FAB_BAND });
  });
});

describe('getEmptyStatePresentation', () => {
  it('keeps the full presentation on the first, unmeasured frame', () => {
    expect(getEmptyStatePresentation({ available: null, bottomInset: TAB_BAR })).toBe('full');
  });

  it('keeps the full presentation when the clear region holds the whole state', () => {
    expect(
      getEmptyStatePresentation({
        available: EMPTY_STATE_FULL_HEIGHT + TAB_BAR,
        bottomInset: TAB_BAR,
      })
    ).toBe('full');
  });

  it('switches to the compact presentation when the clear region cannot hold the state', () => {
    // The 420dp-tall landscape capture: the body keeps ~180dp and the 81dp bar
    // leaves ~99dp, far short of the full 184dp state.
    expect(getEmptyStatePresentation({ available: SHORT_AVAILABLE, bottomInset: TAB_BAR })).toBe(
      'compact'
    );
    expect(SHORT_AVAILABLE - TAB_BAR).toBeLessThan(EMPTY_STATE_FULL_HEIGHT);
  });

  it('decides against the inset the surface resolves, not a hard-coded bar', () => {
    // A surface that still inherits the tabs layout's bar + 16dp content gap
    // must pass that larger inset: a body that clears the bar alone is then
    // compact, where the same body clearing the bar's surface is full.
    const clearsBarOnly = EMPTY_STATE_FULL_HEIGHT + TAB_BAR;
    expect(getEmptyStatePresentation({ available: clearsBarOnly, bottomInset: TAB_BAR })).toBe(
      'full'
    );
    expect(
      getEmptyStatePresentation({ available: clearsBarOnly, bottomInset: TAB_BAR + TAB_GAP })
    ).toBe('compact');
  });
});
