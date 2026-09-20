// Mounted coverage for the shared keyboard-lift view. When the view's bottom
// edge sits at the screen bottom, the reserved space is anchored there, so the
// view must resolve the platform's own keyboard metric through
// `resolveKeyboardBottomPadding` — the same rule the login screen and the
// Toaster use — instead of padding by the raw height. Android's raw height
// stops at the navigation bar, so reserving it left the bottom `bottomInset`
// of the content (the manual review form's Start button) behind the IME's
// navigation row (2026-09-20).
//
// Callers whose own container already reserves the bottom inset above the view
// (the session screen's trailing chrome spacer, the new-session form's parent
// padding) pass `containerReservesBottomInset`, so the inset is subtracted and
// the space is resolved once per screen instead of twice.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppAwareKeyboardPaddingView } from './app-aware-keyboard-padding';

const platform = vi.hoisted(() => ({ OS: 'android' }));
const insets = vi.hoisted(() => ({ bottom: 0 }));
const keyboard = vi.hoisted(() => ({
  show: null as ((event: { endCoordinates: { height: number } }) => void) | null,
  hide: null as (() => void) | null,
  appState: null as ((state: string) => void) | null,
}));

vi.mock('react-native', () => ({
  View: 'View',
  Platform: platform,
  Keyboard: {
    addListener: vi.fn((event: string, listener: (event?: unknown) => void) => {
      if (event === 'keyboardDidShow' || event === 'keyboardWillShow') {
        keyboard.show = listener as (event: { endCoordinates: { height: number } }) => void;
      }
      if (event === 'keyboardDidHide' || event === 'keyboardWillHide') {
        keyboard.hide = listener as () => void;
      }
      return { remove: vi.fn() };
    }),
  },
  AppState: {
    addEventListener: vi.fn((_event: string, listener: (state: string) => void) => {
      keyboard.appState = listener;
      return { remove: vi.fn() };
    }),
  },
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => insets,
}));

type MountProps = { containerReservesBottomInset?: boolean };

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

describe('AppAwareKeyboardPaddingView', () => {
  beforeEach(() => {
    platform.OS = 'android';
    insets.bottom = 0;
    keyboard.show = null;
    keyboard.hide = null;
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

    act(() => {
      keyboard.show?.({ endCoordinates: { height: 704 } });
    });
    expect(paddingBottom(renderer)).toBe(767);

    act(() => {
      keyboard.hide?.();
    });
    expect(paddingBottom(renderer)).toBe(0);

    renderer.unmount();
  });

  it('passes the iOS frame height through, which already reaches the screen bottom', () => {
    platform.OS = 'ios';
    insets.bottom = 34;
    const renderer = mount();

    act(() => {
      keyboard.show?.({ endCoordinates: { height: 300 } });
    });
    expect(paddingBottom(renderer)).toBe(300);

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

    act(() => {
      keyboard.show?.({ endCoordinates: { height: 704 } });
    });
    expect(paddingBottom(renderer)).toBe(704);

    renderer.unmount();
  });

  it('subtracts the container-reserved inset on iOS, whose frame reaches the screen bottom', () => {
    platform.OS = 'ios';
    insets.bottom = 34;
    const renderer = mount({ containerReservesBottomInset: true });

    act(() => {
      keyboard.show?.({ endCoordinates: { height: 300 } });
    });
    expect(paddingBottom(renderer)).toBe(266);

    renderer.unmount();
  });

  it('still reserves nothing at rest when the container reserves the inset', () => {
    insets.bottom = 63;
    const renderer = mount({ containerReservesBottomInset: true });

    expect(paddingBottom(renderer)).toBe(0);
    renderer.unmount();
  });
});
