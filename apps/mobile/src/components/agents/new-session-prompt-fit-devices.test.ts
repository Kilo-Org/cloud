import { describe, expect, it } from 'vitest';

import {
  resolveNewSessionPromptMaxHeight,
  resolveNewSessionPromptMinHeight,
} from './new-session-prompt-fit';

const LINE_HEIGHT = 24;
const PREFERRED_MIN_HEIGHT = LINE_HEIGHT * 3 + 16;
const VERTICAL_PADDING = 16;
const WINDOW_MAX_HEIGHT = 160;
/** One line of air the fit keeps under the Run on block. */
const CLEARANCE = LINE_HEIGHT;

/**
 * The shipped new-session screen on the Android emulator (1080x2400 at 420dpi),
 * measured by the prompt itself with a 3000-character draft and the keyboard
 * up: frame 339dp, card top 14dp, card chrome 101.33dp, and the block under the
 * card 167dp — the Organization section (80dp) above the Run on row (89dp).
 */
const ANDROID_KEYBOARD = {
  frameHeight: 339,
  cardTop: 14,
  cardChromeHeight: 101.33,
  belowCardHeight: 167,
} as const;

describe('the new-session frame fit on the shipped phone geometry', () => {
  it('keeps the floor and leaves the block to the form drag on a phone frame', () => {
    const minHeight = resolveNewSessionPromptMinHeight({
      frameHeight: ANDROID_KEYBOARD.frameHeight,
      cardTop: ANDROID_KEYBOARD.cardTop,
      cardChromeHeight: ANDROID_KEYBOARD.cardChromeHeight,
      preferredMinHeight: PREFERRED_MIN_HEIGHT,
      lineHeight: LINE_HEIGHT,
      preferredLines: 3,
    });
    const capAt = (frameHeight: number) =>
      resolveNewSessionPromptMaxHeight({
        ...ANDROID_KEYBOARD,
        frameHeight,
        preferredMaxHeight: WINDOW_MAX_HEIGHT,
        minHeight,
        lineHeight: LINE_HEIGHT,
        verticalPadding: VERTICAL_PADDING,
      });
    const cardBottom = ANDROID_KEYBOARD.cardTop + ANDROID_KEYBOARD.cardChromeHeight;

    // The block needs a 394.33dp frame beside the floor, so the phone frame
    // keeps the floor and the cap is the window cap again...
    expect(cardBottom + minHeight + ANDROID_KEYBOARD.belowCardHeight + CLEARANCE).toBeGreaterThan(
      ANDROID_KEYBOARD.frameHeight
    );
    expect(minHeight).toBe(PREFERRED_MIN_HEIGHT);
    expect(capAt(ANDROID_KEYBOARD.frameHeight)).toBe(WINDOW_MAX_HEIGHT);
    // ...the row starts past the frame's bottom edge, so it is reached with the
    // form's drag, and the reserve is back from the frame that fits it.
    expect(cardBottom + WINDOW_MAX_HEIGHT + ANDROID_KEYBOARD.belowCardHeight).toBeGreaterThan(
      ANDROID_KEYBOARD.frameHeight
    );
    expect(capAt(394)).toBe(WINDOW_MAX_HEIGHT);
    expect(capAt(395)).toBe(PREFERRED_MIN_HEIGHT);
  });
});
