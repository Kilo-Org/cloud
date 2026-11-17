import { describe, expect, it } from 'vitest';

import { resolveNewSessionPromptHeight } from './chat-composer-input-height';
import {
  resolveComposerTopFadeHeight,
  resolveNewSessionFormFrameHeight,
  resolveNewSessionPromptLineCount,
  resolveNewSessionPromptMinHeight,
} from './new-session-prompt-fit';

const LINE_HEIGHT = 24;
const PREFERRED_LINES = 3;
const PREFERRED_MIN_HEIGHT = LINE_HEIGHT * PREFERRED_LINES + 16;

const PREFERRED = {
  preferredMinHeight: PREFERRED_MIN_HEIGHT,
  lineHeight: LINE_HEIGHT,
  preferredLines: PREFERRED_LINES,
} as const;

/**
 * The explorer finding's geometry, in points: the card sat 439px in a 410px
 * frame — its bottom 61px (~27dp) behind the system bar — with the input at its
 * 3-line floor. The card's own chrome is ~103dp and it starts ~14dp below the
 * frame top.
 */
const EXPLORER = {
  frameHeight: 178,
  cardTop: 14,
  cardChromeHeight: 103,
} as const;

/**
 * The Android emulator's frame with the keyboard up, in points: the card starts
 * 16dp below the frame top and its chrome measures 98dp.
 */
const LONG_DRAFT = {
  frameHeight: 339,
  cardTop: 16,
  cardChromeHeight: 98,
} as const;

describe('resolveNewSessionPromptMinHeight', () => {
  it('yields whole lines on the explorer frame so the whole card fits', () => {
    // Precondition: the preferred floor cannot fit, so the defect is present.
    expect(EXPLORER.cardTop + EXPLORER.cardChromeHeight + PREFERRED_MIN_HEIGHT).toBeGreaterThan(
      EXPLORER.frameHeight
    );

    const fitted = resolveNewSessionPromptMinHeight({ ...PREFERRED, ...EXPLORER });

    // 178 - 14 - 103 = 61 available, padding 16 -> one 24pt line: 40.
    expect(fitted).toBe(40);
    expect(fitted).toBeLessThan(PREFERRED_MIN_HEIGHT);
    // The card, at the fitted floor, sits entirely inside the frame.
    expect(EXPLORER.cardTop + EXPLORER.cardChromeHeight + fitted).toBeLessThanOrEqual(
      EXPLORER.frameHeight
    );
  });

  it('yields one line less once the card top gap crosses a whole-line boundary', () => {
    // 195 - 0 - 103 = 92 available: three lines fit, so this frame keeps the
    // preferred floor only because the card top gap is zero. The card really
    // starts ~14pt below the frame top, which leaves 78 -> two lines. Reading
    // the gap as 0 overstates the room by exactly that line.
    const frameHeight = 195;
    const withoutGap = resolveNewSessionPromptMinHeight({
      ...PREFERRED,
      ...EXPLORER,
      frameHeight,
      cardTop: 0,
    });
    const withGap = resolveNewSessionPromptMinHeight({ ...PREFERRED, ...EXPLORER, frameHeight });

    expect(withoutGap).toBe(PREFERRED_MIN_HEIGHT);
    expect(withGap).toBe(PREFERRED_MIN_HEIGHT - LINE_HEIGHT);
  });

  it('always returns a whole number of lines plus the preferred padding', () => {
    const padding = PREFERRED_MIN_HEIGHT - LINE_HEIGHT * PREFERRED_LINES;

    for (const frameHeight of [120, 150, 178, 205, 260, 400]) {
      const fitted = resolveNewSessionPromptMinHeight({ ...PREFERRED, ...EXPLORER, frameHeight });
      expect((fitted - padding) % LINE_HEIGHT).toBe(0);
      expect(fitted).toBeGreaterThanOrEqual(LINE_HEIGHT + padding);
    }
  });

  it('keeps the 3-line start when the frame has room', () => {
    expect(resolveNewSessionPromptMinHeight({ ...PREFERRED, ...EXPLORER, frameHeight: 400 })).toBe(
      PREFERRED_MIN_HEIGHT
    );
  });

  it('never drops below one whole line, even when the frame cannot fit one', () => {
    expect(resolveNewSessionPromptMinHeight({ ...PREFERRED, ...EXPLORER, frameHeight: 100 })).toBe(
      LINE_HEIGHT + (PREFERRED_MIN_HEIGHT - LINE_HEIGHT * PREFERRED_LINES)
    );
  });

  it.each([
    { name: 'an unmeasured frame', overrides: { frameHeight: 0 } },
    { name: 'a non-finite frame', overrides: { frameHeight: Number.NaN } },
    { name: 'an unmeasured chrome', overrides: { cardChromeHeight: 0 } },
    { name: 'a non-positive line height', overrides: { lineHeight: 0 } },
    { name: 'no preferred lines', overrides: { preferredLines: 0 } },
    { name: 'a negative card top', overrides: { cardTop: -1 } },
  ])('returns the preferred floor for $name', ({ overrides }) => {
    expect(resolveNewSessionPromptMinHeight({ ...PREFERRED, ...EXPLORER, ...overrides })).toBe(
      PREFERRED_MIN_HEIGHT
    );
  });

  it('returns the given floor unchanged when it is itself non-positive', () => {
    expect(
      resolveNewSessionPromptMinHeight({ ...PREFERRED, ...EXPLORER, preferredMinHeight: 0 })
    ).toBe(0);
  });

  it('lowers the floor as the frame shrinks and never exceeds the preferred floor', () => {
    const roomy = resolveNewSessionPromptMinHeight({ ...PREFERRED, ...EXPLORER, frameHeight: 260 });
    const tight = resolveNewSessionPromptMinHeight({ ...PREFERRED, ...EXPLORER, frameHeight: 178 });
    const cramped = resolveNewSessionPromptMinHeight({
      ...PREFERRED,
      ...EXPLORER,
      frameHeight: 120,
    });

    expect(roomy).toBeGreaterThanOrEqual(tight);
    expect(tight).toBeGreaterThanOrEqual(cramped);
    expect(roomy).toBeLessThanOrEqual(PREFERRED_MIN_HEIGHT);
  });

  it('a taller error row only lowers the fitted floor', () => {
    // A frame with room for the preferred floor, so adding the error row's
    // height must cross a whole-line boundary instead of clamping to the
    // one-line floor (where plain and error-row results would be equal).
    const frameHeight = 225;
    const plain = resolveNewSessionPromptMinHeight({ ...PREFERRED, ...EXPLORER, frameHeight });
    const withErrorRow = resolveNewSessionPromptMinHeight({
      ...PREFERRED,
      ...EXPLORER,
      frameHeight,
      cardChromeHeight: EXPLORER.cardChromeHeight + 40,
    });

    expect(plain).toBe(PREFERRED_MIN_HEIGHT);
    expect(withErrorRow).toBeLessThan(plain);
    expect(withErrorRow).toBe(PREFERRED_MIN_HEIGHT - LINE_HEIGHT);
    expect(withErrorRow).toBeGreaterThanOrEqual(LINE_HEIGHT + 16);
  });

  it('never yields the floor to the Run on row under the card', () => {
    // The cap gives the row up instead when whole lines cannot hold both (see
    // `resolveNewSessionPromptMaxHeight`); the floor only ever yields to the
    // frame, so the composer keeps its three lines wherever the frame alone
    // has room for them.
    const frameHeight = 280;
    expect(resolveNewSessionPromptMinHeight({ ...PREFERRED, ...LONG_DRAFT, frameHeight })).toBe(
      PREFERRED_MIN_HEIGHT
    );
    expect(
      LONG_DRAFT.cardTop + LONG_DRAFT.cardChromeHeight + PREFERRED_MIN_HEIGHT
    ).toBeLessThanOrEqual(frameHeight);
  });
});

