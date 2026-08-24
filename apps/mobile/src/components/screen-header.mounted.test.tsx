/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as composer-paste-button.mounted.test.tsx) */
import { type ComponentProps, createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ScreenHeader } from './screen-header';

const routerState = vi.hoisted(() => ({
  back: vi.fn(),
  canGoBack: vi.fn(() => true),
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ back: routerState.back, canGoBack: routerState.canGoBack }),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock('@/components/ui/icons', () => ({
  ChevronDown: 'ChevronDown',
  ChevronLeft: 'ChevronLeft',
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/eyebrow', () => ({ Eyebrow: 'Eyebrow' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000' }),
}));

type ScreenHeaderProps = ComponentProps<typeof ScreenHeader>;
type TestInstance = TestRenderer.ReactTestInstance;

function isBackPressable(node: TestInstance): boolean {
  return (
    typeof node.type === 'string' &&
    (node.type as string) === 'Pressable' &&
    (node.props.accessibilityLabel === 'Go back' || node.props.accessibilityLabel === 'Close')
  );
}

function findBackPressable(root: TestInstance): TestInstance {
  const nodes = root.findAll(isBackPressable);
  const node = nodes[0];
  if (!node) {
    throw new Error('back pressable not found');
  }
  return node;
}

function backPressableCount(root: TestInstance): number {
  return root.findAll(isBackPressable).length;
}

function findTitlePressable(root: TestInstance): TestInstance {
  const nodes = root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'Pressable' &&
      node.props.accessibilityLabel !== 'Go back' &&
      node.props.accessibilityLabel !== 'Close'
  );
  const node = nodes[0];
  if (!node) {
    throw new Error('title pressable not found');
  }
  return node;
}

function findIcon(back: TestInstance, type: string): TestInstance {
  const icons = back.findAll(node => typeof node.type === 'string' && node.type === type);
  const icon = icons[0];
  if (!icon) {
    throw new Error(`${type} icon not found`);
  }
  return icon;
}

function deriveTitleFontSize(className: string): number {
  const arbitrary = /text-\[(\d+)px\]/.exec(className);
  if (arbitrary) {
    return Number(arbitrary[1]);
  }
  if (className.includes('text-lg')) {
    return 18;
  }
  throw new Error(`no known title font size in class: ${className}`);
}

function renderHeader(props: ScreenHeaderProps): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(ScreenHeader, props));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

