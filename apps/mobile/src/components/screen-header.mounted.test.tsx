/* eslint-disable max-lines -- test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as composer-paste-button.mounted.test.tsx) */
// eslint-disable-next-line import/no-nodejs-modules -- The compiler's CommonJS export is the only way to load it under vitest.
import { createRequire } from 'node:module';
import tailwindcss from '@tailwindcss/postcss';
import postcss from 'postcss';
import { type ComponentProps, createElement } from 'react';
import type * as NativeCSSCompiler from 'react-native-css/compiler';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OFFLINE_BANNER_HEIGHT } from '@/lib/offline-banner-state';
import { ScreenHeader, shouldStackHeaderActions } from './screen-header';
import { OfflineBannerSpaceProvider } from './offline-banner-space';

const routerState = vi.hoisted(() => ({
  routes: ['previous-screen', 'session-detail'],
  back: vi.fn(),
  replace: vi.fn<(href: string) => void>(),
  canGoBack: vi.fn(() => true),
}));
const i18nManager = vi.hoisted(() => ({ isRTL: false }));
const safeArea = vi.hoisted(() => ({ top: 0, bottom: 0, left: 0, right: 0 }));
const platform = vi.hoisted(() => ({ OS: 'ios' as 'ios' | 'android' }));
/** A normal phone window: wide enough for the title and its actions to share a row. */
const layout = vi.hoisted(() => ({ width: 390, fontScale: 1 }));

