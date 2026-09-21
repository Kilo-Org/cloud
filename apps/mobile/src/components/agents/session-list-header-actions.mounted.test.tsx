// eslint-disable-next-line import/no-nodejs-modules -- Use the compiler's compatible CommonJS export.
import { createRequire } from 'node:module';
import tailwindcss from '@tailwindcss/postcss';
import postcss from 'postcss';
import { createElement } from 'react';
import type * as NativeCSSCompiler from 'react-native-css/compiler';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { MIN_TAP_TARGET_DP, TOUCH_TARGET_DP } from '@/lib/a11y/tap-target';

import { SessionListHeaderActions } from './session-list-header-actions';
import '@/i18n';

const { compile } = createRequire(import.meta.url)(
  'react-native-css/compiler'
) as typeof NativeCSSCompiler;

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
}));

vi.mock('@/components/ui/icons', () => ({
  Plus: 'Plus',
  SlidersHorizontal: 'SlidersHorizontal',
}));

// The real `@/components/ui/text` loads `@rn-primitives/slot`, whose node_modules
// `.mjs` contains JSX that this pipeline cannot transform. The header rendered
// here only needs the node to exist.
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#111111', mutedForeground: '#666666' }),
}));

type R = TestRenderer.ReactTestRenderer;
type I = TestRenderer.ReactTestInstance;

/** The box a control's className declares, in dp: its own height and width. */
function boxDp(className: string): { width: number; height: number } {
  const size = (axis: 'h' | 'w'): number => {
    const pattern = new RegExp(`^(?:min-)?${axis}-\\[(\\d+(?:\\.\\d+)?)px\\]$`);
    for (const part of className.split(/\s+/)) {
      const match = pattern.exec(part);
      if (match?.[1]) {
        return Number(match[1]);
      }
    }
    throw new Error(`no ${axis} size class in "${className}"`);
  };
  return { width: size('w'), height: size('h') };
}

/** The smallest per-side reach a hitSlop expresses, in dp. */
function slopDp(hitSlop: unknown): number {
  if (typeof hitSlop === 'number') {
    return hitSlop;
  }
  if (hitSlop && typeof hitSlop === 'object') {
    const sides = Object.values(hitSlop as Record<string, number | undefined>);
    return Math.min(...sides.map(side => side ?? 0));
  }
  return 0;
}

/** One side's reach, from a hitSlop that is one number for every side or per-side insets. */
function slopSideDp(hitSlop: unknown, side: keyof Insets): number {
  if (typeof hitSlop === 'number') {
    return hitSlop;
  }
  if (hitSlop && typeof hitSlop === 'object') {
    return (hitSlop as Partial<Insets>)[side] ?? 0;
  }
  return 0;
}

function pressesWithLabel(root: I, label: string): I[] {
  return root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'Pressable' &&
      node.props.accessibilityLabel === label
  );
}

/** The dp a compiled react-native-css length resolves to, following var fallbacks. */
function resolveCompiledLength(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (!Array.isArray(value)) {
    throw new TypeError(`cannot resolve compiled length ${JSON.stringify(value)}`);
  }
  // A descriptor is either one term ([guards, kind, ...]) or a list of terms.
  const term = (value[1] === 'var' || value[1] === 'calc' ? value : value[0]) as unknown[];
  if (term[1] === 'var') {
    return resolveCompiledLength((term[2] as [string, unknown])[1]);
  }
  if (term[1] === 'calc') {
    return resolveCalc(term[2] as unknown[]);
  }
  throw new Error(`cannot resolve compiled length ${JSON.stringify(value)}`);
}

function resolveCalc(expression: unknown[]): number {
  let total = resolveCompiledLength(expression[0]);
  for (let index = 1; index + 1 < expression.length; index += 2) {
    const operator = expression[index];
    const operand = resolveCompiledLength(expression[index + 1]);
    if (operator === '*') {
      total *= operand;
    } else if (operator === '/') {
      total /= operand;
    } else if (operator === '+') {
      total += operand;
    } else if (operator === '-') {
      total -= operand;
    } else {
      throw new Error(`unsupported calc operator ${String(operator)}`);
    }
  }
  return total;
}

/** The dp a row's `gap-*` class compiles to, through the app's own pipeline. */
async function compiledGapDp(rowClassName: string): Promise<number> {
  const gapClass = rowClassName.split(/\s+/).find(part => part.startsWith('gap-'));
  if (!gapClass) {
    throw new Error(`no gap class in "${rowClassName}"`);
  }
  // Use the app's theme and installed compilers, not a hand-written utility-to-point map.
  const { css } = await postcss([tailwindcss()]).process(
    `@reference "../../global.css"; .target { @apply ${gapClass}; }`,
    { from: import.meta.filename }
  );
  const rules = compile(css, { inlineVariables: false }).stylesheet().s;
  const declarations =
    rules?.find(([name]) => name === 'target')?.[1].flatMap(rule => rule.d ?? []) ?? [];
  const gap = declarations.find(declaration => declaration[1] === 'gap');
  if (!gap) {
    throw new Error(`no compiled gap declaration in "${gapClass}"`);
  }
  return resolveCompiledLength(gap[0]);
}

