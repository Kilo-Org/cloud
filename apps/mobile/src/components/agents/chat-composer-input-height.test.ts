import { describe, expect, it } from 'vitest';

import {
  COMPOSER_CHROME_HEIGHT,
  COMPOSER_INPUT_MAX_HEIGHT,
  COMPOSER_INPUT_PADDING_HORIZONTAL,
  NEW_SESSION_PROMPT_CARD_CHROME_HEIGHT,
  NEW_SESSION_PROMPT_CHROME_HEIGHT,
  NEW_SESSION_PROMPT_INPUT_MAX_HEIGHT,
  resolveComposerMaxHeight,
  resolveComposerMinHeight,
  resolveComposerTextContentWidth,
  shouldEnableComposerInputScroll,
  STARTER_ROW_HEIGHT,
} from './chat-composer-input-height';

const MIN = 44;
const MAX = 124;

const MAX_HEIGHT_ARGS = {
  windowHeight: 1000,
  safeAreaInsetTop: 44,
  safeAreaInsetBottom: 34,
  keyboardHeight: 336,
  sessionHeaderHeight: 92,
  composerChromeHeight: 120,
  minHeight: MIN,
  absoluteMaxHeight: 1000,
} as const;

describe('shouldEnableComposerInputScroll', () => {
  it('is true at or above max and false below', () => {
    expect(shouldEnableComposerInputScroll(MAX, MAX)).toBe(true);
    expect(shouldEnableComposerInputScroll(MAX + 1, MAX)).toBe(true);
    expect(shouldEnableComposerInputScroll(MAX - 1, MAX)).toBe(false);
    expect(shouldEnableComposerInputScroll(MIN, MAX)).toBe(false);
  });
});

describe('resolveComposerTextContentWidth', () => {
  it('subtracts the wrapper border and the input padding from the measured width', () => {
    expect(resolveComposerTextContentWidth(300)).toBe(266);
  });

  it('measures narrower than padding alone, so a boundary word cannot fit the mirror but not the input', () => {
    expect(resolveComposerTextContentWidth(300)).toBeLessThan(
      300 - COMPOSER_INPUT_PADDING_HORIZONTAL * 2
    );
  });
});

describe('composer chrome budgets', () => {
  it('reserve the starter-row height inside both chrome budgets', () => {
    // 120 (composer chrome) + STARTER_ROW_HEIGHT = 176, and 176 + STARTER_ROW_HEIGHT = 232.
    expect(COMPOSER_CHROME_HEIGHT - STARTER_ROW_HEIGHT).toBe(120);
    expect(NEW_SESSION_PROMPT_CHROME_HEIGHT - STARTER_ROW_HEIGHT).toBe(176);
  });

  it('keeps the new-session prompt card chrome the input must not squeeze out', () => {
    // pt-4 (16) + card pt-2 (8) + control row (44) + toolbar (57).
    expect(NEW_SESSION_PROMPT_CARD_CHROME_HEIGHT).toBe(125);
  });
});

describe('resolveComposerMaxHeight', () => {
  it('subtracts safe areas, keyboard, header, and chrome from the window height', () => {
    // 1000 - 44 - 34 - 336 - 92 - 120 = 374
    expect(resolveComposerMaxHeight(MAX_HEIGHT_ARGS)).toBe(374);
  });

  it('caps the input below the remaining space', () => {
    // A tall window with no keyboard leaves 1000 - 44 - 34 - 92 - 120 = 710,
    // but the absolute cap bounds it so the input cannot fill the screen.
    expect(
      resolveComposerMaxHeight({ ...MAX_HEIGHT_ARGS, keyboardHeight: 0, absoluteMaxHeight: MAX })
    ).toBe(MAX);
  });

  it('exposes the chat and new-session caps', () => {
    expect(COMPOSER_INPUT_MAX_HEIGHT).toBe(124);
    expect(NEW_SESSION_PROMPT_INPUT_MAX_HEIGHT).toBe(160);
  });

  it('floors at minHeight when the remaining space is smaller', () => {
    expect(
      resolveComposerMaxHeight({
        ...MAX_HEIGHT_ARGS,
        windowHeight: 400,
        keyboardHeight: 100,
      })
    ).toBe(MIN);
  });

  it('never returns a negative height on a degenerate window', () => {
    expect(
      resolveComposerMaxHeight({
        ...MAX_HEIGHT_ARGS,
        windowHeight: 300,
        keyboardHeight: 400,
      })
    ).toBe(MIN);
  });
});

const MIN_HEIGHT_ARGS = {
  windowHeight: 1000,
  safeAreaInsetTop: 44,
  safeAreaInsetBottom: 34,
  keyboardHeight: 336,
  sessionHeaderHeight: 92,
  composerChromeHeight: NEW_SESSION_PROMPT_CARD_CHROME_HEIGHT,
  lineHeight: 24,
  verticalPadding: 16,
  defaultLines: 3,
} as const;

describe('resolveComposerMinHeight', () => {
  it('returns the three-line default when the viewport has room', () => {
    // 1000 - 44 - 34 - 336 - 92 - 125 = 369; floor((369 - 16) / 24) = 14 -> clamped to 3 lines.
    expect(resolveComposerMinHeight(MIN_HEIGHT_ARGS)).toBe(88);
  });

  it('drops to one line on the reported landscape viewport', () => {
    // 308 - 24 - 0 - 48 - 92 - 125 = 19; floor((19 - 16) / 24) = 0 -> floored at 1 line.
    expect(
      resolveComposerMinHeight({
        ...MIN_HEIGHT_ARGS,
        windowHeight: 308,
        safeAreaInsetTop: 24,
        safeAreaInsetBottom: 0,
        keyboardHeight: 48,
      })
    ).toBe(40);
  });

  it('drops to two lines when two lines still fit', () => {
    // 358 - 24 - 0 - 48 - 92 - 125 = 69; floor((69 - 16) / 24) = 2.
    expect(
      resolveComposerMinHeight({
        ...MIN_HEIGHT_ARGS,
        windowHeight: 358,
        safeAreaInsetTop: 24,
        safeAreaInsetBottom: 0,
        keyboardHeight: 48,
      })
    ).toBe(64);
  });

  it('never returns a negative or zero height on a degenerate window', () => {
    // The keyboard alone exceeds the window; the floor is one whole line.
    expect(
      resolveComposerMinHeight({
        ...MIN_HEIGHT_ARGS,
        windowHeight: 200,
        safeAreaInsetTop: 24,
        safeAreaInsetBottom: 0,
        keyboardHeight: 400,
      })
    ).toBe(40);
  });

  it('snaps to whole lines at a scaled line height', () => {
    // floor((369 - 16) / 32) = 11 -> clamped to 3 lines of 32 + 16 padding.
    expect(resolveComposerMinHeight({ ...MIN_HEIGHT_ARGS, lineHeight: 32 })).toBe(112);
  });
});
