import { describe, expect, it } from 'vitest';

import {
  alignComposerInputHeightToLines,
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

describe('alignComposerInputHeightToLines', () => {
  // The composer input's own geometry: 20pt lines and 24pt of vertical padding.
  // `TEXT_INPUT_VERTICAL_PADDING` is not font-scaled (see `chat-composer.tsx`),
  // so the aligned cap is a whole number of scaled lines plus a flat 24.
  const LINE_HEIGHT = 20;
  const VERTICAL_PADDING = 24;

  const capArgsFor = (windowHeight: number, fontScale: number) =>
    ({
      windowHeight,
      safeAreaInsetTop: 0,
      safeAreaInsetBottom: 0,
      keyboardHeight: 0,
      sessionHeaderHeight: 0,
      composerChromeHeight: 0,
      minHeight: LINE_HEIGHT * fontScale + VERTICAL_PADDING,
      absoluteMaxHeight: 1000,
    }) as const;

  const align = (height: number, fontScale: number) => {
    const lineHeight = LINE_HEIGHT * fontScale;
    return alignComposerInputHeightToLines({
      height,
      lineHeight,
      verticalPadding: VERTICAL_PADDING,
      minHeight: lineHeight + VERTICAL_PADDING,
    });
  };

  // Window heights whose remaining space leaves a raw cap of 62, 98, and 117
  // points at fontScale 1: the capped composer in the report measured 117dp,
  // not a whole number of lines, so Android scrolled to the caret by a partial
  // line and the draft's first line was cut by the input's top edge.
  it.each([62, 98, 117])(
    'snaps a %ipt cap to a whole number of lines at fontScale 1',
    windowHeight => {
      const cap = resolveComposerMaxHeight(capArgsFor(windowHeight, 1));
      // Precondition: the raw remaining-space cap is not line-aligned.
      expect((cap - VERTICAL_PADDING) % LINE_HEIGHT).not.toBe(0);

      const aligned = align(cap, 1);

      expect((aligned - VERTICAL_PADDING) % LINE_HEIGHT).toBe(0);
      expect(aligned).toBeLessThanOrEqual(cap);
      expect(aligned).toBeGreaterThanOrEqual(LINE_HEIGHT + VERTICAL_PADDING);
    }
  );

  it.each([1.5, 2])(
    'snaps a 117pt cap to a whole number of scaled lines at fontScale %s',
    fontScale => {
      const cap = resolveComposerMaxHeight(capArgsFor(117, fontScale));

      const aligned = align(cap, fontScale);

      expect((aligned - VERTICAL_PADDING) % (LINE_HEIGHT * fontScale)).toBe(0);
      expect(aligned).toBeLessThanOrEqual(cap);
      expect(aligned).toBeGreaterThanOrEqual(LINE_HEIGHT * fontScale + VERTICAL_PADDING);
    }
  );

  it('keeps the largest line-aligned height at or below the raw cap', () => {
    // 117 -> 4 lines + padding = 104, the largest whole-line height under 117.
    expect(align(117, 1)).toBe(104);
    expect(align(98, 1)).toBe(84);
    expect(align(62, 1)).toBe(44);
  });

  it('never falls below the minimum height', () => {
    expect(align(30, 1)).toBe(LINE_HEIGHT + VERTICAL_PADDING);
    expect(align(LINE_HEIGHT + VERTICAL_PADDING, 1)).toBe(LINE_HEIGHT + VERTICAL_PADDING);
  });

  it('leaves an already line-aligned cap unchanged', () => {
    expect(align(124, 1)).toBe(124);
  });

  it('returns the height unchanged when the geometry is degenerate', () => {
    expect(
      alignComposerInputHeightToLines({
        height: 117,
        lineHeight: 0,
        verticalPadding: VERTICAL_PADDING,
        minHeight: 44,
      })
    ).toBe(117);
    expect(
      alignComposerInputHeightToLines({
        height: 117,
        lineHeight: LINE_HEIGHT,
        verticalPadding: 0,
        minHeight: 44,
      })
    ).toBe(117);
  });
});
