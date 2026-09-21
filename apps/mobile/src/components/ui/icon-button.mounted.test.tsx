// eslint-disable-next-line import/no-nodejs-modules -- Use the compiler's compatible CommonJS export.
import { createRequire } from 'node:module';
import tailwindcss from '@tailwindcss/postcss';
import postcss from 'postcss';
import { createElement, type ReactElement } from 'react';
import { Pressable } from 'react-native';
import type * as NativeCSSCompiler from 'react-native-css/compiler';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  COMPACT_CONTROL_HIT_SLOP_DP,
  MIN_TAP_TARGET_DP,
  tapTargetReachDp,
  TOUCH_TARGET_DP,
} from '@/lib/a11y/tap-target';

import { IconButton, type IconButtonProps } from './icon-button';

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Pressable: 'Pressable',
}));

const { compile } = createRequire(import.meta.url)(
  'react-native-css/compiler'
) as typeof NativeCSSCompiler;
let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function render(element: ReactElement) {
  act(() => {
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing IconButton renderer');
  }
  return renderer.root.findByType(Pressable);
}

function renderIconButton({
  children = createElement('Icon', null),
  accessibilityLabel = 'New session',
  ...props
}: IconButtonProps = {}) {
  return render(createElement(IconButton, { accessibilityLabel, ...props }, children));
}

/** The compiled height and width of the element's own box, from its classes. */
async function nativeBox(button: TestRenderer.ReactTestInstance) {
  const dimensions = (button.props.className as string)
    .split(' ')
    .filter(className => /^(?:min-h|h|w)-/.test(className))
    .join(' ');
  // Use the app's theme and installed compilers, not a hand-written utility-to-point map.
  const { css } = await postcss([tailwindcss()]).process(
    `@reference "../../global.css"; .target { @apply ${dimensions}; }`,
    { from: import.meta.filename }
  );
  const rules = compile(css, { inlineVariables: false }).stylesheet().s;
  const declarations =
    rules?.find(([name]) => name === 'target')?.[1].flatMap(rule => rule.d ?? []) ?? [];
  const box: Record<string, number> = {};
  for (const declaration of declarations) {
    for (const [property, value] of Object.entries(declaration)) {
      if (typeof value === 'number') {
        box[property] = value;
      }
    }
  }
  const { height, width } = box;
  if (height === undefined || width === undefined) {
    throw new Error(`IconButton box has no compiled height/width: ${JSON.stringify(declarations)}`);
  }
  return { height, width };
}

/** The per-side slop, whether the control passed a number or an insets object. */
function perSideHitSlop(hitSlop: unknown): number {
  if (typeof hitSlop === 'number') {
    return hitSlop;
  }
  const insets = hitSlop as { top: number; right: number; bottom: number; left: number };
  return Math.min(insets.top, insets.right, insets.bottom, insets.left);
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe('IconButton native target contract', () => {
  // These assertions protect compiled host dimensions; native F2 must still measure the target.
  it('renders an own box that meets the control-size audit floor on both sides', async () => {
    const box = await nativeBox(renderIconButton());
    expect(box.height).toBeGreaterThanOrEqual(MIN_TAP_TARGET_DP);
    expect(box.width).toBeGreaterThanOrEqual(MIN_TAP_TARGET_DP);
    expect(box).toEqual({ height: 32, width: 32 });
  });

  it('reaches the design touch target from the box plus its per-side slop', async () => {
    const button = renderIconButton();
    const box = await nativeBox(button);
    const slop = perSideHitSlop(button.props.hitSlop);
    expect(slop).toBe(COMPACT_CONTROL_HIT_SLOP_DP);
    expect(tapTargetReachDp(box.height, slop)).toBeGreaterThanOrEqual(TOUCH_TARGET_DP);
    expect(tapTargetReachDp(box.width, slop)).toBeGreaterThanOrEqual(TOUCH_TARGET_DP);
  });

  it('centres its child and keeps the caller identity', () => {
    const button = renderIconButton({
      accessibilityLabel: 'New session',
      testID: 'agents-new-session',
      className: 'bg-accent-soft',
    });
    expect(button.props.className).toContain('items-center');
    expect(button.props.className).toContain('justify-center');
    expect(button.props.className).toContain('bg-accent-soft');
    expect(button.props.accessibilityRole).toBe('button');
    expect(button.props.accessibilityLabel).toBe('New session');
    expect(button.props.testID).toBe('agents-new-session');
    expect(button.findByType('Icon')).toBeDefined();
  });

  it('fires the caller onPress', () => {
    const onPress = vi.fn<() => void>();
    const button = renderIconButton({ onPress });
    act(() => {
      (button.props.onPress as () => void)();
    });
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('keeps an explicit hitSlop and accessibilityRole from the caller', () => {
    const button = renderIconButton({ hitSlop: 12, accessibilityRole: 'header' });
    expect(button.props.hitSlop).toBe(12);
    expect(button.props.accessibilityRole).toBe('header');
  });
});
