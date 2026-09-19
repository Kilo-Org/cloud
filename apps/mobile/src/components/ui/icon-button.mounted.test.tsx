// An icon-only control's accessibility node is its own box — Android reports the
// view rect, not `hitSlop` — so the explorer check fails any control under 28dp
// on a side. IconButton is the single place that box and the tap target are
// defined; these tests pin both so a caller cannot regress them.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { expectReliableTapTarget } from '@/test/touch-target.test-helpers';

import { IconButton } from './icon-button';

vi.mock('react-native', () => ({ Pressable: 'Pressable' }));

type RenderProps = {
  accessibilityLabel?: string;
  className?: string;
  hitSlop?: object;
  onPress?: () => void;
  testID?: string;
};

async function renderButton(props: RenderProps): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(createElement(IconButton, props, createElement('IconMock')));
    await Promise.resolve();
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function findButton(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
  return root.find(node => String(node.type) === 'Pressable');
}

describe('IconButton mounted', () => {
  it('renders the caller label, testID and role', async () => {
    const renderer = await renderButton({
      accessibilityLabel: 'Filter sessions',
      testID: 'agents-open-filters',
    });

    const button = findButton(renderer.root);
    expect(button.props.accessibilityRole).toBe('button');
    expect(button.props.accessibilityLabel).toBe('Filter sessions');
    expect(button.props.testID).toBe('agents-open-filters');
  });

  it('keeps a box at least 28dp on a side and clears the 44pt tap-target minimum', async () => {
    const renderer = await renderButton({ accessibilityLabel: 'Filter sessions' });

    expectReliableTapTarget(findButton(renderer.root).props);
  });

  it('keeps the box when a caller adds its own classes', async () => {
    const renderer = await renderButton({
      accessibilityLabel: 'Filter sessions',
      className: 'mt-2',
    });

    const button = findButton(renderer.root);
    expectReliableTapTarget(button.props);
    expect(button.props.className).toContain('mt-2');
  });

  it('invokes onPress when pressed', async () => {
    const onPress = vi.fn(() => undefined);
    const renderer = await renderButton({ accessibilityLabel: 'Filter sessions', onPress });

    const button = findButton(renderer.root);
    (button.props.onPress as () => void)();

    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
