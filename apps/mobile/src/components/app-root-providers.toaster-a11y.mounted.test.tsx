import { type ElementType } from 'react';
import { act } from '@/test/renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  mount,
  platform,
  resetUnlockMocks,
  route,
  unlockRoot,
  unmountUnlock,
} from '@/components/app-unlock-screen.test-helpers';
import { getEffectiveTabBarHeight } from '@/lib/tab-bar-layout';
import { MIN_BOTTOM_CHROME_HEIGHT, TOAST_BOTTOM_GAP } from '@/lib/toast-offset';

// One keyboard read for the whole app: the Toaster must read the height the
// screens reserve padding from, not run its own listener pair, or the toast's
// height can drift from theirs. The counter is a plain object so
// `resetUnlockMocks` (which resets every `vi.fn`) cannot clear it.
const keyboardStore = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    state: { height: 0, calls: 0 },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setHeight: (height: number) => {
      keyboardStore.state.height = height;
      for (const listener of listeners) {
        listener();
      }
    },
  };
});
vi.mock('react-native-keyboard-controller', async () => {
  // `vi.mock` factories are hoisted above the file's static imports, so `react`
  // must be pulled in here.
  const React = await import('react');
  const heightOf = () => keyboardStore.state.height;
  return {
    KeyboardProvider: 'KeyboardProvider',
    KeyboardAvoidingView: 'KeyboardAvoidingView',
    KeyboardChatScrollView: 'KeyboardChatScrollView',
    useKeyboardState: (selector?: (state: Record<string, unknown>) => unknown) => {
      keyboardStore.state.calls += 1;
      const height = React.useSyncExternalStore(keyboardStore.subscribe, heightOf, heightOf);
      const state = {
        height,
        isVisible: height > 0,
        progress: height > 0 ? 1 : 0,
        duration: 0,
      };
      return selector ? selector(state) : state;
    },
  };
});

beforeEach(() => {
  resetUnlockMocks();
  keyboardStore.setHeight(0);
});
afterEach(unmountUnlock);

/**
 * sonner-native gives the container it positions toasts inside no height and
 * places every toast at `bottom: 0` of it, so a toast's rect never intersects
 * its parent's. Android paints it anyway, but `View.isVisibleToUser()` reports
 * false and the whole toast leaves the accessibility tree: TalkBack reads
 * nothing and `uiautomator dump` has no toast node. That is exactly how the
 * device harness lost the session header's "Link copied" confirmation — the
 * copy committed and the toast was on screen, and the dump had no toast
 * (2026-09-16). Anchoring the container to the top of the window is the one
 * thing the fix turns on, so dropping this prop silently makes every
 * confirmation unreadable again.
 */
it('anchors the toast container to the window so toasts reach the accessibility tree', async () => {
  await mount();

  const toasters = unlockRoot().findAllByType('Toaster' as ElementType);

  expect(toasters).toHaveLength(1);
  expect(toasters[0]?.props.positionerStyle).toEqual({ top: 0 });
});

/**
 * The safe-area inset is not a reliable floor for the bottom chrome: on Android
 * it is only `navigationBars()`, it does not grow while the IME's navigation
 * row is on screen, and it can be reported as `0`. A toast anchored to the
 * inset alone had its last line clipped under that chrome (2026-09-18 device
 * finding), so the offset is floored at one shared bottom-chrome height for
 * both platforms — no platform branch.
 */
it('floors the toast offset at the shared bottom-chrome height', async () => {
  platform.OS = 'android';
  // Default route: a screen pushed over the tabs, so no tab bar is on screen
  // and the bottom-chrome floor decides the offset.
  await mount();

  const toasters = unlockRoot().findAllByType('Toaster' as ElementType);

  // The mocked inset (12) is below the floor, so the floor decides the offset.
  expect(toasters[0]?.props.offset).toBe(MIN_BOTTOM_CHROME_HEIGHT + TOAST_BOTTOM_GAP);
});

