import { createRef, type ElementType, type ReactElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type TextInput } from 'react-native';

import '@/i18n';
import { hitSlopPerSide, MIN_TAP_TARGET_DP, TOUCH_TARGET_DP } from '@/lib/a11y/tap-target';
import { SessionFilterButton } from './session-filter-button';
import { SessionListSearchHeader } from './session-list-search-header';

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  TextInput: 'TextInput',
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock('@/components/ui/icons', () => ({
  Search: 'Search',
  SlidersHorizontal: 'SlidersHorizontal',
  X: 'X',
}));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    foreground: '#111111',
    mutedForeground: '#666666',
    primary: '#000000',
    primaryForeground: '#ffffff',
  }),
}));

const renderers: TestRenderer.ReactTestRenderer[] = [];

async function mount(element: ReactElement) {
  await act(() => {
    renderers.push(TestRenderer.create(element));
  });
  const renderer = renderers.at(-1);
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function pressables(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(node => node.type === ('Pressable' as ElementType));
}

type Pressable = ReturnType<typeof pressables>[number];

/** The single Pressable the surface renders, or a failure naming the miss. */
function onlyPressable(renderer: TestRenderer.ReactTestRenderer): Pressable {
  const buttons = pressables(renderer);
  expect(buttons).toHaveLength(1);
  const button = buttons.at(0);
  if (!button) {
    throw new Error('control was not rendered');
  }
  return button;
}

/**
 * The finding's bar is the control's own box (its accessibility node, which
 * `hitSlop` never grows); DESIGN.md then wants the touch region up to 44pt.
 */
function expectMinimumTapTarget(pressable: Pressable) {
  const classes = pressable.props.className as string;
  expect(classes).toContain(`min-h-[${MIN_TAP_TARGET_DP}px]`);
  expect(classes).toContain(`min-w-[${MIN_TAP_TARGET_DP}px]`);
  const slop = pressable.props.hitSlop;
  expect(slop).toBe(hitSlopPerSide(MIN_TAP_TARGET_DP));
  expect(MIN_TAP_TARGET_DP + (slop as number) * 2).toBeGreaterThanOrEqual(TOUCH_TARGET_DP);
}

describe('agents-list icon controls meet the minimum tap target', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(() => {
    act(() => {
      for (const renderer of renderers.splice(0)) {
        renderer.unmount();
      }
    });
  });

  it('lays the filter button out in a box at least 28dp on a side', async () => {
    const renderer = await mount(
      <SessionFilterButton activeCount={1} onPress={() => undefined} testID="agents-open-filters" />
    );
    expectMinimumTapTarget(onlyPressable(renderer));
  });

  it('lays the clear-search button out in a box at least 28dp on a side', async () => {
    const renderer = await mount(
      <SessionListSearchHeader
        inputRef={createRef<TextInput | null>()}
        hasText
        showSearchBusy={false}
        onChangeText={() => undefined}
        onClearSearch={() => undefined}
      />
    );
    expectMinimumTapTarget(onlyPressable(renderer));
  });
});
