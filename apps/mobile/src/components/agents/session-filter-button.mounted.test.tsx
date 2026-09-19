// eslint-disable-next-line import/no-nodejs-modules -- Use the compiler's CommonJS entry, like Metro; its ESM entry cannot import debug in Node.
import { createRequire } from 'node:module';
import { type ComponentProps } from 'react';
import { Pressable } from 'react-native';
import type * as NativeCompiler from 'react-native-css/compiler';
import { compile as compileTailwind } from 'tailwindcss';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SlidersHorizontal } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { act, TestRenderer } from '@/test/renderer';
import { SessionFilterButton } from './session-filter-button';

const { compile: compileNative } = createRequire(import.meta.url)(
  'react-native-css/compiler'
) as typeof NativeCompiler;

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('@/components/ui/icons', () => ({ SlidersHorizontal: 'SlidersHorizontal' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#111111', mutedForeground: '#777777' }),
}));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

afterEach(() => {
  renderer?.unmount();
  renderer = undefined;
});

function renderButton(activeCount: number, onPress = vi.fn<() => void>()) {
  act(() => {
    const element = (
      <SessionFilterButton
        activeCount={activeCount}
        onPress={onPress}
        testID="agents-open-filters"
      />
    );
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing filter button');
  }
  return renderer.root.findByType(Pressable);
}

describe('SessionFilterButton', () => {
  it.each([0, 1, 12])('reserves a nonshrinking 44dp target with %s filters', activeCount => {
    const button = renderButton(activeCount);
    const props = button.props as ComponentProps<typeof Pressable>;

    // Native hitSlop is clipped to the parent. The layout box itself must
    // provide the full touch target at the trailing edge of either header.
    expect(props.className?.split(' ')).toEqual(
      expect.arrayContaining(['h-[44px]', 'w-[44px]', 'shrink-0', 'items-center', 'justify-center'])
    );
    expect(props.hitSlop).toBeUndefined();
    expect(button.findByType(SlidersHorizontal).props.size).toBe(20);
  });

  it('compiles the target to 44 native units rather than rem-scaled spacing', async () => {
    const button = renderButton(0);
    const props = button.props as ComponentProps<typeof Pressable>;
    const utilities = await compileTailwind('@tailwind utilities;');
    const css = utilities.build(props.className?.split(' ') ?? []);
    const sheet = compileNative(css, { inlineVariables: false }).stylesheet();
    const rules = Object.fromEntries(sheet.s ?? []);

    for (const [utility, declaration] of [
      ['h-[44px]', { height: 44 }],
      ['w-[44px]', { width: 44 }],
      ['shrink-0', { flexShrink: 0 }],
    ] as const) {
      expect(rules[utility]).toEqual(
        expect.arrayContaining([expect.objectContaining({ d: [declaration] })])
      );
    }
  });

  it('preserves the target and action as filters are applied and cleared', () => {
    const onPress = vi.fn<() => void>();
    const initial = renderButton(0, onPress);
    const className = initial.props.className;
    const label = i18n.t('agentChat.sessionFilter.title');

    for (const count of [0, 2, 12, 0]) {
      const button = renderButton(count, onPress);
      expect(button).toBe(initial);
      expect(button.props.className).toBe(className);
      expect(button.props.accessibilityRole).toBe('button');
      expect(button.props.accessibilityLabel).toBe(count > 0 ? `${label}, ${count}` : label);
      expect(button.props.testID).toBe('agents-open-filters');
      expect(button.props.className).toContain('active:opacity-70');
      expect(button.findByType(SlidersHorizontal).props.color).toBe(
        count > 0 ? '#111111' : '#777777'
      );
      const badges = button.findAllByType(Text);
      expect(badges).toHaveLength(count > 0 ? 1 : 0);
      if (count > 0) {
        const badge = button.findByType(Text);
        expect(badge.props.children).toBe(count);
        expect(badge.parent?.props.pointerEvents).toBe('none');
        expect(badge.parent?.props.className).toContain('absolute -right-1.5 -top-1.5');
        expect(badge.parent?.parent).toBe(button.findByType(SlidersHorizontal).parent);
      }
      act(() => {
        (button.props.onPress as () => void)();
      });
    }
    expect(onPress).toHaveBeenCalledTimes(4);
  });
});
