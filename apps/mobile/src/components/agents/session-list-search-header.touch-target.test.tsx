// Tap geometry of the session search field's clear (X) control: the size audit
// measures the frame a control renders, so this guards the frame that replaced
// the 16pt glyph AND the field height that keeps the list from shifting when
// the first keystroke reveals the button.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { compiledDimensions } from '@/test/native-dimensions';
import { describe, expect, it, vi } from 'vitest';

import { SessionListSearchHeader } from './session-list-search-header';
import {
  COMPACT_CONTROL_HIT_SLOP_DP,
  MIN_TAP_TARGET_DP,
  TOUCH_TARGET_DP,
} from '@/lib/a11y/tap-target';

type Insets = { top: number; right: number; bottom: number; left: number };

/** The clear control's `hitSlop` as per-side insets, validating the shape. */
function slopInsets(hitSlop: unknown): Insets {
  if (typeof hitSlop !== 'object' || hitSlop === null) {
    throw new TypeError(`no measurable hitSlop in ${JSON.stringify(hitSlop)}`);
  }
  const insets = hitSlop as Partial<Insets>;
  if (
    typeof insets.top !== 'number' ||
    typeof insets.right !== 'number' ||
    typeof insets.bottom !== 'number' ||
    typeof insets.left !== 'number'
  ) {
    throw new TypeError(`no measurable hitSlop in ${JSON.stringify(hitSlop)}`);
  }
  return { top: insets.top, right: insets.right, bottom: insets.bottom, left: insets.left };
}

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Pressable: 'Pressable',
  TextInput: 'TextInput',
  View: 'View',
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ left: 0, right: 0 }),
}));
vi.mock('@/components/ui/icons', () => ({ Search: 'Search', X: 'X' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#6F6A61' }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

function mount(hasText: boolean): TestRenderer.ReactTestRenderer {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  act(() => {
    renderer = TestRenderer.create(
      createElement(SessionListSearchHeader, {
        inputRef: { current: null },
        hasText,
        showSearchBusy: false,
        onChangeText: vi.fn<(text: string) => void>(),
        onClearSearch: vi.fn<() => void>(),
      })
    );
  });
  // eslint-disable-next-line typescript-eslint/no-unnecessary-condition -- act() may not assign
  if (!renderer) {
    throw new Error('SessionListSearchHeader did not mount');
  }
  return renderer;
}

function fieldOf(renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance {
  return renderer.root.find(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'View' &&
      String(node.props.className).includes('min-h-[51px]')
  );
}

describe('SessionListSearchHeader clear button touch target', () => {
  it('measures the clear button frame, not its 16pt glyph', async () => {
    const renderer = mount(true);
    const clear = renderer.root.find(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Pressable' &&
        node.props.accessibilityLabel === 'common.clearSearch'
    );

    // The glyph is 16pt; sized to it the audit reported 16dp. The frame is
    // what the audit measures and the slop on top of it carries the reach past
    // the 44pt target. One box width/height pair only: compiling the class is
    // what proves the real box, so a second, conflicting pair cannot hide
    // behind the order Tailwind emits its rules in.
    expect(clear.props.className).toContain('h-[38px] w-[38px]');
    expect(clear.props.className).toContain('items-center');
    const slop = slopInsets(clear.props.hitSlop);
    expect(slop.top).toBe(COMPACT_CONTROL_HIT_SLOP_DP);
    expect(slop.right).toBe(COMPACT_CONTROL_HIT_SLOP_DP);
    expect(slop.bottom).toBe(COMPACT_CONTROL_HIT_SLOP_DP);
    // The left side stops at the row's `gap-2` (7pt at the app's 14pt rem) so
    // the control's touch region meets the input's instead of covering it.
    expect(slop.left).toBe(7);

    const declarations = (await compiledDimensions(clear.props.className as string)) as {
      height?: number;
      width?: number;
    }[];
    const box = Object.assign({}, ...declarations) as { height: number; width: number };
    expect(box.height).toBeGreaterThanOrEqual(MIN_TAP_TARGET_DP);
    expect(box.width).toBeGreaterThanOrEqual(MIN_TAP_TARGET_DP);
    // Past 44pt, not onto it: `@/lib/a11y/tap-target` records a 44dp target
    // measuring 43.81dp at density 420.
    expect(box.height + slop.top + slop.bottom).toBeGreaterThan(TOUCH_TARGET_DP);
    expect(box.width + slop.left + slop.right).toBeGreaterThan(TOUCH_TARGET_DP);

    renderer.unmount();
  });

  it('reserves the target height in the field so the button never grows it', () => {
    const withText = mount(true);
    const withoutText = mount(false);

    // Same field height in both states: the X appears on the first keystroke
    // and must not move the list below it. A single `min-h` class, so the
    // effective floor cannot depend on Tailwind's emit order. The floor covers
    // the 38pt control plus the row's padding and border; the compiled guard in
    // `session-list-search-header.mounted.test.tsx` holds the arithmetic.
    const fieldWithText = fieldOf(withText);
    const fieldWithoutText = fieldOf(withoutText);
    expect(fieldWithText.props.className).toContain('min-h-[51px]');
    expect(fieldWithText.props.className).not.toContain('min-h-[44px]');
    expect(fieldWithoutText.props.className).toBe(fieldWithText.props.className);

    const clear = withText.root.find(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Pressable' &&
        node.props.accessibilityLabel === 'common.clearSearch'
    );
    // The clear button sits in the field's own row.
    expect(clear.parent).toBe(fieldWithText);

    withText.unmount();
    withoutText.unmount();
  });
});
