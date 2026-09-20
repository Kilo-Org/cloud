import { type ElementType } from 'react';
import type * as AppAwareKeyboardPadding from '@/components/kilo-chat/app-aware-keyboard-padding';
import { act } from '@/test/renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  keyboard,
  mount,
  platform,
  resetUnlockMocks,
  route,
  unlockRoot,
  unmountUnlock,
} from '@/components/app-unlock-screen.test-helpers';
import { getEffectiveTabBarHeight } from '@/lib/tab-bar-layout';
import { MIN_BOTTOM_CHROME_HEIGHT, TOAST_BOTTOM_GAP } from '@/lib/toast-offset';

// One keyboard read for the whole app: the Toaster must import the hook the
// screens reserve padding with, not run its own listener pair, or the toast's
// height can drift from theirs. The counter is a plain object so
// `resetUnlockMocks` (which resets every `vi.fn`) cannot clear it.
const sharedKeyboardHook = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@/components/kilo-chat/app-aware-keyboard-padding', async importOriginal => {
  const actual = await importOriginal<typeof AppAwareKeyboardPadding>();
  return {
    ...actual,
    useAppAwareKeyboardPadding: () => {
      sharedKeyboardHook.calls += 1;
      return actual.useAppAwareKeyboardPadding();
    },
  };
});

beforeEach(resetUnlockMocks);
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
 * The keyboard read lives in one hook (`useAppAwareKeyboardPadding`) so the
 * padding view and the reveal hook cannot disagree with the toast. The Toaster
 * imports that hook instead of running its own `Keyboard`/`AppState` listener
 * pair; this test fails if a second implementation grows back here.
 */
it('reads the keyboard height through the shared app-aware hook', async () => {
  sharedKeyboardHook.calls = 0;

  await mount();

  expect(sharedKeyboardHook.calls).toBeGreaterThan(0);
});

it('keeps the toast above the software keyboard while it is up', async () => {
  platform.OS = 'android';
  await mount();

  act(() => {
    keyboard.show({ endCoordinates: { height: 300 } });
  });

  const toasters = unlockRoot().findAllByType('Toaster' as ElementType);

  expect(toasters[0]?.props.offset).toBe(300 + TOAST_BOTTOM_GAP);
});

/**
 * The harness keeps every keyboard subscriber, one set per direction (see the
 * Keyboard mock in the test helpers). A second consumer — here an extra
 * listener standing in for a screen on top of the Toaster — must not shadow the
 * Toaster's listener, and disposing it must not detach the Toaster's. A single
 * slot per direction failed both halves.
 */
it('delivers a keyboard event to every subscriber and detaches only the disposed one', async () => {
  platform.OS = 'android';
  await mount();

  const extra = vi.fn((_event: { endCoordinates: { height: number } }) => undefined);
  const subscription = keyboard.addListener('keyboardDidShow', extra);

  act(() => {
    keyboard.show({ endCoordinates: { height: 300 } });
  });
  // Both the Toaster's hook and the extra subscriber received the height.
  expect(extra).toHaveBeenCalledWith({ endCoordinates: { height: 300 } });
  expect(unlockRoot().findAllByType('Toaster' as ElementType)[0]?.props.offset).toBe(
    300 + TOAST_BOTTOM_GAP
  );

  subscription.remove();
  act(() => {
    keyboard.show({ endCoordinates: { height: 240 } });
  });
  // The disposed subscriber is gone; the Toaster's listener is still attached.
  expect(extra).toHaveBeenCalledTimes(1);
  expect(unlockRoot().findAllByType('Toaster' as ElementType)[0]?.props.offset).toBe(
    240 + TOAST_BOTTOM_GAP
  );
});

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
