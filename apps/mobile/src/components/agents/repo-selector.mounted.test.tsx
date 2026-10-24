import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';
import { RepoSelector } from './repo-selector';

const push = vi.hoisted(() => vi.fn());
vi.mock('expo-router', () => ({ useRouter: () => ({ push }) }));
vi.mock('react-native', () => ({
  Keyboard: { dismiss: vi.fn() },
  Pressable: 'Pressable',
}));
vi.mock('@/components/ui/icons', () => ({ ChevronDown: 'ChevronDown' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#777777' }),
}));

afterEach(() => vi.clearAllMocks());

describe('Repository picker admission', () => {
  it.each([
    { isLoading: false, disabled: false, canOpen: true },
    { isLoading: true, disabled: false, canOpen: false },
    { isLoading: false, disabled: true, canOpen: false },
  ])('handles an empty list with $isLoading loading and $disabled disabled', options => {
    const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
    act(() => {
      ref.current = TestRenderer.create(
        createElement(RepoSelector, {
          value: '',
          repositories: [],
          recents: [],
          organizationId: null,
          onChange: vi.fn<(repo: string) => void>(),
          isLoading: options.isLoading,
          disabled: options.disabled,
        })
      );
    });
    const renderer = ref.current;
    if (!renderer) {
      throw new Error('Renderer was not created');
    }
    const trigger = renderer.root.findByProps({ accessibilityRole: 'button' });
    const props = trigger.props as {
      accessibilityState: { disabled: boolean };
      onPress: () => void;
    };
    expect(props.accessibilityState.disabled).toBe(!options.canOpen);
    act(() => {
      props.onPress();
    });
    expect(push).toHaveBeenCalledTimes(options.canOpen ? 1 : 0);
    act(() => {
      renderer.unmount();
    });
  });
});
