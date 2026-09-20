import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { MIN_TAP_TARGET_DP, TOUCH_TARGET_DP } from '@/lib/a11y/tap-target';

import { SessionListHeaderActions } from './session-list-header-actions';
import '@/i18n';

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

function pressesWithLabel(root: I, label: string): I[] {
  return root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'Pressable' &&
      node.props.accessibilityLabel === label
  );
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
