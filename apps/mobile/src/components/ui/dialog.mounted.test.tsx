import { createElement, type ReactElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, expect, it, vi } from 'vitest';

import { DialogCard } from './dialog';
import { isModalSurfacePresented } from '@/lib/modal-surface-veil';

// If the card ever stops holding the modal veil, an open rename dialog silently
// leaves the hub rows and the tab bar focusable again — the state this suite
// rejects.

vi.mock('@rn-primitives/dialog', () => ({
  Root: 'DialogRoot',
  Portal: 'DialogPortal',
  Content: 'DialogContent',
  Overlay: 'DialogOverlay',
  Title: 'DialogTitle',
  Description: 'DialogDescription',
  Close: 'DialogClose',
  Trigger: 'DialogTrigger',
}));
vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
// The confirm surface is a native sheet, which this suite does not measure; its
// module graph needs the sheet library.
vi.mock('@/components/destructive-confirm-dialog', () => ({
  DestructiveConfirmDialog: 'DestructiveConfirmDialog',
}));
vi.mock('@/lib/utils', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
}));

const mounted: TestRenderer.ReactTestRenderer[] = [];

beforeEach(() => {
  for (const renderer of mounted.splice(0)) {
    renderer.unmount();
  }
});

it('holds the modal veil while the card is mounted and releases it on unmount', () => {
  const body: ReactElement = createElement('Text');
  const element: ReactElement = <DialogCard onClose={() => undefined}>{body}</DialogCard>;
  // Mount inside `act`: the hold is a layout effect, and the commit is what runs
  // it in the DOM-free renderer.
  act(() => {
    mounted.push(TestRenderer.create(element));
  });
  const [renderer] = mounted;
  if (!renderer) {
    throw new Error('the dialog card did not mount');
  }

  expect(isModalSurfacePresented()).toBe(true);

  act(() => {
    renderer.unmount();
  });

  expect(isModalSurfacePresented()).toBe(false);
});
