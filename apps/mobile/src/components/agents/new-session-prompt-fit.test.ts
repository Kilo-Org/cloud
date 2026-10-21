import { describe, expect, it } from 'vitest';

import {
  resolveNewSessionPromptFrameFit,
  resolveNewSessionPromptMaxHeight,
  resolveNewSessionPromptMinHeight,
} from './new-session-prompt-fit';

const LINE_HEIGHT = 24;
const PREFERRED_LINES = 3;
const PREFERRED_MIN_HEIGHT = LINE_HEIGHT * PREFERRED_LINES + 16;
const VERTICAL_PADDING = 16;

const PREFERRED = {
  preferredMinHeight: PREFERRED_MIN_HEIGHT,
  lineHeight: LINE_HEIGHT,
  preferredLines: PREFERRED_LINES,
} as const;

/**
 * The explorer finding's geometry, in points: the card sat 439px in a 410px
 * frame — its bottom 61px (≈27dp) behind the system bar — with the input at
 * its 3-line floor. The card's own chrome is ~103dp and it starts ~14dp below
 * the frame top.
 */
const EXPLORER = {
  frameHeight: 178,
  cardTop: 14,
  cardChromeHeight: 103,
} as const;

/**
 * The long-draft geometry of the Run on finding, in points, for the Run on row
 * alone: the card starts 16dp below the frame top, its chrome measures 98dp,
 * and the row (`mt-5` 20 + label 18 + `mb-2` 8 + the 44dp selector) is 89dp.
 * The 339dp frame is the Android emulator's with the keyboard up. The window
 * cap put the input at its 160dp maximum, which fills the frame and cuts the
 * selector when the block under the card is only this row.
 */
const LONG_DRAFT = {
  frameHeight: 339,
  cardTop: 16,
  cardChromeHeight: 98,
  belowCardHeight: 89,
} as const;

const WINDOW_MAX_HEIGHT = 160;
/** One line of air the fit keeps under the Run on block. */
const CLEARANCE = LINE_HEIGHT;

/**
 * The same finding on the iPhone lane, in points: with the keyboard up the
 * new-session frame measures 256pt tall and the card starts 14pt down, with
 * 101.33pt of card chrome and an 86pt Run on block under it. Whole lines cannot
 * hold the 3-line composer and that block at once, so the cap keeps the floor
 * and lets the block scroll into view.
 */
