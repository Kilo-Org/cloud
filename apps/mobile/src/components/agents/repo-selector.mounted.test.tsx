import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';
import { type RepoPlatform } from '@/lib/picker-bridge';
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

/**
 * The trigger's accessible name must match what it shows. With nothing chosen it
 * shows the field's own placeholder, so prefixing that placeholder with the field
 * name announced "Repository: Select repository".
 */
describe('Repository picker accessible name', () => {
  function mount(props: {
    value?: string;
    isLoading?: boolean;
    repositories?: { fullName: string; isPrivate: boolean; platform?: RepoPlatform }[];
  }): { renderer: TestRenderer.ReactTestRenderer; unmount: () => void } {
    const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
    act(() => {
      ref.current = TestRenderer.create(
        createElement(RepoSelector, {
          value: props.value ?? '',
          repositories: props.repositories ?? [],
          recents: [],
          organizationId: null,
          onChange: vi.fn<(repo: string) => void>(),
          isLoading: props.isLoading ?? false,
          disabled: false,
        })
      );
    });
    const renderer = ref.current;
    if (!renderer) {
      throw new Error('Renderer was not created');
    }
    return {
      renderer,
      unmount: () => {
        act(() => {
          renderer.unmount();
        });
      },
    };
  }

  function triggerName(renderer: TestRenderer.ReactTestRenderer): unknown {
    return renderer.root.findByProps({ accessibilityRole: 'button' }).props.accessibilityLabel;
  }

  it('announces the empty placeholder once, never the field name as its own value', () => {
    const { renderer, unmount } = mount({});

    expect(triggerName(renderer)).toBe('Select repository');
    expect(triggerName(renderer)).not.toBe('Repository: Select repository');

    unmount();
  });

  it('keeps the field prefix on a chosen repository', () => {
    const { renderer, unmount } = mount({
      value: 'github:acme/api',
      repositories: [{ fullName: 'acme/api', isPrivate: false, platform: 'github' }],
    });

    expect(triggerName(renderer)).toBe('Repository: GitHub · acme/api');

    unmount();
  });

  it('keeps the field prefix while the list loads', () => {
    const { renderer, unmount } = mount({ isLoading: true });

    expect(triggerName(renderer)).toBe('Repository: Loading...');

    unmount();
  });
});
