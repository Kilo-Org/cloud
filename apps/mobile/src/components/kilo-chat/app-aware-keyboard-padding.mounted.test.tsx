// Mounted coverage for the shared keyboard-lift view: the two sides of the
// merge that introduced it. When the view's bottom edge sits at the screen
// bottom, the reserved space is anchored there, so the view pads by the whole
// strip the IME hides — Android's raw height plus the navigation bar its metric
// stops at, iOS's overlap measured from the keyboard top. Padding by the raw
// Android height alone left the bottom `bottomInset` of the content (the manual
// review form's Start button) behind the IME's navigation row (2026-09-20).
//
// Callers whose own container already reserves the bottom inset above the view
// (the session screen's trailing chrome spacer, the new-session form's parent
// padding) pass `containerReservesBottomInset`, so the inset is subtracted and
// the space is resolved once per screen instead of twice. Callers whose wrapped
// content pads the inset itself (the session composer, the discussion CTA bar)
// pass `contentReservesBottomInset`, so the screen-bottom-anchored occlusion
// does not add it a second time either.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppAwareKeyboardPaddingView } from './app-aware-keyboard-padding';

const platform = vi.hoisted(() => ({ OS: 'android' }));
const insets = vi.hoisted(() => ({ bottom: 0 }));
const screen = vi.hoisted(() => ({ height: 900 }));
const keyboard = vi.hoisted(() => ({
  show: null as ((event: { endCoordinates: { height: number; screenY?: number } }) => void) | null,
  hide: null as (() => void) | null,
  appState: null as ((state: string) => void) | null,
}));

vi.mock('react-native', () => ({
  View: 'View',
  Platform: platform,
  Dimensions: { get: () => screen },
  Keyboard: {
    addListener: vi.fn((event: string, listener: (event?: unknown) => void) => {
      if (event === 'keyboardDidShow' || event === 'keyboardWillShow') {
        keyboard.show = listener as (event: {
          endCoordinates: { height: number; screenY?: number };
        }) => void;
      }
      if (event === 'keyboardDidHide' || event === 'keyboardWillHide') {
        keyboard.hide = listener as () => void;
      }
      return {
        remove: () => {
          keyboard.show = null;
          keyboard.hide = null;
        },
      };
    }),
  },
  AppState: {
    addEventListener: vi.fn((_event: string, listener: (state: string) => void) => {
      keyboard.appState = listener;
      return {
        remove: () => {
          keyboard.appState = null;
        },
      };
    }),
  },
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => insets,
}));

type MountProps = {
  keyboardOffset?: number;
  containerReservesBottomInset?: boolean;
  contentReservesBottomInset?: boolean;
};

function mount(props: MountProps = {}) {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(AppAwareKeyboardPaddingView, props, createElement('Child', null))
    );
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('padding view was not mounted');
  }
  return renderer;
}

function paddingBottom(renderer: TestRenderer.ReactTestRenderer): number {
  const view = renderer.root.find(node => String(node.type) === 'View');
  const style = view.props.style as (Record<string, unknown> | undefined)[];
  const padding = style.find(part => part != null && 'paddingBottom' in part);
  if (!padding) {
    throw new Error('padding view carries no paddingBottom');
  }
  return padding.paddingBottom as number;
}

/** Fires the platform's show event; `screenY` is the keyboard top on iOS. */
function showKeyboard(height: number, screenY?: number) {
  act(() => {
    keyboard.show?.({
      endCoordinates: screenY === undefined ? { height } : { height, screenY },
    });
  });
}

