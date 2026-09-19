import { describe, expect, it } from 'vitest';

import {
  resolveAppAwareKeyboardPadding,
  resolveKeyboardBottomOcclusionForPlatform,
  resolveKeyboardPaddingEventsForPlatform,
} from './app-aware-keyboard-padding-state';

describe('app-aware keyboard padding state', () => {
  it('reaches the keyboard top edge on Android by adding the system-bar inset', () => {
    expect(
      resolveKeyboardBottomOcclusionForPlatform({
        platform: 'android',
        keyboardHeight: 704,
        systemBarInset: 63,
      })
    ).toBe(767);
  });

  it('keeps the iOS height, which already reaches the window bottom', () => {
    expect(
      resolveKeyboardBottomOcclusionForPlatform({
        platform: 'ios',
        keyboardHeight: 300,
        systemBarInset: 34,
      })
    ).toBe(300);
  });

  it('reports no keyboard occlusion while the keyboard is hidden', () => {
    expect(
      resolveKeyboardBottomOcclusionForPlatform({
        platform: 'android',
        keyboardHeight: 0,
        systemBarInset: 63,
      })
    ).toBe(0);
    expect(
      resolveKeyboardBottomOcclusionForPlatform({
        platform: 'ios',
        keyboardHeight: 0,
        systemBarInset: 34,
      })
    ).toBe(0);
  });

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
