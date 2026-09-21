import { type ElementType } from 'react';
import { afterEach, beforeEach, expect, it } from 'vitest';

import {
  mount,
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
});
