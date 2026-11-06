import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, TestRenderer } from '@/test/renderer';

import {
  DirectionalArrowLeft,
  DirectionalArrowRight,
  DirectionalChevronLeft,
  DirectionalChevronRight,
} from './directional-icons';

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

type DirectionalWrapper = typeof DirectionalArrowLeft;

/**
 * Every wrapper the module exports, with the glyph it draws in each direction.
 * In RTL the native direction mirrors the chrome, so each pair swaps: the
 * parameterised cases below are the whole contract, and a wrapper whose emblem
 * or direction is inverted fails here.
 */
const WRAPPERS = [
  {
    name: 'DirectionalChevronLeft',
    Component: DirectionalChevronLeft,
    ltr: 'ChevronLeft',
    rtl: 'ChevronRight',
  },
  {
    name: 'DirectionalChevronRight',
    Component: DirectionalChevronRight,
    ltr: 'ChevronRight',
    rtl: 'ChevronLeft',
  },
  {
    name: 'DirectionalArrowLeft',
    Component: DirectionalArrowLeft,
    ltr: 'ArrowLeft',
    rtl: 'ArrowRight',
  },
  {
    name: 'DirectionalArrowRight',
    Component: DirectionalArrowRight,
    ltr: 'ArrowRight',
    rtl: 'ArrowLeft',
  },
] as const;

function render(Component: DirectionalWrapper): TestRenderer.ReactTestRenderer {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  act(() => {
    renderer = TestRenderer.create(createElement(Component, { size: 13 }));
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

describe.each(WRAPPERS)('$name', ({ Component, ltr, rtl }) => {
  it(`points at ${ltr} in an LTR interface`, () => {
    const renderer = render(Component);

    expect(renderer.root.findAllByType(ltr)).toHaveLength(1);
    expect(renderer.root.findAllByType(rtl)).toHaveLength(0);

    renderer.unmount();
  });

  it(`mirrors to ${rtl} in an RTL interface, so the flow still reads back to its source`, () => {
    i18nManager.isRTL = true;
    const renderer = render(Component);

    expect(renderer.root.findAllByType(rtl)).toHaveLength(1);
    expect(renderer.root.findAllByType(ltr)).toHaveLength(0);

    renderer.unmount();
  });
});
