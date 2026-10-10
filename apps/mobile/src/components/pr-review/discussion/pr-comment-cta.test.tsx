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
const platformState = vi.hoisted(() => ({ OS: 'ios' }));

vi.mock('react-native', () => ({
  View: 'View',
  Platform: platformState,
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

/** The keyboard-lift wrapper the bar rides while the Discussion tab is focused. */
function liftView(renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance {
  return renderer.root.find(node => String(node.type) === 'KeyboardAvoidingView');
}

describe('PrCommentCta', () => {
  beforeEach(() => {
    platformState.OS = 'ios';
    insetsState.bottom = 0;
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
    // The lift view adds nothing while the keyboard is closed; the bar's own
    // `useDetailScreenBottomPadding` (max(bottom, 16) + 16) clears the safe area.
    expect(paddingValues(renderer)).toEqual([50]);
  });

  it('lifts above the keyboard while it is open', () => {
    const renderer = mountCta();
    // The bar rides a padding-behavior keyboard lift. On iOS the reported frame
    // already reaches the screen bottom, so the lift takes no inset correction.
    const lift = liftView(renderer);
    expect(lift.props.behavior).toBe('padding');
    expect(lift.props.keyboardVerticalOffset).toBe(0);
  });

  it("lifts by the raw Android metric, which the bar's own inset padding completes", () => {
    // The bar's inner padding already includes the platform's bottom inset
    // (`useDetailScreenBottomPadding`), so the Android lift is reduced by that
    // inset (a negative `keyboardVerticalOffset`) and the button never floats a
    // navigation-bar height above the keyboard (2026-09-21 review finding).
    platformState.OS = 'android';
    insetsState.bottom = 63;
    const renderer = mountCta();
    expect(liftView(renderer).props.keyboardVerticalOffset).toBe(-63);
    expect(paddingValues(renderer)).toEqual([79]);
  });

  it('does not mount the lift while it is gated off', () => {
    // The host passes keyboardLift=false when another surface owns the
    // keyboard (the conversation-comment formSheet): the bar must not even
    // mount the lift view, or a foreign keyboard shrinks the list viewport
    // behind the sheet and parks the last thread's reply field under the bar
    // (uxs3 spot check, e4-confirm-discard).
    const renderer = mountCta({ keyboardLift: false });
    expect(
      renderer.root.findAll(node => String(node.type) === 'KeyboardAvoidingView')
    ).toHaveLength(0);
    // The bar itself still renders; only the lift wrapper is gone.
    expect(renderer.root.find(node => String(node.type) === 'Button')).toBeDefined();
    // useDetailScreenBottomPadding floors the reported inset: max(0, 16) + 16.
    expect(paddingValues(renderer)).toEqual([32]);
  });
});
