import { describe, expect, it } from 'vitest';

import { getAgentsListBottomInset, SESSION_ROW_PITCH } from '@/lib/agents-bottom-chrome';

const TAB_BAR = 81;
const FAB_BAND = 56 + 16;
const FULL_BAND = TAB_BAR + FAB_BAND;

describe('getAgentsListBottomInset', () => {
  it('keeps the whole band on the frame before the first layout', () => {
    expect(
      getAgentsListBottomInset({ available: null, tabBarHeight: TAB_BAR, fabBand: FAB_BAND })
    ).toEqual({ frame: FULL_BAND, content: 0 });
  });

  it('keeps the whole band on the frame in a tall window', () => {
    expect(
      getAgentsListBottomInset({ available: 900, tabBarHeight: TAB_BAR, fabBand: FAB_BAND })
    ).toEqual({ frame: FULL_BAND, content: 0 });
  });

  it('clamps the frame to one row pitch in a short window and hands the rest to the content', () => {
    const available = 180;
    const inset = getAgentsListBottomInset({
      available,
      tabBarHeight: TAB_BAR,
      fabBand: FAB_BAND,
    });
    expect(inset.frame).toBe(available - SESSION_ROW_PITCH);
    expect(inset.content).toBe(FULL_BAND - (available - SESSION_ROW_PITCH));
    expect(inset.frame + inset.content).toBe(FULL_BAND);
    expect(inset.frame).toBeGreaterThanOrEqual(TAB_BAR);
  });

  it('never yields the tab bar when the window is shorter than the bar alone', () => {
    const inset = getAgentsListBottomInset({
      available: TAB_BAR - 10,
      tabBarHeight: TAB_BAR,
      fabBand: FAB_BAND,
    });
    expect(inset.frame).toBe(TAB_BAR);
    expect(inset.content).toBe(FAB_BAND);
  });
});
