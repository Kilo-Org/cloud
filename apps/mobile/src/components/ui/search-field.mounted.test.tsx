import { type ComponentProps, createElement } from 'react';
import { type TextInput } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SearchField } from './search-field';
import { INPUT_FRAME_CLASS } from './input-frame';
import { act, TestRenderer } from '@/test/renderer';
import '@/i18n';

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  TextInput: 'TextInput',
  View: 'View',
}));
// The shared `Input` has its own suite; here it is a host that leaves the
// caller's ref alone, so the test's ref stands in for the native field.
vi.mock('@/components/ui/input', () => ({
  Input: ({ ref: _ref, ...props }: Record<string, unknown>) => createElement('TextInput', props),
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/icons', () => ({ Search: 'Search', X: 'X' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#111111', mutedForeground: '#666666' }),
}));

const clear = vi.fn();
let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

afterEach(() => {
  clear.mockReset();
  act(() => {
    renderer?.unmount();
  });
  renderer = undefined;
});

function mount(props: Partial<ComponentProps<typeof SearchField>> = {}) {
  const onChangeText = vi.fn<(text: string) => void>();
  const inputRef = { current: { clear } as unknown as TextInput };
  act(() => {
    renderer = TestRenderer.create(
      createElement(SearchField, {
        placeholder: 'Search models',
        hasText: false,
        onChangeText,
        inputRef,
        ...props,
      })
    );
  });
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return { root: renderer.root, onChangeText };
}

const hosts = (root: TestRenderer.ReactTestInstance, type: string) =>
  root.findAll(node => (node.type as unknown) === type);

const hint = (root: TestRenderer.ReactTestInstance) =>
  hosts(root, 'Text').filter(node => node.props.children === 'Search models');

function pressClear(root: TestRenderer.ReactTestInstance) {
  const press = hosts(root, 'Pressable')[0]?.props.onPress as (() => void) | undefined;
  if (!press) {
    throw new Error('the clear control did not mount');
  }
  act(() => {
    press();
  });
}

describe('SearchField', () => {
  it('draws the bordered field surface, not a pill', () => {
    const { root } = mount();
    const [frame] = hosts(root, 'View');
    expect(frame?.props.className).toContain(INPUT_FRAME_CLASS);
    expect(frame?.props.className).not.toContain('rounded-full');
  });

  it('shows a one-line hint instead of the native placeholder while empty', () => {
    const { root } = mount();
    const [input] = hosts(root, 'TextInput');
    expect(input?.props.placeholder).toBeUndefined();
    expect(input?.props.accessibilityLabel).toBe('Search models');
    const [line] = hint(root);
    expect(line?.props.numberOfLines).toBe(1);
    expect(line?.props.ellipsizeMode).toBe('tail');
    expect(line?.parent?.props.pointerEvents).toBe('none');
    expect(hosts(root, 'Pressable')).toHaveLength(0);
  });

  it('hides the hint and offers the clear while it holds text', () => {
    const { root } = mount({ hasText: true });
    expect(hint(root)).toHaveLength(0);
    expect(hosts(root, 'Pressable')).toHaveLength(1);
  });

  it('clears the native text and reports the empty query', () => {
    const { root, onChangeText } = mount({ hasText: true });
    pressClear(root);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(onChangeText).toHaveBeenCalledWith('');
  });

  it('hands the clear to the caller when it owns the query', () => {
    const onClear = vi.fn<() => void>();
    const { root, onChangeText } = mount({ hasText: true, onClear });
    pressClear(root);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onChangeText).not.toHaveBeenCalled();
  });

  it('swaps the magnifier for a spinner in the same slot while busy', () => {
    const { root } = mount({ busy: true, busyLabel: 'Searching' });
    expect(hosts(root, 'Search')).toHaveLength(0);
    expect(hosts(root, 'ActivityIndicator')[0]?.props.accessibilityLabel).toBe('Searching');
  });
});