describe('the New Session keyboard destination', () => {
  const frame = {
    containerY: 118,
    containerHeight: 756,
    footerHeight: 221,
    windowHeight: 874,
    keyboardVerticalOffset: 0,
  };

  it('fits the smaller whole-line input before the keyboard reaches its final height', () => {
    const closed = resolveNewSessionFormFrameHeight({ ...frame, keyboardHeight: 0 });
    const opened = resolveNewSessionFormFrameHeight({ ...frame, keyboardHeight: 335 });
    const chrome = { cardTop: 14, cardChromeHeight: 101 };

    expect(closed).toBe(535);
    expect(opened).toBe(200);
    expect(resolveNewSessionPromptMinHeight({ ...PREFERRED, ...chrome, frameHeight: closed })).toBe(
      88
    );
    expect(resolveNewSessionPromptMinHeight({ ...PREFERRED, ...chrome, frameHeight: opened })).toBe(
      64
    );
  });

  it('keeps an already padded Android navigation inset out of the keyboard overlap', () => {
    expect(
      resolveNewSessionFormFrameHeight({
        ...frame,
        keyboardHeight: 335,
        keyboardVerticalOffset: -24,
      })
    ).toBe(224);
  });

  it('subtracts only the keyboard overlap when the form stops above the window bottom', () => {
    expect(
      resolveNewSessionFormFrameHeight({
        ...frame,
        containerY: 100,
        containerHeight: 600,
        footerHeight: 140,
        windowHeight: 900,
        keyboardHeight: 300,
      })
    ).toBe(360);
  });

  it('never gives the input a negative viewport when the footer fills the available space', () => {
    expect(
      resolveNewSessionFormFrameHeight({ ...frame, footerHeight: 700, keyboardHeight: 335 })
    ).toBe(0);
  });
});

