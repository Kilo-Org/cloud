import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { PrDiffFileListHeader } from './pr-diff-file-list-header';

const insets = vi.hoisted(() => ({ top: 0, bottom: 0, left: 0, right: 0 }));
const routerPush = vi.fn();

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: routerPush }),
}));

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => insets,
}));

vi.mock('@/components/ui/icons', () => ({
  Columns2: () => null,
  Rows3: () => null,
}));

vi.mock('@/components/ui/radio-group', () => ({
  RadioGroup: 'RadioGroup',
  radioItemA11y: () => ({}),
}));

vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-is-tablet', () => ({ useIsTablet: () => false }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    foreground: '#000000',
    mutedForeground: '#6F6A61',
  }),
}));

const baseProps = {
  owner: 'octocat',
  repo: 'hello',
  number: 7,
  viewedCount: 1,
  totalListed: 3,
  isTruncated: false,
  viewMode: 'unified' as const,
  onViewModeChange: vi.fn(),
};

function mountHeader(): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(PrDiffFileListHeader, baseProps));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function findNavigatorPressable(
  root: TestRenderer.ReactTestInstance
): TestRenderer.ReactTestInstance {
  return root.findByProps({ accessibilityLabel: 'Open file navigator' });
}

describe('PrDiffFileListHeader side insets (landscape)', () => {
  beforeEach(() => {
    insets.top = 0;
    insets.bottom = 0;
    insets.left = 0;
    insets.right = 0;
    routerPush.mockClear();
  });

  it('keeps the row styleless at zero portrait insets', () => {
    const renderer = mountHeader();
    const pressable = findNavigatorPressable(renderer.root);

    // Portrait no-op: no wrapper style keys, so the `px-4` className gutter
    // renders byte-identical to an inset-free header.
    expect(pressable.parent?.props.style).toBeUndefined();
  });

  it('clears the sensor housing with the landscape side insets', () => {
    insets.left = 47;
    insets.right = 59;
    const renderer = mountHeader();
    const pressable = findNavigatorPressable(renderer.root);

    // The insets land on an inner wrapper so they ADD to the `px-4` gutter
    // (an inline padding on the bordered container would beat the className
    // and swallow the gutter).
    expect(pressable.parent?.props.style).toEqual({
      paddingLeft: 47,
      paddingRight: 59,
    });
    // The full-width background and hairline stay on the outer container.
    expect(pressable.parent?.parent?.props.className).toContain('bg-background');
    expect(pressable.parent?.parent?.props.className).toContain('border-b');
  });

  it('opens the file navigator when the entry is pressed', () => {
    const renderer = mountHeader();
    const pressable = findNavigatorPressable(renderer.root);

    const onPress = (pressable.props as { onPress?: () => void }).onPress;
    act(() => {
      onPress?.();
    });

    expect(routerPush).toHaveBeenCalledTimes(1);
    expect(routerPush).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: '/(app)/pr-review/[owner]/[repo]/[number]/file-navigator',
        params: { owner: 'octocat', repo: 'hello', number: 7 },
      })
    );
  });
});
