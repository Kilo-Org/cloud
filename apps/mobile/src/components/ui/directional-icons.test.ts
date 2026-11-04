import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, TestRenderer } from '@/test/renderer';

import { DirectionalArrowLeft } from './directional-icons';

// Live, so a test can flip the interface direction before it renders: the
// wrapper picks its icon from `I18nManager.isRTL` on every render.
const i18nManager = vi.hoisted(() => ({ isRTL: false }));

vi.mock('react-native', () => ({ I18nManager: i18nManager }));

vi.mock('@/components/ui/icons', () => ({
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  ChevronLeft: 'ChevronLeft',
  ChevronRight: 'ChevronRight',
}));

function renderArrow(): TestRenderer.ReactTestRenderer {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  act(() => {
    renderer = TestRenderer.create(createElement(DirectionalArrowLeft, { size: 13 }));
  });
  // eslint-disable-next-line typescript-eslint/no-unnecessary-condition
  if (!renderer) {
    throw new Error('Failed to create test renderer');
  }
  return renderer;
}

afterEach(() => {
  i18nManager.isRTL = false;
});

describe('DirectionalArrowLeft', () => {
  it('points left in an LTR interface', () => {
    const renderer = renderArrow();

    expect(renderer.root.findAllByType('ArrowLeft')).toHaveLength(1);
    expect(renderer.root.findAllByType('ArrowRight')).toHaveLength(0);

    renderer.unmount();
  });

  it('points right in an RTL interface, so the flow still reads back to its source', () => {
    i18nManager.isRTL = true;
    const renderer = renderArrow();

    expect(renderer.root.findAllByType('ArrowRight')).toHaveLength(1);
    expect(renderer.root.findAllByType('ArrowLeft')).toHaveLength(0);

    renderer.unmount();
  });
});
