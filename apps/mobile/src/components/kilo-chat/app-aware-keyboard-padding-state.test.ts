import { describe, expect, it } from 'vitest';

import {
  resolveAppAwareKeyboardPadding,
  resolveKeyboardPaddingEventsForPlatform,
} from './app-aware-keyboard-padding-state';

describe('app-aware keyboard padding state', () => {
  it('resolves Android keyboard events from did-show and did-hide notifications', () => {
    expect(resolveKeyboardPaddingEventsForPlatform('android')).toEqual({
      show: 'keyboardDidShow',
      hide: 'keyboardDidHide',
    });
  });

  it('keeps iOS keyboard events on will-show and will-hide notifications', () => {
    expect(resolveKeyboardPaddingEventsForPlatform('ios')).toEqual({
      show: 'keyboardWillShow',
      hide: 'keyboardWillHide',
    });
  });

  it('clears keyboard padding when the keyboard hides or the app leaves active state', () => {
    expect(
      resolveAppAwareKeyboardPadding({
        currentPadding: 0,
        event: { type: 'keyboard-visible', keyboardHeight: 280 },
      })
    ).toBe(280);
    expect(
      resolveAppAwareKeyboardPadding({
        currentPadding: 280,
        event: { type: 'keyboard-hidden' },
      })
    ).toBe(0);
    expect(
      resolveAppAwareKeyboardPadding({
        currentPadding: 280,
        event: { type: 'app-state-change', appState: 'background' },
      })
    ).toBe(0);
  });
});