const IPHONE_KEYBOARD = {
  frameHeight: 256,
  cardTop: 14,
  cardChromeHeight: 101.33,
  belowCardHeight: 86,
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

describe('resolveNewSessionPromptFrameFit', () => {
  it('returns the whole-line room the frame leaves below the card and the row', () => {
    // 339 - 16 - 98 - 89 = 136 available, padding 16 -> five 24pt lines: 136.
    expect(
      resolveNewSessionPromptFrameFit({
        ...LONG_DRAFT,
        lineHeight: LINE_HEIGHT,
        verticalPadding: VERTICAL_PADDING,
      })
    ).toBe(136);
  });

  it('takes the requested clearance out of that room', () => {
    const room = resolveNewSessionPromptFrameFit({
      ...LONG_DRAFT,
      lineHeight: LINE_HEIGHT,
      verticalPadding: VERTICAL_PADDING,
    });
    const withClearance = resolveNewSessionPromptFrameFit({
      ...LONG_DRAFT,
      clearanceHeight: CLEARANCE,
      lineHeight: LINE_HEIGHT,
      verticalPadding: VERTICAL_PADDING,
    });

    // Five lines become four: the clearance is a whole line off the room.
    expect(room).toBe(5 * LINE_HEIGHT + VERTICAL_PADDING);
    expect(withClearance).toBe(4 * LINE_HEIGHT + VERTICAL_PADDING);
  });

  it('never returns fewer than one line, even when the frame cannot fit one', () => {
    expect(
      resolveNewSessionPromptFrameFit({
        ...LONG_DRAFT,
        frameHeight: 120,
        lineHeight: LINE_HEIGHT,
        verticalPadding: VERTICAL_PADDING,
      })
    ).toBe(LINE_HEIGHT + VERTICAL_PADDING);
  });

  it.each([
    { name: 'an unmeasured frame', overrides: { frameHeight: 0 } },
    { name: 'a non-finite frame', overrides: { frameHeight: Number.NaN } },
    { name: 'an unmeasured chrome', overrides: { cardChromeHeight: 0 } },
    { name: 'an unmeasured row', overrides: { belowCardHeight: Number.NaN } },
    { name: 'a negative row', overrides: { belowCardHeight: -1 } },
    { name: 'a non-positive line height', overrides: { lineHeight: 0 } },
    { name: 'a negative card top', overrides: { cardTop: -1 } },
  ])('reports $name as unmeasured', ({ overrides }) => {
    expect(
      resolveNewSessionPromptFrameFit({
        ...LONG_DRAFT,
        lineHeight: LINE_HEIGHT,
        verticalPadding: VERTICAL_PADDING,
        ...overrides,
      })
    ).toBeNull();
  });

  it('reserves nothing below the card when no row is measured', () => {
    const withRow = resolveNewSessionPromptFrameFit({
      ...LONG_DRAFT,
      lineHeight: LINE_HEIGHT,
      verticalPadding: VERTICAL_PADDING,
    });
    const withoutRow = resolveNewSessionPromptFrameFit({
      ...LONG_DRAFT,
      belowCardHeight: 0,
      lineHeight: LINE_HEIGHT,
      verticalPadding: VERTICAL_PADDING,
    });

    // Without the row: 339 - 16 - 98 = 225 available, padding 16 -> eight
    // 24pt lines (208); with the row's 89dp: 136 available -> five lines (136).
    expect(withoutRow).toBe(LINE_HEIGHT * 8 + VERTICAL_PADDING);
    expect(withRow).toBe(LINE_HEIGHT * 5 + VERTICAL_PADDING);
  });
});

describe('resolveNewSessionPromptMaxHeight', () => {
  it('keeps the window cap when the frame has room for it', () => {
    expect(
      resolveNewSessionPromptMaxHeight({
        ...LONG_DRAFT,
        frameHeight: 900,
        preferredMaxHeight: WINDOW_MAX_HEIGHT,
        minHeight: PREFERRED_MIN_HEIGHT,
        lineHeight: LINE_HEIGHT,
        verticalPadding: VERTICAL_PADDING,
      })
    ).toBe(WINDOW_MAX_HEIGHT);
  });

  it('caps a long draft so the card and the Run on row stay inside the frame', () => {
    // Precondition: the window-only cap overflows the frame by exactly the
    // selector sliver the finding reported.
    expect(
      LONG_DRAFT.cardTop +
        LONG_DRAFT.cardChromeHeight +
        WINDOW_MAX_HEIGHT +
        LONG_DRAFT.belowCardHeight
    ).toBeGreaterThan(LONG_DRAFT.frameHeight);

    const capped = resolveNewSessionPromptMaxHeight({
      ...LONG_DRAFT,
      preferredMaxHeight: WINDOW_MAX_HEIGHT,
      minHeight: resolveNewSessionPromptMinHeight({ ...PREFERRED, ...LONG_DRAFT }),
      lineHeight: LINE_HEIGHT,
      verticalPadding: VERTICAL_PADDING,
    });

    expect(capped).toBe(112);
    expect(capped).toBeLessThan(WINDOW_MAX_HEIGHT);
    expect(
      LONG_DRAFT.cardTop + LONG_DRAFT.cardChromeHeight + capped + LONG_DRAFT.belowCardHeight
    ).toBeLessThanOrEqual(LONG_DRAFT.frameHeight - CLEARANCE);
  });

  it('keeps the floor and drops the block when the frame cannot hold both', () => {
    const minHeight = resolveNewSessionPromptMinHeight({ ...PREFERRED, ...IPHONE_KEYBOARD });
    const capped = resolveNewSessionPromptMaxHeight({
      ...IPHONE_KEYBOARD,
      preferredMaxHeight: WINDOW_MAX_HEIGHT,
      minHeight,
      lineHeight: LINE_HEIGHT,
      verticalPadding: VERTICAL_PADDING,
    });

    // The frame alone still has room for the three-line floor, so the floor
    // stands and the card alone is capped...
    expect(minHeight).toBe(PREFERRED_MIN_HEIGHT);
    expect(capped).toBeGreaterThanOrEqual(minHeight);
    expect(IPHONE_KEYBOARD.cardTop + IPHONE_KEYBOARD.cardChromeHeight + capped).toBeLessThanOrEqual(
      IPHONE_KEYBOARD.frameHeight
    );
    // ...which is the accepted trade: the Run on block then sits past the
    // frame's bottom edge and scrolls into view.
    expect(
      IPHONE_KEYBOARD.cardTop +
        IPHONE_KEYBOARD.cardChromeHeight +
        capped +
        IPHONE_KEYBOARD.belowCardHeight
    ).toBeGreaterThan(IPHONE_KEYBOARD.frameHeight);
  });

  it('never caps below the floor the input already renders at', () => {
    const minHeight = PREFERRED_MIN_HEIGHT;
    const capped = resolveNewSessionPromptMaxHeight({
      ...LONG_DRAFT,
      frameHeight: 200,
      preferredMaxHeight: WINDOW_MAX_HEIGHT,
      minHeight,
      lineHeight: LINE_HEIGHT,
      verticalPadding: VERTICAL_PADDING,
    });

    expect(capped).toBe(minHeight);
  });

  it.each([
    { name: 'an unmeasured frame', overrides: { frameHeight: 0 } },
    { name: 'an unmeasured row', overrides: { belowCardHeight: Number.NaN } },
  ])('keeps the window cap for $name', ({ overrides }) => {
    expect(
      resolveNewSessionPromptMaxHeight({
        ...LONG_DRAFT,
        preferredMaxHeight: WINDOW_MAX_HEIGHT,
        minHeight: PREFERRED_MIN_HEIGHT,
        lineHeight: LINE_HEIGHT,
        verticalPadding: VERTICAL_PADDING,
        ...overrides,
      })
    ).toBe(WINDOW_MAX_HEIGHT);
  });

  it.each([Number.NaN, 0])('returns an unusable window cap (%s) unchanged', cap => {
    expect(
      resolveNewSessionPromptMaxHeight({
        ...LONG_DRAFT,
        preferredMaxHeight: cap,
        minHeight: PREFERRED_MIN_HEIGHT,
        lineHeight: LINE_HEIGHT,
        verticalPadding: VERTICAL_PADDING,
      })
    ).toBe(cap);
  });
});
