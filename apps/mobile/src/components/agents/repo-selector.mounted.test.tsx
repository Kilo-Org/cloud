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
  View: 'View',
}));
vi.mock('@/components/ui/icons', () => ({ ChevronDown: 'ChevronDown' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#777777' }),
}));

afterEach(() => vi.clearAllMocks());

type MountOptions = {
  value?: string;
  isLoading?: boolean;
  disabled?: boolean;
  repositories?: { fullName: string; isPrivate: boolean; platform?: RepoPlatform }[];
};

function mountSelector(options: MountOptions = {}): {
  renderer: TestRenderer.ReactTestRenderer;
  unmount: () => void;
} {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(RepoSelector, {
        value: options.value ?? '',
        repositories: options.repositories ?? [],
        recents: [],
        organizationId: null,
        onChange: vi.fn<(repo: string) => void>(),
        isLoading: options.isLoading ?? false,
        disabled: options.disabled ?? false,
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

/** The class list a node renders, split into single class names. */
function classesOf(node: TestRenderer.ReactTestInstance | undefined): string[] {
  const className: unknown = node?.props.className;
  return typeof className === 'string' ? className.split(' ') : [];
}

/** The frame that announces a busy field: the loading skeleton's own field. */
function loadingFrame(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    node => (node.props.accessibilityState as { busy?: boolean } | undefined)?.busy === true
  )[0] as TestRenderer.ReactTestInstance | undefined;
}

describe('Repository picker admission', () => {
  it.each([
    { disabled: false, canOpen: true },
    { disabled: true, canOpen: false },
  ])('opens the picker from the settled field unless it is disabled ($disabled)', options => {
    const { renderer, unmount } = mountSelector({ disabled: options.disabled });
    const props = renderer.root.findByProps({ accessibilityRole: 'button' }).props as {
      accessibilityState: { disabled: boolean };
      onPress: () => void;
    };

    expect(props.accessibilityState.disabled).toBe(!options.canOpen);
    act(() => {
      props.onPress();
    });
    expect(push).toHaveBeenCalledTimes(options.canOpen ? 1 : 0);

    unmount();
  });

  it('never offers the loading field as a button', () => {
    const { renderer, unmount } = mountSelector({ isLoading: true });

    expect(renderer.root.findAllByProps({ accessibilityRole: 'button' })).toHaveLength(0);
    expect(renderer.root.findAll(node => String(node.type) === 'Pressable')).toHaveLength(0);

    unmount();
  });
});

/**
 * The trigger's accessible name must match what it shows. With nothing chosen it
 * shows the field's own placeholder, so prefixing that placeholder with the field
 * name announced "Repository: Select repository".
 */
describe('Repository picker accessible name', () => {
  function triggerName(renderer: TestRenderer.ReactTestRenderer): unknown {
    return renderer.root.findByProps({ accessibilityRole: 'button' }).props.accessibilityLabel;
  }

  it('announces the empty placeholder once, never the field name as its own value', () => {
    const { renderer, unmount } = mountSelector();

    expect(triggerName(renderer)).toBe('Select repository');
    expect(triggerName(renderer)).not.toBe('Repository: Select repository');

    unmount();
  });

  it('keeps the field prefix on a chosen repository', () => {
    const { renderer, unmount } = mountSelector({
      value: 'github:acme/api',
      repositories: [{ fullName: 'acme/api', isPrivate: false, platform: 'github' }],
    });

    expect(triggerName(renderer)).toBe('Repository: GitHub · acme/api');

    unmount();
  });

  it('names the loading field as loading instead of an open placeholder', () => {
    const { renderer, unmount } = mountSelector({ isLoading: true });

    const loading = loadingFrame(renderer);
    expect(loading).toBeDefined();
    expect(loading?.props.accessibilityLabel).toBe('Repository: Loading...');

    unmount();
  });
});

/** The loading field is the branch row's skeleton: a bar that becomes a name. */
describe('Repository picker loading field', () => {
  it('paints the loading bar in the undimmed field frame', () => {
    const { renderer, unmount } = mountSelector({ isLoading: true });

    // `bg-muted-soft`, not the default `bg-skeleton-fill`: in the light palette
    // that fill equals this frame's `bg-secondary`, where the bar paints nothing.
    const bar = renderer.root.findAllByType('Skeleton' as never)[0];
    expect(classesOf(bar)).toEqual(expect.arrayContaining(['h-4', 'w-1/3', 'bg-muted-soft']));
    expect(classesOf(bar)).not.toContain('bg-skeleton-fill');

    const frame = classesOf(loadingFrame(renderer));
    expect(frame).toEqual(
      expect.arrayContaining(['rounded-lg', 'border-border', 'bg-secondary', 'px-3', 'flex-row'])
    );
    // A skeleton is an honest wait, not a refusal: the loading field is not dimmed.
    expect(frame).not.toContain('opacity-50');

    expect(renderer.root.findAllByType('ChevronDown' as never)).toHaveLength(1);

    unmount();
  });

  it('keeps the chosen repository on screen while the list refetches', () => {
    const { renderer, unmount } = mountSelector({
      value: 'github:acme/api',
      repositories: [{ fullName: 'acme/api', isPrivate: false, platform: 'github' }],
      isLoading: true,
    });

    expect(renderer.root.findAllByType('Skeleton' as never)).toHaveLength(0);
    expect(
      renderer.root.findByProps({ accessibilityRole: 'button' }).props.accessibilityLabel
    ).toBe('Repository: GitHub · acme/api');

    unmount();
  });
});
