import { type ElementType } from 'react';
import { afterEach, beforeEach, expect, it } from 'vitest';

import {
  mount,
  platform,
  resetUnlockMocks,
  unlockRoot,
  unmountUnlock,
} from '@/components/app-unlock-screen.test-helpers';

beforeEach(resetUnlockMocks);
afterEach(unmountUnlock);

it.each(['ios', 'android'])('uses the shared action-sheet renderer on %s', async os => {
  platform.OS = os;
  await mount();

  const sheets = unlockRoot().findAllByType('ActionSheetProvider' as ElementType);

  expect(sheets).toHaveLength(1);
  expect(sheets[0]?.props.useCustomActionSheet).toBe(true);
});
