import { type ElementType } from 'react';
import { type KeyboardEvent } from 'react-native';
import { afterEach, beforeEach, expect, it } from 'vitest';

import {
  flush,
  keyboard,
  lifecycle,
  mount,
  platform,
  resetUnlockMocks,
  unlockRoot,
  unmountUnlock,
} from '@/components/app-unlock-screen.test-helpers';

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
  platform.OS = 'ios';
  await mount();

  const toasters = unlockRoot().findAllByType('Toaster' as ElementType);

  expect(toasters).toHaveLength(1);
  expect(toasters[0]?.props.positionerStyle).toEqual({ top: 0 });
  expect(toasters[0]?.props.offset).toBeUndefined();
  // The keyboard listeners attach on iOS too: clearance is not Android-only.
  expect(keyboard.listeners.size).toBe(2);
  expect(keyboard.listeners.has('keyboardDidShow')).toBe(true);
  expect(keyboard.listeners.has('keyboardDidHide')).toBe(true);
});

const keyboardEvent = (height: number): KeyboardEvent => ({
  endCoordinates: { height, screenX: 0, screenY: 600, width: 360 },
  duration: 0,
  easing: 'keyboard',
});

async function showKeyboard(height: number) {
  await flush(() => {
    keyboard.listeners.get('keyboardDidShow')?.(keyboardEvent(height));
  });
}

/**
 * Mount the real provider tree on `os` with `height` already reported, read the
 * offset sonner receives, and unmount. Every keyboard case runs on both
 * platforms with the same expected value, so a re-introduced platform branch
 * (Android clearing the key, iOS not) fails here.
 */
async function keyboardOffsetFor(os: string, height: number): Promise<unknown> {
  platform.OS = os;
  await mount();
  await showKeyboard(height);
  const offset: unknown = unlockRoot().findByType('Toaster' as ElementType).props.offset;
  await unmountUnlock();
  return offset;
}

const KEYBOARD_CASES: [string, number][] = [
  ['ios', 36],
  ['android', 36],
  ['ios', 280],
  ['android', 280],
];

const NON_OCCLUDING_CASES: [string, number][] = [
  ['ios', 0],
  ['android', 0],
  ['ios', -1],
  ['android', -1],
];

it('gives iOS and Android the same keyboard clearance', async () => {
  const ios = await keyboardOffsetFor('ios', 280);
  const android = await keyboardOffsetFor('android', 280);

  expect(ios).toBe(280 + 12 + 8);
  expect(android).toBe(280 + 12 + 8);
});

it.each(KEYBOARD_CASES)(
  'clears a %s keyboard of height %i without losing its accessibility anchor',
  async (os, height) => {
    platform.OS = os;
    await mount();

    await showKeyboard(height);

    const toaster = unlockRoot().findByType('Toaster' as ElementType);
    // The keyboard event excludes the navigation inset (12 in this harness).
    expect(toaster.props.offset).toBe(height + 12 + 8);
    expect(toaster.props.position).toBe('bottom-center');
    expect(toaster.props.positionerStyle).toEqual({ top: 0 });
  }
);

it.each(['ios', 'android'])(
  'updates clearance when the %s keyboard changes height and restores safe-area placement on hide',
  async os => {
    platform.OS = os;
    await mount();
    const toaster = () => unlockRoot().findByType('Toaster' as ElementType);
    expect(toaster().props.offset).toBeUndefined();

    await showKeyboard(280);
    expect(toaster().props.offset).toBe(280 + 12 + 8);
    await showKeyboard(36);
    expect(toaster().props.offset).toBe(36 + 12 + 8);

    await flush(() => {
      keyboard.listeners.get('keyboardDidHide')?.(keyboardEvent(0));
    });
    expect(toaster().props.offset).toBeUndefined();

    await unmountUnlock();
    expect(keyboard.listeners.size).toBe(0);
  }
);

it.each(['ios', 'android'])(
  'clears the %s keyboard when the toast host mounts while it is already open',
  async os => {
    platform.OS = os;
    keyboard.metrics.mockReturnValue(keyboardEvent(36).endCoordinates);
    await mount();

    expect(unlockRoot().findByType('Toaster' as ElementType).props.offset).toBe(36 + 12 + 8);
  }
);

/**
 * Backgrounding the app with the IME open does not reliably deliver
 * `keyboardDidHide`, so a height cached from before the app left the foreground
 * would otherwise lift every later toast on a keyboard-less screen. The
 * composer's `AppAwareKeyboardPaddingView` already clears on non-active states;
 * the toast host must do the same, and re-arm on the next show.
 */
it.each(['ios', 'android'])(
  'clears the %s keyboard clearance when the app leaves the foreground',
  async os => {
    platform.OS = os;
    await mount();
    const toaster = () => unlockRoot().findByType('Toaster' as ElementType);

    await showKeyboard(280);
    expect(toaster().props.offset).toBe(280 + 12 + 8);

    await flush(() => {
      lifecycle.change?.('background');
    });
    expect(toaster().props.offset).toBeUndefined();

    // Returning to the foreground without an IME keeps the default placement;
    // the next show restores clearance.
    await flush(() => {
      lifecycle.change?.('active');
    });
    expect(toaster().props.offset).toBeUndefined();

    await showKeyboard(280);
    expect(toaster().props.offset).toBe(280 + 12 + 8);
  }
);

it.each(NON_OCCLUDING_CASES)(
  'uses the default safe-area placement for a %s non-occluding keyboard height %i',
  async (os, height) => {
    platform.OS = os;
    await mount();

    await showKeyboard(height);
    expect(unlockRoot().findByType('Toaster' as ElementType).props.offset).toBeUndefined();
  }
);
