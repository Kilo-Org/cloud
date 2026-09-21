import { describe, expect, it } from 'vitest';

import {
  COMPOSER_CHROME_HEIGHT,
  COMPOSER_INPUT_MAX_HEIGHT,
  COMPOSER_INPUT_PADDING_HORIZONTAL,
  NEW_SESSION_PROMPT_CHROME_HEIGHT,
  NEW_SESSION_PROMPT_DEFAULT_LINES,
  NEW_SESSION_PROMPT_INPUT_MAX_HEIGHT,
  NEW_SESSION_PROMPT_LINE_HEIGHT,
  resolveComposerMaxHeight,
  resolveComposerTextContentWidth,
  resolveNewSessionPromptHeight,
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
  // The new-session prompt's own geometry, imported from the same module
  // `new-session-prompt.tsx` reads: 16pt of vertical padding around 24pt lines,
  // starting at a three-line minimum. A four-line prompt is the reported
  // regression case, not a production default.
  const PROMPT_MIN_HEIGHT = resolveNewSessionPromptHeight(
    NEW_SESSION_PROMPT_LINE_HEIGHT,
    NEW_SESSION_PROMPT_DEFAULT_LINES
  );
  const FOUR_LINE_PROMPT_HEIGHT = resolveNewSessionPromptHeight(NEW_SESSION_PROMPT_LINE_HEIGHT, 4);
  // The reported device (iOS 393x852) with the keyboard up, at the keyboard
  // height the shared cap args above already use.
  const REPORTED_DEVICE_CAP_ARGS = {
    windowHeight: 852,
    safeAreaInsetTop: 59,
    safeAreaInsetBottom: 34,
    keyboardHeight: 336,
    sessionHeaderHeight: SESSION_HEADER_HEIGHT,
    composerChromeHeight: NEW_SESSION_PROMPT_CHROME_HEIGHT,
    minHeight: PROMPT_MIN_HEIGHT,
    absoluteMaxHeight: NEW_SESSION_PROMPT_INPUT_MAX_HEIGHT,
  } as const;

  // `useTextHeight` publishes the measured content clamped into
  // `[minHeight, maxHeight]`; that published height is the input's frame.
  const frameHeight = (contentHeight: number, cap: number) =>
    Math.min(Math.max(contentHeight, PROMPT_MIN_HEIGHT), cap);

  it('lets a four-line prompt grow past the three-line minimum', () => {
    // A stale starter-row reserve left only 43pt of remaining space here, so
    // the cap floored at the 3-line minimum and clipped the prompt's last line
    // at the input's bottom edge.
    const cap = resolveComposerMaxHeight(REPORTED_DEVICE_CAP_ARGS);

    expect(cap).toBeGreaterThanOrEqual(FOUR_LINE_PROMPT_HEIGHT);
  });

  it('holds all four wrapped lines on the reported device with the keyboard up', () => {
    // The reported defect: the last line ('when done') was cut off at the
    // input's bottom edge because the frame was clamped below the content.
    const cap = resolveComposerMaxHeight(REPORTED_DEVICE_CAP_ARGS);

    expect(frameHeight(FOUR_LINE_PROMPT_HEIGHT, cap)).toBe(FOUR_LINE_PROMPT_HEIGHT);
  });

  it('still starts the empty prompt at the three-line minimum', () => {
    const cap = resolveComposerMaxHeight(REPORTED_DEVICE_CAP_ARGS);

    expect(frameHeight(PROMPT_MIN_HEIGHT, cap)).toBe(PROMPT_MIN_HEIGHT);
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
