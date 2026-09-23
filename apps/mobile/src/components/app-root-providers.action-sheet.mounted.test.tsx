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
 * The account picker marks the current account with an icon in the option
 * gutter (`context-control.tsx`), and the whole sheet is one implementation for
 * both platforms. Only this library's own JS sheet draws that gutter or the
 * separator and palette props: the native iOS sheet (`ActionSheetIOS`) renders
 * option strings only. Mounting the provider without `useCustomActionSheet`
 * silently hands iOS the native sheet and drops the mark, which is exactly the
 * per-platform second implementation this flag removes.
 */
it('mounts the library JS action sheet on every platform', async () => {
  await mount();

  const sheets = unlockRoot().findAllByType('ActionSheetProvider' as ElementType);

  expect(sheets).toHaveLength(1);
  expect(sheets[0]?.props.useCustomActionSheet).toBe(true);
});
