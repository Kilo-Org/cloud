import {
  mount,
  resetUnlockMocks,
  unlockRoot,
  unlockScene,
  unmountUnlock,
} from '@/components/app-unlock-screen.test-helpers';
import { PickerSheet } from '@/components/picker-sheet';
import { SheetHeader } from '@/components/sheet-header';
import { ScrollView } from 'react-native';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(resetUnlockMocks);
afterEach(unmountUnlock);

it.each([true, false])('keeps native sheet siblings; scrollable=%s', async scrollable => {
  const children = (
    <PickerSheet title="Sheet" onDone={vi.fn<() => void>()} scrollable={scrollable}>
      {scrollable ? null : <ScrollView />}
    </PickerSheet>
  );
  await mount(unlockScene(children));
  const sheet = unlockRoot().findByType(PickerSheet);
  expect(sheet.parent?.props).toEqual({
    children,
    className: 'flex-1',
    pointerEvents: 'auto',
    accessibilityElementsHidden: false,
    importantForAccessibility: 'auto',
  });
  expect(sheet.parent?.parent?.type).not.toBe('View');
  expect(sheet.children).toMatchObject([
    { type: 'View', props: { collapsable: false } },
    { type: 'ScrollView' },
  ]);
  expect(sheet.findByType(SheetHeader).parent?.props.collapsable).toBe(false);
});
