// eslint-disable-next-line import/no-nodejs-modules -- Use the compiler's compatible CommonJS export.
import { createRequire } from 'node:module';
import tailwindcss from '@tailwindcss/postcss';
import postcss from 'postcss';
import { createRef, type ReactElement } from 'react';
import { type TextInput } from 'react-native';
import type * as NativeCSSCompiler from 'react-native-css/compiler';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, TestRenderer } from '@/test/renderer';

import '@/i18n';
import { SessionFilterButton } from './session-filter-button';
import { SessionListSearchHeader } from './session-list-search-header';

vi.mock('react-native', () => ({ Pressable: 'Pressable', TextInput: 'TextInput', View: 'View' }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 47, right: 59 }),
}));
vi.mock('@/components/ui/icons', () => ({
  SlidersHorizontal: 'SlidersHorizontal',
  Search: 'Search',
  X: 'X',
}));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#000000', foreground: '#111111' }),
}));

const renderers: TestRenderer.ReactTestRenderer[] = [];
const { compile } = createRequire(import.meta.url)(
  'react-native-css/compiler'
) as typeof NativeCSSCompiler;

const searchProps = {
  inputRef: createRef<TextInput | null>(),
  hasText: false,
  showSearchBusy: false,
  onChangeText: () => undefined,
  onClearSearch: () => undefined,
};

async function nativeDimensions(node: TestRenderer.ReactTestInstance) {
  const dimensions = (node.props.className as string)
    .split(' ')
    .filter(className => /^(?:h|w)-/.test(className))
    .join(' ');
  const { css } = await postcss([tailwindcss()]).process(
    `@reference "../../global.css"; .target { @apply ${dimensions}; }`,
    { from: import.meta.filename }
  );
  // Match Metro's options, including the compiler's default 14-point inlineRem.
  const rules = compile(css, { inlineVariables: false }).stylesheet().s;
  return rules?.find(([name]) => name === 'target')?.[1].flatMap(rule => rule.d ?? []);
}

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

describe('Session list control touch targets', () => {
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

  it.each([0, 2])(
    'has a 44-point target with %s active filters without relying on hitSlop',
    async activeCount => {
      const onPress = vi.fn<() => void>();
      const renderer = await mount(
        <SessionFilterButton activeCount={activeCount} onPress={onPress} />
      );
      const button = renderer.root.findByType('Pressable');
      expect(await nativeDimensions(button)).toEqual([{ height: 44, width: 44 }]);
      expect(button.props.className).toContain('shrink-0');
      expect(button.props.hitSlop).toBeUndefined();
      expect(button.props.accessibilityRole).toBe('button');
      expect(button.props.accessibilityLabel).toBe(
        activeCount ? `Filter sessions, ${activeCount}` : 'Filter sessions'
      );
      await act(() => {
        (button.props.onPress as () => void)();
      });
      expect(onPress).toHaveBeenCalledOnce();
      if (activeCount) {
        const badge = renderer.root.findByProps({ testID: 'session-filter-badge' });
        expect(badge.parent?.props.pointerEvents).toBe('none');
      } else {
        expect(renderer.root.findAllByProps({ testID: 'session-filter-badge' })).toHaveLength(0);
      }
    }
  );

  it.each([false, true])(
    'keeps a 44-point clear target and its action while search is busy=%s',
    async showSearchBusy => {
      const onClearSearch = vi.fn<() => void>();
      const renderer = await mount(
        <SessionListSearchHeader
          {...searchProps}
          hasText
          showSearchBusy={showSearchBusy}
          onClearSearch={onClearSearch}
        />
      );
      const clear = renderer.root.findByType('Pressable');
      expect(await nativeDimensions(clear)).toEqual([{ height: 44, width: 44 }]);
      expect(clear.props.className).toContain('shrink-0');
      expect(clear.props.accessibilityRole).toBe('button');
      expect(clear.props.accessibilityLabel).toBe('Clear search');
      expect(clear.props.hitSlop).toBeUndefined();
      await act(() => {
        (clear.props.onPress as () => void)();
      });
      expect(onClearSearch).toHaveBeenCalledOnce();
      expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(showSearchBusy ? 1 : 0);
    }
  );

  it('reserves the clear target space without exposing an action for an empty query', async () => {
    const renderer = await mount(<SessionListSearchHeader {...searchProps} hasText />);
    const input = renderer.root.findByType('TextInput');
    const rowClasses = input.parent?.props.className;
    await act(() => {
      renderer.update(<SessionListSearchHeader {...searchProps} />);
    });
    expect(renderer.root.findByType('TextInput')).toBe(input);
    expect(input.parent?.props.className).toBe(rowClasses);
    expect(renderer.root.findAllByType('Pressable')).toHaveLength(0);
    const spacer = input.parent?.children.at(-1);
    if (!spacer || typeof spacer === 'string') {
      throw new Error('Missing clear target spacer');
    }
    expect(spacer.type).toBe('View');
    expect(await nativeDimensions(spacer)).toEqual([{ height: 44, width: 44 }]);
    expect(spacer.props.className).toContain('shrink-0');
    expect(spacer.props.pointerEvents).toBe('none');
  });
});