describe('AppAwareKeyboardPaddingView', () => {
  beforeEach(() => {
    platform.OS = 'android';
    insets.bottom = 24;
    screen.height = 900;
    keyboard.show = null;
    keyboard.hide = null;
    keyboard.appState = null;
  });

  it('reserves nothing while the keyboard is down', () => {
    insets.bottom = 63;
    const renderer = mount();

    expect(paddingBottom(renderer)).toBe(0);
    renderer.unmount();
  });

  it('adds the navigation-bar inset on Android, whose metric stops at the bar', () => {
    platform.OS = 'android';
    insets.bottom = 63;
    const renderer = mount();

    showKeyboard(704);
    expect(paddingBottom(renderer)).toBe(767);

    act(() => {
      keyboard.hide?.();
    });
    expect(paddingBottom(renderer)).toBe(0);

    renderer.unmount();
  });

  it.each([300, 324])('adds the Android system-bar inset to the reported height %i', height => {
    const renderer = mount();
    expect(paddingBottom(renderer)).toBe(0);
    // Android edge-to-edge reports the nav-bar-excluded height, not the IME
    // top; iOS reports the keyboard top, which on a docked keyboard sits its
    // own height above the screen bottom.
    showKeyboard(height, platform.OS === 'android' ? 876 : screen.height - height);
    expect(paddingBottom(renderer)).toBe(
      platform.OS === 'android' ? height + insets.bottom : height
    );
    renderer.unmount();
  });

  it('tracks a short keyboard and a changed screen size', () => {
    const renderer = mount();
    showKeyboard(24, 876);
    expect(paddingBottom(renderer)).toBe(platform.OS === 'android' ? 24 + insets.bottom : 24);
    screen.height = 600;
    showKeyboard(200, platform.OS === 'android' ? 576 : 400);
    expect(paddingBottom(renderer)).toBe(platform.OS === 'android' ? 200 + insets.bottom : 200);
    renderer.unmount();
  });

  it('caps an undocked iOS keyboard at its frame height, not the screen below it', () => {
    // An iPad floating/split keyboard reports its top at the floating position,
    // so the distance to the screen bottom counts the uncovered screen under it
    // (hundreds of points), not the strip it hides. The frame height is the
    // occlusion there (2026-09-22 review finding).
    platform.OS = 'ios';
    insets.bottom = 34;
    screen.height = 1024;
    const renderer = mount();

    // Docked at height 264 the top would be 760; floating it sits at 500.
    showKeyboard(264, 500);
    expect(paddingBottom(renderer)).toBe(264);

    renderer.unmount();
  });

  it('passes the iOS frame height through when the event carries no screen position', () => {
    platform.OS = 'ios';
    insets.bottom = 34;
    const renderer = mount();

    showKeyboard(300);
    expect(paddingBottom(renderer)).toBe(300);

    renderer.unmount();
  });

  it('clears on dismissal and app background, and removes listeners on unmount', () => {
    const renderer = mount();
    showKeyboard(324, 576);
    act(() => {
      keyboard.hide?.();
    });
    expect(paddingBottom(renderer)).toBe(0);
    showKeyboard(324, 576);
    act(() => keyboard.appState?.('background'));
    expect(paddingBottom(renderer)).toBe(0);
    renderer.unmount();
    expect(keyboard.show).toBeNull();
    expect(keyboard.hide).toBeNull();
  });

  it('applies a caller offset only while the keyboard has positive overlap', () => {
    const renderer = mount({ keyboardOffset: 24 });
    expect(paddingBottom(renderer)).toBe(0);
    showKeyboard(300, platform.OS === 'android' ? 876 : 600);
    expect(paddingBottom(renderer)).toBe(
      platform.OS === 'android' ? 300 + 24 + insets.bottom : 324
    );
    showKeyboard(0, platform.OS === 'android' ? 876 : 900);
    expect(paddingBottom(renderer)).toBe(0);
    showKeyboard(-50, platform.OS === 'android' ? 876 : 950);
    expect(paddingBottom(renderer)).toBe(0);
    renderer.unmount();
  });

  it('subtracts the container-reserved inset on Android, leaving the raw metric', () => {
    // The session screen's trailing spacer and the new-session form's parent
    // padding already lift the view's bottom edge `bottomInset` above the
    // screen bottom; Android's metric is measured down to the navigation bar,
    // so the raw height is exactly the distance from the view's bottom edge to
    // the IME top. Adding the inset again floated the composer / Start button
    // a nav-bar height above the keyboard (2026-09-20 review finding).
    platform.OS = 'android';
    insets.bottom = 63;
    const renderer = mount({ containerReservesBottomInset: true });

    showKeyboard(704);
    expect(paddingBottom(renderer)).toBe(704);

    renderer.unmount();
  });

  it('subtracts the container-reserved inset on iOS, whose frame reaches the screen bottom', () => {
    platform.OS = 'ios';
    insets.bottom = 34;
    const renderer = mount({ containerReservesBottomInset: true });

    showKeyboard(300);
    expect(paddingBottom(renderer)).toBe(266);

    renderer.unmount();
  });

  it('still reserves nothing at rest when the container reserves the inset', () => {
    insets.bottom = 63;
    const renderer = mount({ containerReservesBottomInset: true });

    expect(paddingBottom(renderer)).toBe(0);
    renderer.unmount();
  });

  it('leaves the content-reserved inset to the content on Android', () => {
    // The chat composer and the discussion CTA bar pad the bottom inset inside
    // the view themselves, so the screen-bottom-anchored occlusion must not add
    // it again — adding it floated the composer a navigation-bar height above
    // the keyboard (2026-09-21 review finding).
    platform.OS = 'android';
    insets.bottom = 63;
    const renderer = mount({ contentReservesBottomInset: true });

    showKeyboard(704);
    expect(paddingBottom(renderer)).toBe(704);

    act(() => {
      keyboard.hide?.();
    });
    expect(paddingBottom(renderer)).toBe(0);

    renderer.unmount();
  });

  it('keeps the iOS frame height for content that pads the inset itself', () => {
    platform.OS = 'ios';
    insets.bottom = 34;
    const renderer = mount({ contentReservesBottomInset: true });

    showKeyboard(300);
    expect(paddingBottom(renderer)).toBe(300);

    renderer.unmount();
  });

  it('still reserves nothing at rest when the content reserves the inset', () => {
    insets.bottom = 63;
    const renderer = mount({ contentReservesBottomInset: true });

    expect(paddingBottom(renderer)).toBe(0);
    renderer.unmount();
  });
});
