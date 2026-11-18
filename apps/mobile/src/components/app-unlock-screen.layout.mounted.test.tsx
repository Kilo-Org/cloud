import { afterEach, beforeEach, expect, it } from 'vitest';

import {
  mount,
  native,
  resetUnlockMocks,
  retry,
  unlockRoot,
  unmountUnlock,
} from '@/components/app-unlock-screen.test-helpers';

beforeEach(resetUnlockMocks);
afterEach(unmountUnlock);

it('centers the unlock content and keeps a separate gap before Retry', async () => {
  native.authenticateAsync.mockResolvedValueOnce({ success: false, error: 'user_cancel' });
  await mount();
  const heading = unlockRoot().findByProps({ accessibilityRole: 'header' });
  const copy = heading.parent;
  const content = copy?.parent;
  expect(content?.props.className).toContain('gap-8');
  expect(content?.parent?.type).toBe('CenteredState');
  expect(content?.props.style).toEqual({ paddingLeft: 24, paddingRight: 24 });
  expect(content?.findAll(node => node === retry())).toHaveLength(1);
  expect(copy?.findAll(node => node === retry())).toHaveLength(0);
  expect(retry()?.props.accessibilityLabel).toBe('Retry');
});
