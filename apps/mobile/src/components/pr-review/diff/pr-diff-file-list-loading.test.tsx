/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as screen-header.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PrDiffFileListLoading } from './pr-diff-file-list-loading';

const insetsState = vi.hoisted(() => ({ top: 0, bottom: 0, left: 0, right: 0 }));

vi.mock('react-native', () => ({
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => insetsState,
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));

function mountLoading(): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(PrDiffFileListLoading));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function loadingView(renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance {
  return renderer.root.findByProps({ accessibilityLabel: 'Loading files' });
}

describe('PrDiffFileListLoading bottom inset (plan §6)', () => {
  beforeEach(() => {
    insetsState.bottom = 0;
  });

  it('pads the first-page skeleton by the detail-screen padding at a zero inset', () => {
    const renderer = mountLoading();

    const style = loadingView(renderer).props.style as { paddingBottom?: number };
    expect(style.paddingBottom).toBe(32);
  });

  it('grows the first-page skeleton padding with a nonzero system inset', () => {
    insetsState.bottom = 34;
    const renderer = mountLoading();

    const style = loadingView(renderer).props.style as { paddingBottom?: number };
    expect(style.paddingBottom).toBe(50);
  });
});
