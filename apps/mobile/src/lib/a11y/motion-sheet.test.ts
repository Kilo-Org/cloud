/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/components/ui/accessible-status.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type ActionSheetListModel,
  ReducedMotionSheetHost,
  showReducedMotionSheet,
} from '@/components/ui/reduced-motion-sheet';

const moveA11yFocusMock = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  Modal: 'Modal',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 16 }),
}));

vi.mock('@/components/ui/text', () => ({
  Text: 'Text',
}));

vi.mock('@/lib/utils', () => ({
  cn: (...inputs: unknown[]) => inputs.filter(Boolean).join(' '),
}));

vi.mock('@/lib/a11y/announce', () => ({
  moveA11yFocus: moveA11yFocusMock,
}));

type Renderer = TestRenderer.ReactTestRenderer;

function findHeading(renderer: Renderer) {
  return renderer.root
    .findAll(node => (node.type as string) === 'Text')
    .find(text => text.props.accessibilityRole === 'header');
}

// Reduced-motion Modal semantics (final cumulative r6):
// - The sheet card is `accessibilityViewIsModal`, so the backdrop and the
//   screen behind the native Modal are unreachable while the sheet is open.
// - The caller's title is a named heading and the deterministic entry-focus
//   target on `onShow`; a title-less sheet focuses its first action instead.
// - Every close path unmounts the native Modal (OS return-focus); the host
//   wires the model's select/dismiss callbacks exactly once.
describe('ReducedMotionSheetHost modal semantics', () => {
  const onSelect = vi.fn<(index: number) => void>();
  const onDismiss = vi.fn<() => void>();

  function model(overrides: Partial<ActionSheetListModel> = {}): ActionSheetListModel {
    return {
      items: [
        { label: 'Rename', index: 0, destructive: false, cancel: false },
        { label: 'Cancel', index: 1, destructive: false, cancel: true },
      ],
      onSelect,
      onDismiss,
      ...overrides,
    };
  }

  async function mountSheet(next: ActionSheetListModel): Promise<Renderer> {
    const holder: { current?: Renderer } = {};
    await act(async () => {
      await Promise.resolve();
      holder.current = TestRenderer.create(createElement(ReducedMotionSheetHost));
    });
    const renderer = holder.current;
    if (renderer === undefined) {
      throw new Error('renderer was not created');
    }
    await act(async () => {
      showReducedMotionSheet(next);
      await Promise.resolve();
    });
    return renderer;
  }

  async function fireModal(
    renderer: Renderer,
    handler: 'onShow' | 'onRequestClose'
  ): Promise<void> {
    const modal = renderer.root.findAll(node => (node.type as string) === 'Modal')[0];
    if (modal === undefined) {
      throw new Error('modal was not rendered');
    }
    await act(async () => {
      await Promise.resolve();
      (modal.props[handler] as () => void)();
    });
  }

  beforeEach(() => {
    moveA11yFocusMock.mockClear();
    onSelect.mockClear();
    onDismiss.mockClear();
  });

  it('isolates the sheet and names the heading', async () => {
    const renderer = await mountSheet(model({ title: 'Session options' }));

    const card = renderer.root
      .findAll(node => (node.type as string) === 'View')
      .find(view => view.props.accessibilityViewIsModal === true);
    expect(card).toBeDefined();
    expect(findHeading(renderer)?.props.children).toBe('Session options');
    renderer.unmount();
  });

  it('focuses the heading on show when a title is present', async () => {
    const renderer = await mountSheet(model({ title: 'Session options' }));
    expect(findHeading(renderer)).toBeDefined();

    await fireModal(renderer, 'onShow');

    expect(moveA11yFocusMock).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it('focuses the first action on show when the sheet has no title', async () => {
    const renderer = await mountSheet(model());
    expect(findHeading(renderer)).toBeUndefined();

    await fireModal(renderer, 'onShow');

    expect(moveA11yFocusMock).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it('dismisses through onRequestClose and fires the model dismissal once', async () => {
    const renderer = await mountSheet(model());

    await fireModal(renderer, 'onRequestClose');

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(renderer.toJSON()).toBeNull();
  });

  it('fires the model selection callback when an action is activated', async () => {
    const renderer = await mountSheet(model());
    const item = renderer.root
      .findAll(node => (node.type as string) === 'Pressable')
      .find(pressable => pressable.props.accessibilityLabel === undefined);
    if (item === undefined) {
      throw new Error('expected a non-dismiss action item');
    }
    await act(async () => {
      await Promise.resolve();
      (item.props.onPress as () => void)();
    });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(0);
    expect(renderer.toJSON()).toBeNull();
    renderer.unmount();
  });
});
