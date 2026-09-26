import { describe, expect, it } from 'vitest';

import { resolveKeyboardBottomPadding } from '@/components/login-screen-state';
import {
  resolveAppAwareKeyboardPadding,
  resolveKeyboardPaddingEventsForPlatform,
} from './app-aware-keyboard-padding-state';

// Ported from the closed #6380, whose cases covered the platform-aware bottom
// occlusion the keeper #6388 resolves in `resolveKeyboardBottomPadding`: the
// reported geometry is the platform capability that differs, so Android adds
// the system-bar inset to reach the keyboard's top edge while iOS keeps the
// keyboard frame height, which already reaches the window bottom.
describe('platform-aware keyboard bottom occlusion', () => {
  it('reaches the keyboard top edge on Android by adding the system-bar inset', () => {
    expect(
      resolveKeyboardBottomPadding({ platform: 'android', keyboardHeight: 704, bottomInset: 63 })
    ).toBe(767);
  });

  it('keeps the iOS height, which already reaches the window bottom', () => {
    expect(
      resolveKeyboardBottomPadding({ platform: 'ios', keyboardHeight: 300, bottomInset: 34 })
    ).toBe(300);
  });

  it('reserves the system-bar inset alone while the keyboard is hidden', () => {
    expect(
      resolveKeyboardBottomPadding({ platform: 'android', keyboardHeight: 0, bottomInset: 63 })
    ).toBe(63);
    expect(
      resolveKeyboardBottomPadding({ platform: 'ios', keyboardHeight: 0, bottomInset: 34 })
    ).toBe(34);
  });

  it('reserves the same strip on both platforms for the same docked keyboard', () => {
    // One docked keyboard hides one strip from the screen bottom. Android
    // reports that strip minus the navigation bar and iOS reports the frame
    // that reaches the screen bottom, so the two inputs differ while the
    // reserved strip is the same number.
    const occludedStrip = 767;
    const navigationBar = 63;
    expect(
      resolveKeyboardBottomPadding({
        platform: 'android',
        keyboardHeight: occludedStrip - navigationBar,
        bottomInset: navigationBar,
      })
    ).toBe(occludedStrip);
    expect(
      resolveKeyboardBottomPadding({
        platform: 'ios',
        keyboardHeight: occludedStrip,
        bottomInset: 34,
      })
    ).toBe(occludedStrip);
  });
});

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

  it('clears keyboard padding when the keyboard hides or the app leaves the foreground', () => {
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

  it('keeps keyboard padding through a transient iOS inactive state', () => {
    // iOS reports `inactive` for Control Center, the app switcher, a call
    // banner, or a system alert while the keyboard stays up, and fires no new
    // `keyboardWillShow` when it returns to `active`. Collapsing the padding
    // there left the login action under an open keyboard.
    expect(
      resolveAppAwareKeyboardPadding({
        currentPadding: 320,
        event: { type: 'app-state-change', appState: 'inactive' },
      })
    ).toBe(320);
    expect(
      resolveAppAwareKeyboardPadding({
        currentPadding: 320,
        event: { type: 'app-state-change', appState: 'active' },
      })
    ).toBe(320);
  });
});
