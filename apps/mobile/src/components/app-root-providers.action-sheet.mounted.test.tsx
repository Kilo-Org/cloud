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
 * `useCustomActionSheet` is provider-wide: setting it swaps every iOS action
 * sheet in the app from `ActionSheetIOS` to the library's JS sheet, which
 * hardcodes a white surface and black text, so every unrelated sheet would
 * break in iOS dark mode. The account picker therefore draws its own themed
 * sheet (`context-control.tsx` / `context-picker-sheet.tsx`) and must not turn
 * this flag on. Mounting the provider without the flag silently hands iOS the
 * native sheet — the case every other call site relies on.
 */
it('leaves the native iOS action sheet mounted for every other sheet', async () => {
  await mount();

  const sheets = unlockRoot().findAllByType('ActionSheetProvider' as ElementType);

  expect(sheets).toHaveLength(1);
  expect(sheets[0]?.props.useCustomActionSheet).toBeFalsy();
});
