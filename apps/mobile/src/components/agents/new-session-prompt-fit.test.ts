import { describe, expect, it } from 'vitest';

import { resolveNewSessionPromptMinHeight } from './new-session-prompt-fit';

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
 * frame — its bottom 61px (≈27dp) behind the system bar — with the input at
 * its 3-line floor. The card's own chrome is ~103dp and it starts ~14dp below
 * the frame top.
 */
const EXPLORER = {
  frameHeight: 178,
  cardTop: 14,
  cardChromeHeight: 103,
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
});
