// The agents "Filter sessions" control is one of the icon-only controls the
// accessibility explorer found below 28dp: it rendered the bare 20dp sliders
// icon, so its accessibility node was the icon. This pins the box that replaced
// it, and that the count badge still hangs off the icon.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { expectReliableTapTarget } from '@/test/touch-target.test-helpers';

import '@/i18n';
import { SessionFilterButton } from './session-filter-button';

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
}));

vi.mock('@/components/ui/icons', () => ({
  SlidersHorizontal: 'SlidersHorizontal',
}));

vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000000', mutedForeground: '#666666' }),
}));

async function renderButton(activeCount: number): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(
      createElement(SessionFilterButton, {
        activeCount,
        onPress: vi.fn<() => void>(),
        testID: 'agents-open-filters',
      })
    );
    await Promise.resolve();
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function findFilterButton(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
  return root.find(
    node => String(node.type) === 'Pressable' && node.props.testID === 'agents-open-filters'
  );
}

describe('SessionFilterButton mounted', () => {
  it('gives the filter control a box at least 28dp on a side and a 44pt tap target', async () => {
    const renderer = await renderButton(0);

    const button = findFilterButton(renderer.root);
    expectReliableTapTarget(button.props);
    expect(button.props.accessibilityLabel).toBe('Filter sessions');
  });

  it('keeps the badge and the spoken count when filters are applied', async () => {
    const renderer = await renderButton(2);

    const button = findFilterButton(renderer.root);
    expectReliableTapTarget(button.props);
    expect(button.props.accessibilityLabel).toBe('Filter sessions, 2');
    expect(
      renderer.root.findAll(node => node.props.testID === 'session-filter-badge')
    ).toHaveLength(1);
  });
});