describe('ScreenHeader mounted', () => {
  beforeEach(() => {
    routerState.back.mockClear();
    routerState.canGoBack.mockClear();
    routerState.canGoBack.mockReturnValue(true);
  });

  it('gives the back control a 44-point target and no hit slop', () => {
    const renderer = renderHeader({ title: 'Sessions' });

    const back = findBackPressable(renderer.root);
    expect(back.props.className).toContain('h-11 w-11');
    expect(back.props.className).toContain('items-center');
    expect(back.props.className).toContain('justify-center');
    expect(back.props.className).toContain('-ml-4');
    expect(back.props.className).toContain('shrink-0');
    expect(back.props.className).toContain('active:opacity-70');
    expect(back.props.className).not.toContain('mr-1');
    expect(back.props.hitSlop).toBeUndefined();
  });

  it('keeps the title hit slop asymmetric so it never overlaps the back target', () => {
    const renderer = renderHeader({ title: 'Sessions', onTitlePress: () => undefined });

    const title = findTitlePressable(renderer.root);
    expect(title.props.hitSlop).toEqual({ top: 13, right: 13, bottom: 13, left: 0 });
  });

  it('gives the interactive title at least a 44-point reachable target', () => {
    const cases: ScreenHeaderProps[] = [
      { title: 'Sessions', onTitlePress: () => undefined },
      { title: 'Sessions', size: 'large', onTitlePress: () => undefined },
    ];

    for (const props of cases) {
      const renderer = renderHeader(props);
      const title = findTitlePressable(renderer.root);
      const hitSlop = title.props.hitSlop as { top: number; bottom: number };
      expect(hitSlop.top).toBeGreaterThanOrEqual(13);
      expect(hitSlop.bottom).toBeGreaterThanOrEqual(13);

      const texts = title.findAll(
        node => typeof node.type === 'string' && (node.type as string) === 'Text'
      );
      const text = texts[0];
      if (!text) {
        throw new Error('title text not found');
      }
      const fontSize = deriveTitleFontSize(text.props.className as string);
      // The rendered font size plus the 13pt top/bottom slop must clear 44pt.
      expect(fontSize + hitSlop.top + hitSlop.bottom).toBeGreaterThanOrEqual(44);
    }
  });

  it('calls router.back() by default and onBack when provided', () => {
    const renderer = renderHeader({ title: 'Sessions' });
    const back = findBackPressable(renderer.root);
    act(() => {
      (back.props.onPress as () => void)();
    });
    expect(routerState.back).toHaveBeenCalledTimes(1);

    const onBack = vi.fn(() => undefined);
    const customRenderer = renderHeader({ title: 'Sessions', onBack });
    const customBack = findBackPressable(customRenderer.root);
    act(() => {
      (customBack.props.onPress as () => void)();
    });
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(routerState.back).toHaveBeenCalledTimes(1);
  });

  it('runs only the pressed control action', () => {
    const onTitlePress = vi.fn(() => undefined);
    const renderer = renderHeader({ title: 'Sessions', onTitlePress });

    const back = findBackPressable(renderer.root);
    act(() => {
      (back.props.onPress as () => void)();
    });
    expect(onTitlePress).not.toHaveBeenCalled();
    expect(routerState.back).toHaveBeenCalledTimes(1);

    const title = findTitlePressable(renderer.root);
    act(() => {
      (title.props.onPress as () => void)();
    });
    expect(onTitlePress).toHaveBeenCalledTimes(1);
    expect(routerState.back).toHaveBeenCalledTimes(1);
  });

  it('labels the title with the override or the default open-menu label', () => {
    const renderer = renderHeader({ title: 'Sessions', onTitlePress: () => undefined });
    expect(findTitlePressable(renderer.root).props.accessibilityLabel).toBe(
      'Open menu for Sessions'
    );

    const customRenderer = renderHeader({
      title: 'Sessions',
      onTitlePress: () => undefined,
      onTitlePressAccessibilityLabel: 'Rename session',
    });
    expect(findTitlePressable(customRenderer.root).props.accessibilityLabel).toBe('Rename session');
  });

  it('renders the close icon and label for backIcon="close"', () => {
    const renderer = renderHeader({ title: 'Sessions', backIcon: 'close' });

    const back = findBackPressable(renderer.root);
    expect(back.props.accessibilityLabel).toBe('Close');
    const closeIcon = findIcon(back, 'ChevronDown');
    expect(closeIcon.props.size).toBe(24);
    expect(
      back.findAll(node => typeof node.type === 'string' && (node.type as string) === 'ChevronLeft')
    ).toHaveLength(0);
  });

  it('renders the back icon and label by default', () => {
    const renderer = renderHeader({ title: 'Sessions' });

    const back = findBackPressable(renderer.root);
    expect(back.props.accessibilityLabel).toBe('Go back');
    const backIcon = findIcon(back, 'ChevronLeft');
    expect(backIcon.props.size).toBe(24);
  });

  it('hides the back control when no route exists and forces it with showBackButton', () => {
    routerState.canGoBack.mockReturnValue(false);

    const hidden = renderHeader({ title: 'Sessions' });
    expect(backPressableCount(hidden.root)).toBe(0);

    const forced = renderHeader({ title: 'Sessions', showBackButton: true });
    expect(backPressableCount(forced.root)).toBe(1);

    const explicitlyHidden = renderHeader({ title: 'Sessions', showBackButton: false });
    expect(backPressableCount(explicitlyHidden.root)).toBe(0);
  });

  it('keeps the back bar and target classes when title is absent', () => {
    const renderer = renderHeader({});

    const back = findBackPressable(renderer.root);
    expect(back.props.className).toContain('h-11 w-11');
    expect(back.props.className).toContain('items-center justify-center');
    expect(back.props.hitSlop).toBeUndefined();
  });

  it('renders every layout variant without error and keeps the back classes', () => {
    const variants: ScreenHeaderProps[] = [
      { title: 'Sessions' },
      { title: 'Sessions', size: 'large' },
      { title: 'Sessions', modal: true },
      { title: 'Sessions', eyebrow: 'Agents' },
      { title: 'Sessions', headerRight: 'RIGHT' },
    ];

    for (const props of variants) {
      const renderer = renderHeader(props);
      const back = findBackPressable(renderer.root);
      expect(back.props.className).toContain('h-11 w-11');
      expect(back.props.className).toContain('items-center');
      expect(back.props.className).toContain('justify-center');
    }
  });
});
