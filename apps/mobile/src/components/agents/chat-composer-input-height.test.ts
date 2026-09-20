import { describe, expect, it } from 'vitest';

import {
  COMPOSER_CHROME_HEIGHT,
  COMPOSER_INPUT_MAX_HEIGHT,
  COMPOSER_INPUT_PADDING_HORIZONTAL,
  NEW_SESSION_PROMPT_CHROME_HEIGHT,
  NEW_SESSION_PROMPT_INPUT_MAX_HEIGHT,
  resolveComposerMaxHeight,
  resolveComposerTextContentWidth,
  SESSION_HEADER_HEIGHT,
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
  it('keeps the starter-row reserve out of the new-session prompt budget', () => {
    // The chat composer budget still carries the reserve: 120 + STARTER_ROW_HEIGHT = 232.
    expect(COMPOSER_CHROME_HEIGHT - STARTER_ROW_HEIGHT).toBe(120);
    // The new-session prompt budget carries no reserve, so the keyboard-open cap
    // can reach the input's absolute max instead of flooring at its minimum.
    expect(NEW_SESSION_PROMPT_CHROME_HEIGHT).toBe(176);
  });
});

describe('new-session prompt cap with the keyboard open', () => {
  // The new-session prompt's own geometry (see `new-session-prompt.tsx`):
  // 16pt of vertical padding around 24pt lines.
  const PROMPT_VERTICAL_PADDING = 16;
  const PROMPT_LINE_HEIGHT = 24;
  const PROMPT_MIN_HEIGHT = PROMPT_LINE_HEIGHT * 3 + PROMPT_VERTICAL_PADDING;
  const FOUR_LINE_PROMPT_HEIGHT = PROMPT_LINE_HEIGHT * 4 + PROMPT_VERTICAL_PADDING;

  it('lets a four-line prompt grow past the three-line minimum', () => {
    // Phone-class window (393x852) with the iOS keyboard up and the composer
    // focused. A stale starter-row reserve left only 79pt of remaining space,
    // so the cap floored at the 3-line minimum and clipped the prompt's last
    // line at the input's bottom edge.
    const cap = resolveComposerMaxHeight({
      windowHeight: 852,
      safeAreaInsetTop: 59,
      safeAreaInsetBottom: 34,
      keyboardHeight: 300,
      sessionHeaderHeight: SESSION_HEADER_HEIGHT,
      composerChromeHeight: NEW_SESSION_PROMPT_CHROME_HEIGHT,
      minHeight: PROMPT_MIN_HEIGHT,
      absoluteMaxHeight: NEW_SESSION_PROMPT_INPUT_MAX_HEIGHT,
    });

    expect(cap).toBeGreaterThanOrEqual(FOUR_LINE_PROMPT_HEIGHT);
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
