// Tap geometry of the session search field's clear (X) control: the size audit
// measures the frame a control renders, so this guards the frame that replaced
// the 16pt glyph AND the field height that keeps the list from shifting when
// the first keystroke reveals the button.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { compiledLengthDp } from '@/test/native-dimensions';
import { describe, expect, it, vi } from 'vitest';

import { SessionListSearchHeader } from './session-list-search-header';
import { FIELD_CLEAR_BOX_CLASS, MIN_TAP_TARGET_DP, TOUCH_TARGET_DP } from '@/lib/a11y/tap-target';

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
// `@/components/ui/input` merges its box with `cn`, which imports `@/i18n`;
// this pure suite does not mount the app's i18n instance.
vi.mock('@/lib/utils', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
}));

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
      String(node.props.className).includes('rounded-md')
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

    // The glyph is 16pt; sized to it the audit reported 16dp. The shared clear
    // box carries the whole target on the control's own node, so no slop is
    // needed toward the field beside it.
    const className = clear.props.className as string;
    expect(className).toContain(FIELD_CLEAR_BOX_CLASS);
    expect(className).toContain('items-center');
    expect(clear.props.hitSlop).toBeUndefined();

    // The box's dp follows the compiled class rather than a literal.
    const box = {
      height: await compiledLengthDp(className, 'height'),
      width: await compiledLengthDp(className, 'width'),
    };
    expect(box.height).toBeGreaterThanOrEqual(MIN_TAP_TARGET_DP);
    expect(box.width).toBeGreaterThanOrEqual(MIN_TAP_TARGET_DP);
    // Past 44pt, not onto it: `@/lib/a11y/tap-target` records a 44dp target
    // measuring 43.81dp at density 420.
    expect(box.height).toBeGreaterThan(TOUCH_TARGET_DP);
    expect(box.width).toBeGreaterThan(TOUCH_TARGET_DP);

    renderer.unmount();
  });

  it('draws the field from the shared box, so the X cannot change its height', () => {
    const withText = mount(true);
    const withoutText = mount(false);

    // Same field in both states: the X appears on the first keystroke and must
    // not move the list below it. The field's floor is the shared input box's
    // `min-h-[44px]`, and the clear box cancels its extra height with a
    // negative vertical margin, so the row class carries no height of its own
    // and cannot shift.
    const fieldWithText = fieldOf(withText);
    const fieldWithoutText = fieldOf(withoutText);
    expect(fieldWithText.props.className).toBe(fieldWithoutText.props.className);
    expect(fieldWithText.props.className).not.toMatch(/(?:^|\s)min-h-/);

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
