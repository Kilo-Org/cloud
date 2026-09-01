/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as composer-paste-button.mounted.test.tsx) */
import { type ComponentProps, createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ScreenHeader } from './screen-header';

const routerState = vi.hoisted(() => ({
  routes: ['previous-screen', 'session-detail'],
  back: vi.fn(),
  replace: vi.fn<(href: string) => void>(),
  canGoBack: vi.fn(() => true),
}));
const i18nManager = vi.hoisted(() => ({ isRTL: false }));

vi.mock('expo-router', () => ({
  useRouter: () => routerState,
}));
vi.mock('react-native', () => ({
  I18nManager: i18nManager,
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
  ChevronRight: 'ChevronRight',
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
  return root.find(node => isBackPressable(node));
}

function backPressableCount(root: TestInstance): number {
  return root.findAll(isBackPressable).length;
}

function findTitlePressable(root: TestInstance): TestInstance {
  return root.find(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'Pressable' &&
      node.props.accessibilityLabel !== 'Go back' &&
      node.props.accessibilityLabel !== 'Close'
  );
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
    routerState.routes = ['previous-screen', 'session-detail'];
    routerState.back.mockReset().mockImplementation(() => {
      routerState.routes.pop();
    });
    routerState.replace.mockReset().mockImplementation(href => {
      routerState.routes.splice(-1, 1, href);
    });
    routerState.canGoBack.mockReset().mockImplementation(() => routerState.routes.length > 1);
    i18nManager.isRTL = false;
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

  it('swaps the back and headerRight margins to the logical edges in RTL', () => {
    i18nManager.isRTL = true;
    const renderer = renderHeader({ title: 'Sessions', headerRight: 'RIGHT' });

    const back = findBackPressable(renderer.root);
    expect(back.props.className).toContain('-mr-4');
    expect(back.props.className).not.toContain('-ml-4');

    const headerRight = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'View' &&
        typeof node.props.className === 'string' &&
        (node.props.className.includes('ml-3') || node.props.className.includes('mr-3'))
    )[0];
    if (!headerRight) {
      throw new Error('headerRight view not found');
    }
    expect(headerRight.props.className).toContain('mr-3');
    expect(headerRight.props.className).not.toContain('ml-3');
    expect(headerRight.props.className).toContain('max-w-[50%]');
    expect(headerRight.props.className).toContain('shrink');
    expect(headerRight.props.className).not.toContain('shrink-0');
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

  it('returns to the previous screen by default', () => {
    const renderer = renderHeader({ title: 'Sessions' });
    act(() => {
      (findBackPressable(renderer.root).props.onPress as () => void)();
    });
    expect(routerState.routes).toEqual(['previous-screen']);
  });

  it.each([
    { history: ['previous-screen', 'session-detail'], destination: 'previous-screen' },
    { history: ['session-detail'], destination: '/(app)/(tabs)/(2_agents)' },
  ])(
    'returns from $history without retaining the session or opening its title',
    ({ history, destination }) => {
      routerState.routes = [...history];
      let titleOpened = false;
      const renderer = renderHeader({
        title: 'Session',
        backFallback: '/(app)/(tabs)/(2_agents)',
        onTitlePress: () => {
          titleOpened = true;
        },
      });
      act(() => {
        (findBackPressable(renderer.root).props.onPress as () => void)();
      });
      expect(routerState.routes).toEqual([destination]);
      expect(titleOpened).toBe(false);
      act(() => {
        (findTitlePressable(renderer.root).props.onPress as () => void)();
      });
      expect(titleOpened).toBe(true);
      expect(routerState.routes).toEqual([destination]);
    }
  );

  it.each([
    { history: true, backFallback: undefined },
    { history: true, backFallback: '/(app)/(tabs)/(2_agents)' },
    { history: false, backFallback: '/(app)/(tabs)/(2_agents)' },
  ] as const)(
    'preserves custom onBack precedence for history=$history, fallback=$backFallback',
    ({ history, backFallback }) => {
      routerState.routes = history ? ['previous-screen', 'session-detail'] : ['session-detail'];
      const initialRoutes = [...routerState.routes];
      let dismissed = false;
      const renderer = renderHeader({
        title: 'Session',
        backFallback,
        onBack: () => {
          dismissed = true;
        },
      });
      act(() => {
        (findBackPressable(renderer.root).props.onPress as () => void)();
      });
      expect(dismissed).toBe(true);
      expect(routerState.routes).toEqual(initialRoutes);
    }
  );

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

    const explicitlyHidden = renderHeader({
      title: 'Sessions',
      showBackButton: false,
      backFallback: '/(app)/(tabs)/(2_agents)',
    });
    expect(backPressableCount(explicitlyHidden.root)).toBe(0);
  });

  it('keeps the back bar and target classes when title is absent', () => {
    const renderer = renderHeader({});

    const back = findBackPressable(renderer.root);
    expect(back.props.className).toContain('h-11 w-11');
    expect(back.props.className).toContain('items-center justify-center');
    expect(back.props.hitSlop).toBeUndefined();
  });

  it('preserves title line limits and back controls across layout variants', () => {
    const longTitle = 'A long session name that must stay on one row. '.repeat(4);
    const variants: ScreenHeaderProps[] = [
      { title: 'Sessions' },
      { title: 'Agents', size: 'large' },
      { title: 'Home', size: 'large', contextPosition: 'right', context: 'ACCOUNT' },
      { title: 'Sessions', modal: true },
      { title: 'A long sheet title', centerTitle: true },
      { title: 'Sessions', eyebrow: 'Agents' },
      { title: 'Sessions', headerRight: 'RIGHT' },
      { title: longTitle, titleNumberOfLines: 1, headerRight: 'METRICS' },
      { title: longTitle, titleNumberOfLines: 1, onTitlePress: () => undefined },
    ];

    for (const props of variants) {
      const renderer = renderHeader(props);
      const back = findBackPressable(renderer.root);
      expect(back.props.className).toContain('h-11 w-11');
      expect(back.props.className).toContain('items-center');
      expect(back.props.className).toContain('justify-center');
      const title = renderer.root.findByProps({ accessibilityRole: 'header' });
      expect(title.props.numberOfLines).toBe(props.titleNumberOfLines ?? 2);
      expect(title.props.ellipsizeMode).toBe('tail');
      expect(title.children).toEqual([props.title]);
      if (props.modal || props.centerTitle) {
        expect(title.props.className).toContain('text-center');
        expect(title.parent?.parent).not.toBe(back.parent);
        expect(title.parent?.parent?.parent).toBe(back.parent?.parent?.parent);
      }
    }
  });
});
