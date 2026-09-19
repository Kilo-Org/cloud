// The bottom CTA bar: static chrome that wraps a full-width primary Button.
// Covers the label/icon/role wiring, the press wiring, the safe-area padding
// while the keyboard is closed, and the keyboard-open lift (the request:
// bottom action accessible with the keyboard open).

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import type * as ReactI18next from 'react-i18next';
import { PrCommentCta } from './pr-comment-cta';

vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return {
    ...actual,
    useTranslation: () => {
      const i18n = actual.getI18n();
      return { t: i18n.t.bind(i18n), i18n };
    },
  };
});

const insetsState = vi.hoisted(() => ({ bottom: 0 }));
// Every mounted listener for one event, in registration order: the lift view
// and the bar inside it each measure the same keyboard, so a test fires them
// together the way the platform does.
const keyboardSubscribers = vi.hoisted(() => ({
  show: [] as ((event: { endCoordinates: { height: number; screenY: number } }) => void)[],
  hide: [] as (() => void)[],
}));

vi.mock('react-native', () => ({
  View: 'View',
  Platform: { OS: 'ios' },
  Dimensions: { get: () => ({ height: 900 }) },
  Keyboard: {
    addListener: vi.fn((event: string, listener: (event?: unknown) => void) => {
      if (event === 'keyboardWillShow') {
        keyboardSubscribers.show.push(
          listener as (event: { endCoordinates: { height: number; screenY: number } }) => void
        );
      }
      if (event === 'keyboardWillHide') {
        keyboardSubscribers.hide.push(listener as () => void);
      }
      return { remove: vi.fn() };
    }),
  },
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => insetsState,
}));

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ primaryForeground: '#000000' }),
}));

vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({ MessageSquarePlus: 'MessageSquarePlus' }));

const BASE_PROPS = {
  onPress: vi.fn(() => undefined),
  keyboardLift: true,
};

function mountCta(props: Partial<typeof BASE_PROPS> = {}): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(PrCommentCta, { ...BASE_PROPS, ...props }));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function showKeyboard(height: number, screenY: number) {
  expect(keyboardSubscribers.show.length).toBeGreaterThan(0);
  act(() => {
    for (const listener of keyboardSubscribers.show) {
      listener({ endCoordinates: { height, screenY } });
    }
  });
}

function paddedViews(renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance[] {
  return renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'View' &&
      node.props.style != null &&
      // AppAwareKeyboardPaddingView passes a style ARRAY ([style, {paddingBottom}]);
      // the inner safe-area view passes an object.
      (Array.isArray(node.props.style)
        ? node.props.style.some((part: unknown) => {
            if (part == null || typeof part !== 'object') {
              return false;
            }
            return 'paddingBottom' in part;
          })
        : 'paddingBottom' in (node.props.style as Record<string, unknown>))
  );
}

function paddingValues(renderer: TestRenderer.ReactTestRenderer): number[] {
  return paddedViews(renderer).flatMap(node => {
    const style = node.props.style;
    const parts = Array.isArray(style) ? style : [style];
    return parts
      .filter(
        (part): part is Record<string, unknown> =>
          part != null && typeof part === 'object' && 'paddingBottom' in part
      )
      .map(part => part.paddingBottom as number);
  });
}

describe('PrCommentCta', () => {
  beforeEach(() => {
    insetsState.bottom = 0;
    keyboardSubscribers.show = [];
    keyboardSubscribers.hide = [];
    BASE_PROPS.onPress.mockClear();
  });

  it('renders the primary comment button with the CTA copy and role', () => {
    const renderer = mountCta();
    const button = renderer.root.find(node => String(node.type) === 'Button');
    expect(button.props.onPress).toBe(BASE_PROPS.onPress);
    expect(button.props.accessibilityRole).toBe('button');
    expect(button.props.accessibilityLabel).toBe('Comment on this pull request');
    expect(renderer.root.find(node => String(node.type) === 'MessageSquarePlus')).toBeDefined();
    const label = renderer.root.find(node => String(node.type) === 'Text');
    expect(label.props.children).toBe('Comment on this pull request');
  });

  it('press pushes through the onPress wiring', () => {
    const renderer = mountCta();
    act(() => {
      (renderer.root.find(node => String(node.type) === 'Button').props.onPress as () => void)();
    });
    expect(BASE_PROPS.onPress).toHaveBeenCalledTimes(1);
  });

  it('pads above the device safe area while the keyboard is closed', () => {
    insetsState.bottom = 34;
    const renderer = mountCta();
    const paddings = paddingValues(renderer);
    // Keyboard-padding view reports 0 while closed; the inner view applies
    // useDetailScreenBottomPadding (max(bottom, 16) + 16).
    expect(paddings).toContain(0);
    expect(paddings).toContain(50);
  });

  it('lifts above the keyboard while it is open', () => {
    const renderer = mountCta();
    showKeyboard(336, 564);
    expect(paddingValues(renderer)).toContain(336);
  });

  it('yields the safe-area padding to the lift while the keyboard is open', () => {
    insetsState.bottom = 34;
    const renderer = mountCta();
    // While closed the bar clears the device safe area by itself.
    expect(paddingValues(renderer)).toContain(50);
    showKeyboard(336, 564);
    // The lift already covers the safe-area strip, so the bar keeps no
    // inset-tall blank band between itself and the keyboard.
    expect(paddingValues(renderer)).toEqual([336, 0]);
  });

  it('does not react to keyboard events at all while the lift is gated off', () => {
    // The host passes keyboardLift=false when another surface owns the
    // keyboard (the conversation-comment formSheet): the bar must not even
    // arm the padding view's listener, or a foreign keyboard shrinks the
    // list viewport behind the sheet and parks the last thread's reply field
    // under the bar (uxs3 spot check, e4-confirm-discard).
    const renderer = mountCta({ keyboardLift: false });
    expect(keyboardSubscribers.show).toEqual([]);
    expect(keyboardSubscribers.hide).toEqual([]);
    // The bar itself still renders; only the lift wrapper is gone.
    expect(renderer.root.find(node => String(node.type) === 'Button')).toBeDefined();
    expect(paddingValues(renderer)).not.toContain(0);
  });
});