type Insets = { top: number; right: number; bottom: number; left: number };

/**
 * A control's hitSlop as per-side insets. Controls here use either shape: the
 * shared `IconButton` passes per-side insets, while `SessionFilterButton` keeps
 * the scalar `@/lib/a11y/touch-target` slop, where one number applies to every
 * side.
 */
function hitSlopInsets(hitSlop: unknown): Insets {
  if (typeof hitSlop === 'number') {
    return { top: hitSlop, right: hitSlop, bottom: hitSlop, left: hitSlop };
  }
  if (hitSlop && typeof hitSlop === 'object') {
    const insets = hitSlop as Partial<Insets>;
    if (typeof insets.right === 'number' && typeof insets.left === 'number') {
      return {
        top: insets.top ?? 0,
        right: insets.right,
        bottom: insets.bottom ?? 0,
        left: insets.left,
      };
    }
  }
  throw new Error(`no measurable hitSlop in ${JSON.stringify(hitSlop)}`);
}

const noop = (): void => undefined;

async function mountHeader(showNewSession: boolean, onNewSession: () => void): Promise<R> {
  const ref: { current: R | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(
      createElement(SessionListHeaderActions, {
        activeFilterCount: 0,
        showNewSession,
        onNewSession,
        onOpenFilters: noop,
      })
    );
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

describe('SessionListHeaderActions new-session control', () => {
  it('gives the control a >= 28dp box and a >= 44pt reach that opens a new session', async () => {
    const onNewSession = vi.fn<() => void>();
    const renderer = await mountHeader(true, onNewSession);

    const controls = pressesWithLabel(renderer.root, 'New session');
    expect(controls).toHaveLength(1);
    const control = controls[0];
    if (!control) {
      throw new Error('new-session control not found');
    }

    const box = boxDp(control.props.className as string);
    expect(box.width).toBeGreaterThanOrEqual(MIN_TAP_TARGET_DP);
    expect(box.height).toBeGreaterThanOrEqual(MIN_TAP_TARGET_DP);

    const slop = slopDp(control.props.hitSlop);
    expect(box.width + 2 * slop).toBeGreaterThanOrEqual(TOUCH_TARGET_DP);
    expect(box.height + 2 * slop).toBeGreaterThanOrEqual(TOUCH_TARGET_DP);

    act(() => {
      (control.props.onPress as () => void)();
    });
    expect(onNewSession).toHaveBeenCalledTimes(1);

    act(() => {
      renderer.unmount();
    });
  });

  it('meets the filter control at the row gap instead of overlapping its touch region', async () => {
    const renderer = await mountHeader(true, noop);

    const newSession = pressesWithLabel(renderer.root, 'New session')[0];
    const filter = pressesWithLabel(renderer.root, 'Filter sessions')[0];
    if (!newSession || !filter) {
      throw new Error('header controls not found');
    }

    const row = renderer.root.find(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'View' &&
        typeof node.props.className === 'string' &&
        node.props.className.split(/\s+/).includes('gap-4')
    );
    const gapDp = await compiledGapDp(row.props.className as string);
    // NativeWind v5 fixes 1rem at 14pt, so the row's `gap-4` is 14pt, not 16pt.
    expect(gapDp).toBe(14);

    const newSessionSlop = hitSlopInsets(newSession.props.hitSlop);
    // Either control may express hitSlop as one number or as per-side insets;
    // read the filter's facing reach through the same normalizer.
    const filterSlop = hitSlopInsets(filter.props.hitSlop);
    // The new-session control sits left of the filter, so the gap has to fit
    // both facing slops; more than the gap means the two regions overlap.
    expect(
      slopSideDp(newSessionSlop, 'right') + slopSideDp(filterSlop, 'left')
    ).toBeLessThanOrEqual(gapDp);
    // Capping the right side must not drop the control below the design target.
    const box = boxDp(newSession.props.className as string);
    expect(
      box.width + slopSideDp(newSessionSlop, 'left') + slopSideDp(newSessionSlop, 'right')
    ).toBeGreaterThanOrEqual(TOUCH_TARGET_DP);

    act(() => {
      renderer.unmount();
    });
  });

  it('renders no new-session control when showNewSession is false', async () => {
    const renderer = await mountHeader(false, noop);

    expect(
      renderer.root.findAll(node => node.props.accessibilityLabel === 'New session')
    ).toHaveLength(0);
    // The filter control sharing the row is untouched either way.
    expect(pressesWithLabel(renderer.root, 'Filter sessions')).toHaveLength(1);

    act(() => {
      renderer.unmount();
    });
  });
});