vi.mock('expo-router', () => ({
  useRouter: () => routerState,
}));
vi.mock('react-native', () => ({
  I18nManager: i18nManager,
  Platform: platform,
  Pressable: 'Pressable',
  View: 'View',
  useWindowDimensions: () => ({ width: layout.width, height: 800, fontScale: layout.fontScale }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => safeArea,
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

/**
 * The row the header puts `headerRight` on when the window is too narrow for
 * the title and the actions to share one. Only that variant carries `mt-2`
 * without the single-row wrapper's `max-w-[50%]`.
 */
function isStackedActionsRow(node: TestInstance): boolean {
  const className = String(node.props.className ?? '');
  return (
    typeof node.type === 'string' &&
    (node.type as string) === 'View' &&
    className.includes('mt-2') &&
    !className.includes('max-w-[50%]')
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

function findOuterContainer(root: TestInstance): TestInstance {
  return root.find(node => typeof node.type === 'string' && (node.type as string) === 'View');
}

/**
 * The header body sits in an inner wrapper that carries only the landscape side
 * insets, so they add to the outer container's `px-4` gutter instead of
 * overriding it. It is the only View in the tree without a className.
 */
function findSideInsetWrapper(root: TestInstance): TestInstance {
  const wrappers = root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'View' &&
      node.props.className === undefined
  );
  const wrapper = wrappers[0];
  if (!wrapper) {
    throw new Error('side-inset wrapper not found');
  }
  return wrapper;
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

const { compile } = createRequire(import.meta.url)(
  'react-native-css/compiler'
) as typeof NativeCSSCompiler;

/** The property name(s) of one compiled style declaration. */
function declarationProperties(declaration: unknown): string[] {
  if (Array.isArray(declaration)) {
    const property: unknown = declaration[1];
    return typeof property === 'string' ? [property] : [];
  }
  return typeof declaration === 'object' && declaration !== null ? Object.keys(declaration) : [];
}

/**
 * The React Native style property each margin utility in a className compiles
 * to, through the app's own Tailwind and NativeWind compilers — not a
 * hand-written utility-to-property map.
 *
 * The physical/logical name matters: `ml`/`mr` compile to `marginLeft`/
 * `marginRight`, which Fabric rewrites to Yoga Start/End for an RTL tree when
 * `I18nManager.doLeftAndRightSwapInRTL` is on
 * (`YogaLayoutableShadowNode::swapLeftAndRightInYogaStyleProps`), while `ms`
 * compiles to `marginInlineStart`, already logical and passed through as
 * Yoga Start in both directions.
 */
async function compiledMarginProperties(className: string): Promise<string[]> {
  const margins = className
    .split(' ')
    .filter(token => /^-?m[slre]-/.test(token))
    .join(' ');
  const { css } = await postcss([tailwindcss()]).process(
    `@reference "../global.css"; .target { @apply ${margins}; }`,
    { from: import.meta.filename }
  );
  const rules = compile(css, { inlineVariables: false }).stylesheet().s;
  const declarations =
    rules?.find(([name]) => name === 'target')?.[1].flatMap(rule => rule.d ?? []) ?? [];
  return declarations.flatMap(declaration => declarationProperties(declaration));
}

function findHeaderRight(root: TestInstance): TestInstance {
  const headerRight = root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'View' &&
      typeof node.props.className === 'string' &&
      /(^|\s)-?m[slre]-[0-9]/.test(node.props.className)
  )[0];
  if (!headerRight) {
    throw new Error('headerRight view not found');
  }
  return headerRight;
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
    platform.OS = 'ios';
    Object.assign(safeArea, { top: 0, bottom: 0, left: 0, right: 0 });
    Object.assign(layout, { width: 390, fontScale: 1 });
  });

  it('gives the back control a 44-point target and no hit slop', () => {
    const renderer = renderHeader({ title: 'Sessions' });

    const back = findBackPressable(renderer.root);
    expect(back.props.className).toContain('h-11 w-11');
    expect(back.props.className).toContain('items-center');
    expect(back.props.className).toContain('justify-center');
    expect(back.props.className).toContain('-ms-4');
    expect(back.props.className).toContain('shrink-0');
    expect(back.props.className).toContain('active:opacity-70');
    expect(back.props.className).not.toContain('mr-1');
    expect(back.props.hitSlop).toBeUndefined();
  });

  it('pulls the leading controls with a logical start margin the RTL swap cannot mirror', async () => {
    const renderer = renderHeader({ title: 'Sessions', headerRight: 'RIGHT' });

    // The pull is on the START edge, so it must compile to the logical
    // `marginInlineStart`. A hand-picked `-mr-4` under RTL compiles to
    // `marginRight`, which Fabric rewrites to Yoga End for an RTL tree, landing
    // the pull on the side that faces the title: the heading then started 12
    // points under the 44-point back target and the title's box covered 0.27 of
    // it — the "two controls cover each other" finding (the scan reports above
    // 0.25). `-ms-4` keeps a real 4-point `gap-1` between the two controls in
    // both writing directions.
    const back = findBackPressable(renderer.root);
    expect(back.props.className).toContain('-ms-4');
    expect(await compiledMarginProperties(back.props.className as string)).toEqual([
      'marginInlineStart',
    ]);

    // The 12-point gap between the title and the cluster sits on the cluster's
    // start side, so it mirrors with the direction instead of leaving the two
    // touching and adding the space to the outer gutter.
    const headerRight = findHeaderRight(renderer.root);
    expect(headerRight.props.className).toContain('ms-3');
    expect(await compiledMarginProperties(headerRight.props.className as string)).toEqual([
      'marginInlineStart',
    ]);
    expect(headerRight.props.className).toContain('max-w-[50%]');
    expect(headerRight.props.className).toContain('shrink');
    expect(headerRight.props.className).not.toContain('shrink-0');
  });

  it('keeps the title hit slop asymmetric so it never overlaps the back target', () => {
    const renderer = renderHeader({ title: 'Sessions', onTitlePress: () => undefined });

    const title = findTitlePressable(renderer.root);
    expect(title.props.hitSlop).toEqual({ top: 13, right: 13, bottom: 13, left: 0 });
  });

  it('mirrors the title hit slop onto the free side in RTL', () => {
    // RN does not mirror hitSlop under RTL: an unchanged physical right slop
    // reaches across the visually mirrored back control and the title (the
    // later sibling) wins those taps, so Back opens the title action instead.
    i18nManager.isRTL = true;
    const renderer = renderHeader({ title: 'Sessions', onTitlePress: () => undefined });

    const title = findTitlePressable(renderer.root);
    expect(title.props.hitSlop).toEqual({ top: 13, right: 0, bottom: 13, left: 13 });
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
      { title: 'Quick Chat', size: 'large', context: 'ACCOUNT' },
      { title: 'Sessions', modal: true },
      { title: 'A long sheet title', centerTitle: true },
      { title: 'Sessions', eyebrow: 'Agents' },
      { title: 'Sessions', headerRight: 'RIGHT', reserveTitleSpace: true },
      { title: longTitle, titleNumberOfLines: 1, headerRight: 'METRICS' },
      { title: longTitle, titleNumberOfLines: 1, onTitlePress: () => undefined },
    ];

    for (const props of variants) {
      const renderer = renderHeader(props);
      const back = findBackPressable(renderer.root);
      const title = renderer.root.findByProps({ accessibilityRole: 'header' });
      expect(title.props.numberOfLines).toBe(props.titleNumberOfLines ?? 2);
      expect(title.props.ellipsizeMode).toBe('tail');
      expect(title.children).toEqual([props.title]);
      if (props.reserveTitleSpace) {
        expect(title.parent?.props.className).toContain('min-h-14 justify-center');
      }
      if (props.context) {
        expect(title.parent?.children).toEqual([title, props.context]);
      }
      if (props.modal || props.centerTitle) {
        expect(title.props.className).toContain('text-center');
        // The centered title shares one row with the leading control, so the
        // control lines up with the title instead of drawing on its own row.
        expect(title.parent?.parent?.parent).toBe(back.parent);
      }
    }
  });

  it('keeps the close control on the title row when the sheet skips the safe-area inset', () => {
    const renderer = renderHeader({
      title: 'Submit review',
      eyebrow: 'KILO-ORG/CLOUD#5058',
      onBack: () => undefined,
      backIcon: 'close',
      showBackButton: true,
      safeAreaTop: false,
      className: 'pt-3',
    });
    const back = findBackPressable(renderer.root);
    const title = renderer.root.findByProps({ accessibilityRole: 'header' });
    expect(title.parent?.parent).toBe(back.parent);
    expect(renderer.root.props.style).toBeUndefined();
    expect(renderer.root.props.className).toContain('pt-3');
  });

  it.each([false, true])('keeps repository eyebrows on one line with RTL=%s', isRTL => {
    i18nManager.isRTL = isRTL;
    platform.OS = 'android';
    const repositories = ['KILO-ORG/CLOUD', 'organization-with-a-long-name/repository-name'];

    for (const eyebrow of repositories) {
      const renderer = renderHeader({ title: '#6054', eyebrow, headerRight: 'Submit review' });
      const label = renderer.root.findByType('Eyebrow');
      expect(label.props.numberOfLines).toBe(1);
      expect(label.props.ellipsizeMode).toBe('tail');
      expect(label.children).toEqual([eyebrow]);
      expect(label.props.accessible).toBe(true);
      expect(label.parent?.props.className).toContain('min-w-0 flex-1');

      // Files and Discussion have fewer header actions than Overview. Keep the
      // same line limit as their available width changes instead of reflowing.
      act(() => {
        renderer.update(createElement(ScreenHeader, { title: '#6054', eyebrow }));
      });
      expect(renderer.root.findByType('Eyebrow').props.numberOfLines).toBe(1);
      expect(findBackPressable(renderer.root).props.className).toContain('h-11 w-11');
      renderer.unmount();
    }
  });

  it('keeps a reserved eyebrow hidden and on one line until its label arrives', () => {
    const renderer = renderHeader({ title: '#6054', reserveEyebrow: true, centerTitle: true });
    const placeholder = renderer.root.findByType('Eyebrow');
    expect(placeholder.props.numberOfLines).toBe(1);
    expect(placeholder.props.accessible).toBe(false);
    expect(placeholder.props.accessibilityElementsHidden).toBe(true);
    expect(placeholder.props.importantForAccessibility).toBe('no-hide-descendants');
    expect(placeholder.props.className).toContain('opacity-0');

    act(() => {
      renderer.update(
        createElement(ScreenHeader, {
          title: '#6054',
          reserveEyebrow: true,
          centerTitle: true,
          eyebrow: 'KILO-ORG/CLOUD',
        })
      );
    });
    const label = renderer.root.findByType('Eyebrow');
    expect(label.props.numberOfLines).toBe(1);
    expect(label.props.className).toContain('text-center');
    expect(label.props.className).not.toContain('opacity-0');
    expect(label.props.accessible).toBe(true);
    renderer.unmount();
  });

  it('omits an absent eyebrow when no space is reserved', () => {
    const renderer = renderHeader({ title: '#6054' });
    expect(renderer.root.findAllByType('Eyebrow')).toHaveLength(0);
    renderer.unmount();
  });

  it('pads the sheet header by the landscape side insets even when it skips the safe-area top', () => {
    safeArea.left = 47;
    safeArea.right = 59;
    const renderer = renderHeader({
      title: 'Submit review',
      onBack: () => undefined,
      backIcon: 'close',
      showBackButton: true,
      safeAreaTop: false,
      className: 'pt-3',
    });

    // No paddingTop key on the outer container (the sheet owns vertical padding
    // via its className), but the side insets still apply on the inner wrapper
    // so the close control and title clear the sensor area; with zero insets the
    // wrapper style collapses to undefined.
    expect(findOuterContainer(renderer.root).props.style).toBeUndefined();
    expect(findSideInsetWrapper(renderer.root).props.style).toEqual({
      paddingLeft: 47,
      paddingRight: 59,
    });
    expect(renderer.root.props.className).toContain('pt-3');
  });

  it('pads the container by the landscape side insets while keeping the gutter and back pull', () => {
    safeArea.left = 47;
    safeArea.right = 59;
    const renderer = renderHeader({ title: 'Sessions', headerRight: 'RIGHT' });

    // The outer container keeps only its top inset and the `px-4` gutter class;
    // the side insets land on the inner wrapper so they ADD to the gutter (an
    // inline padding on the container would override the class and pull the
    // back control's `-ms-4` chevron back into the sensor area).
    const container = findOuterContainer(renderer.root);
    expect(container.props.style).toEqual({ paddingTop: 8 });
    expect(container.props.className).toContain('px-4');
    expect(findSideInsetWrapper(renderer.root).props.style).toEqual({
      paddingLeft: 47,
      paddingRight: 59,
    });
    expect(findBackPressable(renderer.root).props.className).toContain('-ms-4');
  });

  it('keeps the container style a portrait no-op with zero side insets', () => {
    const renderer = renderHeader({ title: 'Sessions' });

    // No paddingLeft/paddingRight keys at zero: an inline 0 would override the
    // `px-4` className gutter and change the portrait geometry. The wrapper
    // stays styleless so portrait pixels are byte-identical to an inset-free
    // header.
    expect(findOuterContainer(renderer.root).props.style).toEqual({ paddingTop: 8 });
    expect(findSideInsetWrapper(renderer.root).props.style).toBeUndefined();
  });

  it('reserves the offline banner height above a pinned header while offline', () => {
    const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
    act(() => {
      ref.current = TestRenderer.create(
        createElement(
          OfflineBannerSpaceProvider,
          { isOffline: true },
          createElement(ScreenHeader, { title: 'Profile', size: 'large' })
        )
      );
    });
    const renderer = ref.current;
    if (!renderer) {
      throw new Error('renderer was not created');
    }
    expect(findOuterContainer(renderer.root).props.style).toEqual({
      paddingTop: 8 + OFFLINE_BANNER_HEIGHT,
    });
  });

  it('pads a modal header by the same value on iOS and Android', () => {
    const iosStyle = findOuterContainer(renderHeader({ title: 'Sessions', modal: true }).root).props
      .style;

    platform.OS = 'android';
    const androidStyle = findOuterContainer(renderHeader({ title: 'Sessions', modal: true }).root)
      .props.style;

    // A zero safe-area top: the sheet's grabber clearance is the floor on both.
    expect(iosStyle).toEqual({ paddingTop: 32 });
    expect(androidStyle).toEqual(iosStyle);
  });

  it('pads a modal by the fixed sheet clearance and a pinned header by the inset, on either platform', () => {
    safeArea.top = 48;
    const iosModal = findOuterContainer(renderHeader({ title: 'Sessions', modal: true }).root).props
      .style;
    const iosPinned = findOuterContainer(renderHeader({ title: 'Sessions' }).root).props.style;

    platform.OS = 'android';
    const androidModal = findOuterContainer(renderHeader({ title: 'Sessions', modal: true }).root)
      .props.style;
    const androidPinned = findOuterContainer(renderHeader({ title: 'Sessions' }).root).props.style;

    // A modal is a native sheet whose own window reports its top inset, so the
    // header keeps the fixed grabber clearance rather than re-adding the app
    // window's inset. A pinned header adds the reported inset. Neither branches
    // on the platform.
    expect(iosModal).toEqual({ paddingTop: 32 });
    expect(iosPinned).toEqual({ paddingTop: 56 });
    expect(androidModal).toEqual(iosModal);
    expect(androidPinned).toEqual(iosPinned);
  });

  it('never reserves the offline banner for a modal header on either platform', () => {
    const renderOfflineModal = () => {
      const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
      act(() => {
        ref.current = TestRenderer.create(
          createElement(
            OfflineBannerSpaceProvider,
            { isOffline: true },
            createElement(ScreenHeader, { title: 'Sessions', modal: true })
          )
        );
      });
      const renderer = ref.current;
      if (!renderer) {
        throw new Error('renderer was not created');
      }
      return findOuterContainer(renderer.root).props.style;
    };

    const iosStyle = renderOfflineModal();
    platform.OS = 'android';
    const androidStyle = renderOfflineModal();

    expect(iosStyle).toEqual({ paddingTop: 32 });
    expect(androidStyle).toEqual(iosStyle);
  });
});

describe('header actions row', () => {
  it('keeps the actions on the title row at a normal phone width', () => {
    const renderer = renderHeader({ title: 'Agents', size: 'large', headerRight: 'RIGHT' });

    expect(renderer.root.findAll(isStackedActionsRow)).toHaveLength(0);
    const actions = renderer.root.find(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'View' &&
        String(node.props.className ?? '').includes('max-w-[50%]')
    );
    // The inline wrapper's gap is the logical start margin (`ms-3`), which the
    // RTL swap cannot mirror away; the title's box keeps its `shrink` cap.
    expect(actions.props.className).toContain('ms-3');
  });

  it('drops the actions to their own row when the window cannot hold the title beside them', () => {
    // The e1 geometry: 160dp wide with a 1.5 font scale left the 30px title
    // 48dp, which broke it and the mono link beside it into letter columns.
    layout.width = 160;
    layout.fontScale = 1.5;
    const renderer = renderHeader({ title: 'Agents', size: 'large', headerRight: 'RIGHT' });

    expect(renderer.root.findAll(isStackedActionsRow)).toHaveLength(1);
    expect(
      renderer.root.findAll(
        node =>
          typeof node.type === 'string' &&
          (node.type as string) === 'View' &&
          String(node.props.className ?? '').includes('max-w-[50%]')
      )
    ).toHaveLength(0);
    // The title still shares its row with the back control; only the actions moved.
    const title = renderer.root.findByProps({ accessibilityRole: 'header' });
    expect(title.parent?.parent).toBe(findBackPressable(renderer.root).parent);
  });

  it('reflows a centered modal header the same way', () => {
    layout.width = 160;
    layout.fontScale = 1.5;
    const renderer = renderHeader({ title: 'Agents', modal: true, headerRight: 'RIGHT' });

    expect(renderer.root.findAll(isStackedActionsRow)).toHaveLength(1);
    const title = renderer.root.findByProps({ accessibilityRole: 'header' });
    expect(title.parent?.parent?.parent).toBe(findBackPressable(renderer.root).parent);
  });

  it('leaves a header without actions on its single row', () => {
    layout.width = 160;
    layout.fontScale = 1.5;
    const renderer = renderHeader({ title: 'Agents', size: 'large' });

    expect(renderer.root.findAll(isStackedActionsRow)).toHaveLength(0);
  });
});

describe('header status line', () => {
  it('keeps the eyebrow on one line at the reported narrow geometry', () => {
    // e1: a 160dp window at a 1.5 font scale broke '1 LIVE' into a letter
    // column beside the title and grew the header down over the search field.
    layout.width = 160;
    layout.fontScale = 1.5;
    const renderer = renderHeader({ title: 'Agents', size: 'large', eyebrow: '1 LIVE' });

    const eyebrow = renderer.root.findByType('Eyebrow');
    expect(eyebrow.props.numberOfLines).toBe(1);
    expect(eyebrow.children).toEqual(['1 LIVE']);
  });
});

describe('shouldStackHeaderActions', () => {
  it('reflows at the reported 160dp window with a 1.5 font scale', () => {
    expect(shouldStackHeaderActions(160, 1.5)).toBe(true);
  });

  it('keeps one row at every phone width the scenarios cover', () => {
    expect(shouldStackHeaderActions(320, 1)).toBe(false);
    expect(shouldStackHeaderActions(360, 1)).toBe(false);
    expect(shouldStackHeaderActions(360, 2)).toBe(false);
    expect(shouldStackHeaderActions(390, 2)).toBe(false);
  });

  it('reflows a window too narrow for the title beside the actions', () => {
    expect(shouldStackHeaderActions(160, 1)).toBe(true);
    expect(shouldStackHeaderActions(220, 1.5)).toBe(true);
    expect(shouldStackHeaderActions(320, 2.5)).toBe(true);
  });

  it('treats a missing window measurement as a single row', () => {
    expect(shouldStackHeaderActions(Number.NaN, 1)).toBe(false);
    expect(shouldStackHeaderActions(160, Number.NaN)).toBe(true);
  });
});
