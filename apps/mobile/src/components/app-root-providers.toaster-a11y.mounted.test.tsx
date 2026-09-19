import { type ElementType } from 'react';
import { type KeyboardEvent } from 'react-native';
import { afterEach, beforeEach, expect, it } from 'vitest';

import {
  flush,
  keyboard,
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
  await mount();

  const toasters = unlockRoot().findAllByType('Toaster' as ElementType);

  expect(toasters).toHaveLength(1);
  expect(toasters[0]?.props.positionerStyle).toEqual({ top: 0 });
  expect(toasters[0]?.props.offset).toBeUndefined();
  expect(keyboard.listeners.size).toBe(0);
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

it.each([36, 280])(
  'clears an Android keyboard of height %i without losing its accessibility anchor',
  async height => {
    platform.OS = 'android';
    await mount();

    await showKeyboard(height);

    const toaster = unlockRoot().findByType('Toaster' as ElementType);
    // Android's keyboard event excludes the navigation inset (12 in this harness).
    expect(toaster.props.offset).toBe(height + 12 + 8);
    expect(toaster.props.position).toBe('bottom-center');
    expect(toaster.props.positionerStyle).toEqual({ top: 0 });
  }
);

it('updates clearance when the keyboard changes height and restores safe-area placement on hide', async () => {
  platform.OS = 'android';
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
});

it('clears the keyboard when the toast host mounts while it is already open', async () => {
  platform.OS = 'android';
  keyboard.metrics.mockReturnValue(keyboardEvent(36).endCoordinates);
  await mount();

  expect(unlockRoot().findByType('Toaster' as ElementType).props.offset).toBe(36 + 12 + 8);
});

it.each([0, -1])(
  'uses the default safe-area placement for a non-occluding keyboard height %i',
  async height => {
    platform.OS = 'android';
    await mount();

    await showKeyboard(height);
    expect(unlockRoot().findByType('Toaster' as ElementType).props.offset).toBeUndefined();
  }
);
