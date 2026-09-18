import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { SessionComposerSkeleton } from './session-detail-skeleton';

const insets = vi.hoisted(() => ({ top: 0, bottom: 34, left: 0, right: 0 }));

vi.mock('react-native', () => ({
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => insets,
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  FadeOut: { duration: () => ({}) },
}));
vi.mock('@/components/ui/blur-bar', () => ({
  BlurBar: 'BlurBar',
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));

describe('SessionComposerSkeleton', () => {
  it('reserves the input row plus the resolved composer bottom safe-area spacer', () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const ref: { current: TestRenderer.ReactTestRenderer | null } = { current: null };
    act(() => {
      ref.current = TestRenderer.create(createElement(SessionComposerSkeleton));
    });
    const renderer = ref.current;
    if (!renderer) {
      throw new Error('the composer skeleton did not render');
    }

    // Exact height: a zero or missing inset must not satisfy this.
    const spacers = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'View' &&
        (node.props.style as { height?: number } | undefined)?.height === 34
    );
    expect(spacers).toHaveLength(1);

    act(() => {
      renderer.unmount();
    });
  });
});