/**
 * The floating tab bar is an absolute overlay over the screen bottom: the
 * reported bottom inset does not include it, and a toast anchored to the
 * inset landed over the tab icons (2026-09-19 visual spot check, p1 — the
 * manual-review error toast covered the navigation row). While a tab screen
 * is on top, the offset must clear the bar's full rendered height.
 */
it('clears the floating tab bar while a tab screen is on top', async () => {
  platform.OS = 'android';
  route.segments = ['(app)', '(tabs)', '(3_profile)', 'code-reviewer', 'personal', 'manual-review'];
  route.pathname = '/code-reviewer/personal/manual-review';
  await mount();

  const toasters = unlockRoot().findAllByType('Toaster' as ElementType);

  // Same predicate and height source as the tab bar's own layout
  // (`(tabs)/_layout.tsx`), so the toast clears whatever the bar renders.
  const tabOverlayHeight = getEffectiveTabBarHeight({
    bottomInset: 12,
    platform: 'android',
    fontScale: 1,
  });
  expect(toasters[0]?.props.offset).toBe(tabOverlayHeight + TOAST_BOTTOM_GAP);
});

/**
 * The bar's own layout hides it on two in-tab routes (`shouldHideTabBar`);
 * there the toast must fall back to the resting offset instead of floating
 * over a bar that is not there.
 */
it('keeps the resting offset when the route hides the tab bar', async () => {
  platform.OS = 'android';
  route.segments = ['(app)', '(tabs)', '(1_kiloclaw)', 'chat', 'sandbox', 'conversation'];
  route.pathname = '/chat/sandbox/conversation';
  await mount();

  const toasters = unlockRoot().findAllByType('Toaster' as ElementType);

  expect(toasters[0]?.props.offset).toBe(MIN_BOTTOM_CHROME_HEIGHT + TOAST_BOTTOM_GAP);
});

/**
 * The keyboard read comes from the `KeyboardProvider` so the Toaster cannot
 * disagree with the screens. It reads that state instead of running its own
 * `Keyboard`/`AppState` listener pair; this test fails if a second
 * implementation grows back here.
 */
it('reads the keyboard height from the provider', async () => {
  keyboardStore.state.calls = 0;

  await mount();

  expect(keyboardStore.state.calls).toBeGreaterThan(0);
});

/**
 * The provider's height is the whole strip the IME hides, anchored to the
 * screen bottom, on both platforms: on Android edge-to-edge the navigation bar
 * is translucent, so nothing is subtracted from the IME inset, and iOS reports
 * the keyboard frame, which already spans the home indicator. Adding the bottom
 * inset again would float the toast a navigation-bar height above the keyboard
 * (2026-09-20 review finding), so the reported height passes through unchanged
 * — the platform-parity half of the toast rule. The mocked bottom inset is 12.
 */
it.each(['android', 'ios'] as const)(
  'clears the reported keyboard height on %s without adding the bottom inset',
  async os => {
    platform.OS = os;
    await mount();

    act(() => {
      keyboardStore.setHeight(300);
    });

    const toasters = unlockRoot().findAllByType('Toaster' as ElementType);

    // The toast clears the reported height and keeps the standard gap above it.
    expect(toasters[0]?.props.offset).toBe(300 + TOAST_BOTTOM_GAP);
  }
);

/**
 * The same rule runs on iOS: the offset module reads no platform, so the
 * resting offset is the shared bottom-chrome floor plus the standard gap, not
 * the raw iOS inset (12 here). This is the platform-parity assertion for the
 * toast path — if a per-platform branch grows back, one of the two platforms
 * stops matching the shared floor.
 */
it('uses the same bottom-chrome floor on iOS', async () => {
  platform.OS = 'ios';
  await mount();

  const toasters = unlockRoot().findAllByType('Toaster' as ElementType);

  expect(toasters[0]?.props.offset).toBe(MIN_BOTTOM_CHROME_HEIGHT + TOAST_BOTTOM_GAP);
});
