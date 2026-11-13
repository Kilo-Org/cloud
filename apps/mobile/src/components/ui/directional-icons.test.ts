import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, TestRenderer } from '@/test/renderer';

import {
  DirectionalArrowLeft,
  DirectionalArrowRight,
  DirectionalChevronLeft,
  DirectionalChevronRight,
  DirectionalLogOut,
} from './directional-icons';

// Live, so a test can flip the interface direction before it renders: the
// wrapper picks its icon from `I18nManager.isRTL` on every render.
const i18nManager = vi.hoisted(() => ({ isRTL: false }));

vi.mock('react-native', () => ({ I18nManager: i18nManager, View: 'View' }));

vi.mock('@/components/ui/icons', () => ({
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  ChevronLeft: 'ChevronLeft',
  ChevronRight: 'ChevronRight',
  LogOut: 'LogOut',
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

/** A caller style that carries more than one property, including its own transform step. */
const CALLER_STYLE = { marginTop: 7, transform: [{ rotate: '15deg' }] };

/** Count of horizontal-flip steps the rendered tree carries, at any nesting depth. */
function mirrorStepCount(style: unknown): number {
  if (Array.isArray(style)) {
    return style.reduce((total, entry) => total + mirrorStepCount(entry), 0);
  }
  if (style === null || typeof style !== 'object' || !('transform' in style)) {
    return 0;
  }
  const steps = style.transform;
  if (!Array.isArray(steps)) {
    return 0;
  }
  return steps.filter(
    (step: unknown) =>
      typeof step === 'object' && step !== null && 'scaleX' in step && step.scaleX === -1
  ).length;
}

/** Flip steps anywhere in the rendered tree: the wrapper may carry the flip itself. */
function treeMirrorStepCount(renderer: TestRenderer.ReactTestRenderer): number {
  let total = 0;
  for (const node of renderer.root.findAll(() => true)) {
    const style: unknown = node.props.style;
    total += mirrorStepCount(style);
  }
  return total;
}

function renderLogOut(props: { style?: typeof CALLER_STYLE } = {}): TestRenderer.ReactTestRenderer {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  act(() => {
    renderer = TestRenderer.create(createElement(DirectionalLogOut, { size: 13, ...props }));
  });
  // eslint-disable-next-line typescript-eslint/no-unnecessary-condition
  if (!renderer) {
    throw new Error('Failed to create test renderer');
  }
  return renderer;
}

/** The single log-out glyph the wrapper draws, so its own props can be asserted. */
function logOutIcon(renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance {
  const icons = renderer.root.findAllByType('LogOut');
  expect(icons).toHaveLength(1);
  const icon = icons.at(0);
  if (!icon) {
    throw new Error('Expected one log-out icon');
  }
  return icon;
}

/**
 * The sign-out arrow leaves the row toward the trailing edge in LTR, so an RTL
 * row needs the same glyph flipped to leave toward the start edge. Lucide ships
 * no mirrored log-out glyph, which is why this wrapper flips the glyph itself.
 */
describe('DirectionalLogOut', () => {
  it('draws one log-out glyph, unflipped, in an LTR interface', () => {
    const renderer = renderLogOut();

    expect(treeMirrorStepCount(renderer)).toBe(0);

    renderer.unmount();
  });

  it('flips the glyph exactly once in an RTL interface, so the arrow leaves toward the start edge', () => {
    i18nManager.isRTL = true;
    const renderer = renderLogOut();

    expect(treeMirrorStepCount(renderer)).toBe(1);

    renderer.unmount();
  });

  it('hands the caller style to the glyph untouched in an LTR interface', () => {
    const renderer = renderLogOut({ style: CALLER_STYLE });

    expect(logOutIcon(renderer).props.style).toEqual(CALLER_STYLE);

    renderer.unmount();
  });

  it('hands the caller style to the glyph untouched in an RTL interface, so no caller property is replaced', () => {
    i18nManager.isRTL = true;
    const renderer = renderLogOut({ style: CALLER_STYLE });

    const icon = logOutIcon(renderer);
    expect(icon.props.style).toEqual(CALLER_STYLE);
    expect(mirrorStepCount(icon.props.style)).toBe(0);
    expect(treeMirrorStepCount(renderer)).toBe(1);

    renderer.unmount();
  });
});