describe('resolveComposerTopFadeHeight', () => {
  const LINE = 24;

  it('hides nothing at the top of the field, where no line is cut', () => {
    expect(resolveComposerTopFadeHeight({ scrollOffset: 0, lineHeight: LINE })).toBe(0);
  });

  it('covers the fragment the field clips without reaching the line under it', () => {
    // 1 dp into the line: the fragment is 1 dp of cut glyph tops, and the next
    // whole line starts 23 dp below the edge, so only 1 dp may be masked.
    expect(resolveComposerTopFadeHeight({ scrollOffset: 1, lineHeight: LINE })).toBe(1);
    // 23.9 dp in: the fragment is the last 0.1 dp of a glyph row and the next
    // whole line begins at 0.1 dp, so a one-line fade would wash a readable
    // line. The band is what is left of the fragment.
    expect(resolveComposerTopFadeHeight({ scrollOffset: 23.9, lineHeight: LINE })).toBeCloseTo(
      0.1,
      5
    );
  });

  it('never masks more than half a line', () => {
    for (const intoLine of [6, 12, 18]) {
      expect(
        resolveComposerTopFadeHeight({ scrollOffset: intoLine, lineHeight: LINE })
      ).toBeLessThanOrEqual(LINE / 2);
    }
    // The halfway point is where fragment and remaining line are equal.
    expect(resolveComposerTopFadeHeight({ scrollOffset: 12, lineHeight: LINE })).toBe(12);
  });

  it('uses the position inside the current line across several lines of scroll', () => {
    expect(resolveComposerTopFadeHeight({ scrollOffset: LINE + 4, lineHeight: LINE })).toBe(4);
    expect(resolveComposerTopFadeHeight({ scrollOffset: 3 * LINE + 20, lineHeight: LINE })).toBe(4);
  });

  it('treats an unmeasurable line or offset as no fade', () => {
    expect(resolveComposerTopFadeHeight({ scrollOffset: 8, lineHeight: 0 })).toBe(0);
    expect(resolveComposerTopFadeHeight({ scrollOffset: Number.NaN, lineHeight: LINE })).toBe(0);
  });
});

describe('resolveNewSessionPromptLineCount', () => {
  const NO_KEYBOARD = { keyboardVisible: false, preferredLines: PREFERRED_LINES } as const;

  it('gives the compact cell the one-line floor and enough room for the picker', () => {
    // Measured on the design gate's 360x640 compact cell: the repository
    // picker's bottom edge ended 43.81 points under the form's viewport.
    const OVERFLOW_BELOW_THE_FOLD = 43.81;
    const lineCount = resolveNewSessionPromptLineCount({ ...NO_KEYBOARD, windowHeight: 640 });
    const returned = PREFERRED_MIN_HEIGHT - resolveNewSessionPromptHeight(LINE_HEIGHT, lineCount);

    expect(lineCount).toBe(1);
    // The precondition: the preferred floor is what pushed the picker under the
    // viewport, and the two lines it gives back clear the overflow.
    expect(returned).toBe(LINE_HEIGHT * 2);
    expect(returned).toBeGreaterThan(OVERFLOW_BELOW_THE_FOLD);
  });

  it('keeps the preferred floor from the shortest window that holds the whole form', () => {
    expect(resolveNewSessionPromptLineCount({ ...NO_KEYBOARD, windowHeight: 683 })).toBe(1);
    expect(resolveNewSessionPromptLineCount({ ...NO_KEYBOARD, windowHeight: 684 })).toBe(
      PREFERRED_LINES
    );
    // The design gate's base and dark cells, and the shipped phones.
    expect(resolveNewSessionPromptLineCount({ ...NO_KEYBOARD, windowHeight: 891 })).toBe(
      PREFERRED_LINES
    );
  });

  it('leaves the fit to the shrinking frame while the keyboard is up', () => {
    // A tall phone with its keyboard up reports a short window; pinning the
    // composer to one line there would be a regression, not a fit.
    expect(
      resolveNewSessionPromptLineCount({
        windowHeight: 530,
        keyboardVisible: true,
        preferredLines: PREFERRED_LINES,
      })
    ).toBe(PREFERRED_LINES);
  });

  it('keeps the preferred floor for an unknown window', () => {
    for (const windowHeight of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveNewSessionPromptLineCount({ ...NO_KEYBOARD, windowHeight })).toBe(
        PREFERRED_LINES
      );
    }
  });
});

describe('the shipped phone geometry with the keyboard up', () => {
  /**
   * The Android emulator (1080x2400 at 420dpi) with its keyboard up: the form
   * frame reports 339pt, the card starts 14pt below the frame top and its own
   * chrome measures 101.33pt. The floor alone fits, so the composer keeps its
   * three lines there and a longer draft scrolls inside them.
   */
  it('keeps the 3-line floor on a phone frame with the keyboard up', () => {
    expect(
      resolveNewSessionPromptMinHeight({
        ...PREFERRED,
        frameHeight: 339,
        cardTop: 14,
        cardChromeHeight: 101.33,
      })
    ).toBe(PREFERRED_MIN_HEIGHT);
  });
});
