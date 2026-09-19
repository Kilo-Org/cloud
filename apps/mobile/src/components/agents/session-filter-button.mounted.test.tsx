import { createElement } from 'react';
import { Pressable, View } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SlidersHorizontal } from '@/components/ui/icons';
import { i18n } from '@/i18n';
import { nativeDimensions } from '@/test/native-dimensions.test-helpers';
import { act, TestRenderer } from '@/test/renderer';
import { SessionFilterButton } from './session-filter-button';

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('@/components/ui/icons', () => ({ SlidersHorizontal: 'SlidersHorizontal' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#14130f', mutedForeground: '#6f6a61' }),
}));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
const onPress = vi.fn<() => void>();

function render(activeCount: number) {
  const element = createElement(SessionFilterButton, {
    activeCount,
    onPress,
    testID: 'agents-open-filters',
  });
  act(() => {
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing session filter renderer');
  }
  return renderer.root.findByType(Pressable);
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('SessionFilterButton native target', () => {
  it.each([0, 1, 3])('keeps a 44-point target with %i active filters', async activeCount => {
    const button = render(activeCount);
    expect(await nativeDimensions(button.props.className as string)).toEqual([
      { height: 44, width: 44 },
    ]);
    expect((button.props.className as string).split(' ')).toContain('shrink-0');
    expect(button.props.hitSlop).toBeUndefined();
    expect(button.props.accessibilityRole).toBe('button');
    const title = i18n.t('agentChat.sessionFilter.title');
    expect(button.props.accessibilityLabel).toBe(activeCount ? `${title}, ${activeCount}` : title);
    expect(button.findByType(SlidersHorizontal).props.size).toBe(20);

    act(() => {
      (button.props.onPress as () => void)();
    });
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('keeps the same target when filters are applied and cleared', async () => {
    const button = render(0);
    const dimensions = await nativeDimensions(button.props.className as string);
    expect(button.findAllByProps({ testID: 'session-filter-badge' })).toHaveLength(0);

    expect(render(2)).toBe(button);
    expect(await nativeDimensions(button.props.className as string)).toEqual(dimensions);
    expect(button.findByProps({ testID: 'session-filter-badge' }).props.children).toBe(2);
    expect(button.findAllByType(View).some(view => view.props.pointerEvents === 'none')).toBe(true);

    expect(render(0)).toBe(button);
    expect(await nativeDimensions(button.props.className as string)).toEqual(dimensions);
    expect(button.findAllByProps({ testID: 'session-filter-badge' })).toHaveLength(0);
  });
});
