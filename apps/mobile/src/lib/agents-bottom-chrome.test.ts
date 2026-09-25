import { describe, expect, it } from 'vitest';

import {
  getAgentsListBottomInset,
  getEmptyStateFullHeight,
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
// The gap a scrolled-content surface reserves below the bar. The tabs layout
// keeps it content-only, but a surface that did reserve it must be measured
// against that larger inset (see `getEmptyStatePresentation`).
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

describe('getEmptyStateFullHeight', () => {
  it('builds the state from the app’s 14pt rem, not a 16pt one', () => {
    // bubble h-14 (49) + gap-4 (14) + text-lg line (24.5) + gap-1 (3.5) + a
    // text-sm description line (17.5) + gap-4 (14) + the 44px action.
    expect(getEmptyStateFullHeight({ descriptionLines: 1 })).toBe(167);
  });

  it('reserves the two-line description the live empty state actually renders', () => {
    // `agents.sessionList.noSessionsYetDescription` is longer than one phone
    // line, so the state on screen is one text line taller.
    expect(getEmptyStateFullHeight()).toBe(184);
    expect(getEmptyStateFullHeight({ descriptionLines: 2 })).toBeGreaterThan(
      getEmptyStateFullHeight({ descriptionLines: 1 })
    );
  });

  it('counts a title line as well as the description lines', () => {
    expect(getEmptyStateFullHeight({ titleLines: 2 })).toBe(209);
    expect(getEmptyStateFullHeight({ titleLines: 2 })).toBeGreaterThan(
      getEmptyStateFullHeight({ titleLines: 1 })
    );
  });

  it('grows the state with Dynamic Type, counting the copy re-wrapping', () => {
    // The title wraps to two lines and the two-line description to four at
    // scale 2, so the text blocks grow with the square of the scale. A
    // scale-only estimate that held the line counts fixed was 249dp here and
    // under-estimated the rendered state by a whole text line.
    expect(getEmptyStateFullHeight({ fontScale: 2 })).toBe(368);
    expect(getEmptyStateFullHeight({ fontScale: 2 })).toBeGreaterThan(
      getEmptyStateFullHeight({ fontScale: 1 })
    );
  });
});

describe('getEmptyStatePresentation', () => {
  it('keeps the full presentation on the first, unmeasured frame', () => {
    expect(getEmptyStatePresentation({ available: null, bottomInset: TAB_BAR })).toBe('full');
  });

  it('keeps the full presentation when the clear region holds the whole state', () => {
    expect(
      getEmptyStatePresentation({
        available: getEmptyStateFullHeight() + TAB_BAR,
        bottomInset: TAB_BAR,
      })
    ).toBe('full');
  });

  it('switches to the compact presentation when the clear region cannot hold the state', () => {
    // The 420dp-tall landscape capture: the body keeps ~180dp; the 81dp bar
    // and the 72dp FAB band leave ~27dp, far short of the full state.
    expect(
      getEmptyStatePresentation({ available: SHORT_AVAILABLE, bottomInset: TAB_BAR + FAB_BAND })
    ).toBe('compact');
    expect(SHORT_AVAILABLE - TAB_BAR).toBeLessThan(getEmptyStateFullHeight());
  });

  it('decides against the inset the surface resolves, not a hard-coded bar', () => {
    // A surface that still inherits the tabs layout's bar + 16dp content gap
    // must pass that larger inset: a body that clears the bar alone is then
    // compact, where the same body clearing the bar's surface is full.
    const clearsBarOnly = getEmptyStateFullHeight() + TAB_BAR;
    expect(getEmptyStatePresentation({ available: clearsBarOnly, bottomInset: TAB_BAR })).toBe(
      'full'
    );
    expect(
      getEmptyStatePresentation({ available: clearsBarOnly, bottomInset: TAB_BAR + TAB_GAP })
    ).toBe('compact');
  });

  it('counts the FAB band while the FAB shows, so a centered action cannot sit under it', () => {
    // The same body that holds the whole state above the bar alone must go
    // compact once its surface also reserves the FAB band: the state's
    // full-width action would otherwise reach into the band the corner button
    // overlays (the load-failure Retry, the boundary's back-to-profile).
    const holdsBarState = getEmptyStateFullHeight() + TAB_BAR;
    expect(getEmptyStatePresentation({ available: holdsBarState, bottomInset: TAB_BAR })).toBe(
      'full'
    );
    expect(
      getEmptyStatePresentation({ available: holdsBarState, bottomInset: TAB_BAR + FAB_BAND })
    ).toBe('compact');
  });

  it('compacts a clear region that holds the state at the base scale once the text grows', () => {
    const atScale1 = getEmptyStateFullHeight({ fontScale: 1 });
    const atScale2 = getEmptyStateFullHeight({ fontScale: 2 });
    const clearsScale1 = atScale1 + TAB_BAR;
    expect(
      getEmptyStatePresentation({ available: clearsScale1, bottomInset: TAB_BAR, fontScale: 1 })
    ).toBe('full');
    expect(
      getEmptyStatePresentation({ available: clearsScale1, bottomInset: TAB_BAR, fontScale: 2 })
    ).toBe('compact');
    expect(
      getEmptyStatePresentation({
        available: atScale2 + TAB_BAR,
        bottomInset: TAB_BAR,
        fontScale: 2,
      })
    ).toBe('full');
  });

  it('subtracts the reserved refresh line the band publishes', () => {
    // Reduced motion reserves `RefreshProgress`'s h-9 box (31.5dp) above the
    // children, so a body that holds the full state with no reserve no longer
    // holds it: ignoring the reserve kept the full form in a band that could
    // not fit it (reduced-motion users only).
    const holdsFullState = getEmptyStateFullHeight() + TAB_BAR;
    expect(getEmptyStatePresentation({ available: holdsFullState, bottomInset: TAB_BAR })).toBe(
      'full'
    );
    expect(
      getEmptyStatePresentation({
        available: holdsFullState + 31.5 - 1,
        bottomInset: TAB_BAR,
        reservedHeight: 31.5,
      })
    ).toBe('compact');
    expect(
      getEmptyStatePresentation({
        available: holdsFullState + 31.5,
        bottomInset: TAB_BAR,
        reservedHeight: 31.5,
      })
    ).toBe('full');
  });
});
