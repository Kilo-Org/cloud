/* eslint-disable max-lines -- test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as composer-paste-button.mounted.test.tsx) */
// eslint-disable-next-line import/no-nodejs-modules -- The compiler's CommonJS export is the only way to load it under vitest.
import { createRequire } from 'node:module';
import tailwindcss from '@tailwindcss/postcss';
import postcss from 'postcss';
import { type ComponentProps, createElement } from 'react';
import type * as NativeCSSCompiler from 'react-native-css/compiler';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OFFLINE_BANNER_HEIGHT } from '@/lib/offline-banner-state';
import { HEADER_BACK_GUARD_MS } from '@/lib/hooks/header-back';
import { ICON_TARGET_BOX_CLASS } from '@/lib/a11y/tap-target';
import { AGENTS_SESSIONS_HREF } from '@/lib/agents-sessions-route';
import { ScreenHeader, shouldStackHeaderActions } from './screen-header';
import { OfflineBannerSpaceProvider } from './offline-banner-space';

const routerState = vi.hoisted(() => ({
  routes: ['previous-screen', 'session-detail'],
  back: vi.fn(),
  replace: vi.fn<(href: string) => void>(),
  // POP_TO semantics: find the destination at or below the current index and
  // truncate everything above it; with no match, replace the current route.
  dismissTo: vi.fn<(href: string) => void>(),
  canGoBack: vi.fn(() => true),
}));
const i18nManager = vi.hoisted(() => ({ isRTL: false }));
// The container ref the header subscribes to for navigation commits. The suite
// fires its `state` listeners by hand to reproduce a commit that lands after
// the header's first render (a restored stack completing).
const navigationContainer = vi.hoisted(() => {
  const stateListeners = new Set<() => void>();
  return {
    addListener: (event: string, listener: () => void) => {
      if (event === 'state') {
        stateListeners.add(listener);
      }
      return () => {
        stateListeners.delete(listener);
      };
    },
    emitState() {
      for (const listener of stateListeners) {
        listener();
      }
    },
  };
});
const safeArea = vi.hoisted(() => ({ top: 0, bottom: 0, left: 0, right: 0 }));
const platform = vi.hoisted(() => ({ OS: 'ios' as 'ios' | 'android' }));
/** A normal phone window: wide enough for the title and its actions to share a row. */
const layout = vi.hoisted(() => ({ width: 390, fontScale: 1 }));

vi.mock('expo-router', () => ({
  useRouter: () => routerState,
  // The header re-reads `canGoBack` on this container's `state` events.
  useNavigationContainerRef: () => navigationContainer,
}));
vi.mock('react-native', () => ({
  I18nManager: i18nManager,
  Platform: platform,
  // `useSheetHeaderTopClearance` falls back to the status-bar height on Android.
  StatusBar: { currentHeight: 24 },
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

/**
 * The circle that clips the back target's press and focus surface. Android
 * paints that surface across the whole target, so the clipping frame — not the
 * `Pressable` — is what keeps it from reading as a bare square at the screen
 * edge.
 */
function findBackFrame(root: TestInstance): TestInstance {
  const frame = findBackPressable(root).parent;
  if (!frame || String(frame.type) !== 'View') {
    throw new Error('back control frame not found');
  }
  return frame;
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
 * the title and the actions to share one. Only that variant carries `mt-2`;
 * the single-row variant wraps the cluster in an `ms-3 shrink-0` View instead.
 */
function isStackedActionsRow(node: TestInstance): boolean {
  const className = String(node.props.className ?? '');
  return (
    typeof node.type === 'string' &&
    (node.type as string) === 'View' &&
    className.includes('mt-2') &&
    !className.includes('shrink-0')
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
      /(^|\s)ms-3(\s|$)/.test(node.props.className)
  )[0];
  if (!headerRight) {
    throw new Error('headerRight view not found');
  }
  return headerRight;
}

/**
 * The trailing wrapper that carries `inlineActions`. It shares the `ms-3`
 * start margin with the `headerRight` cluster and is the second trailing slot
 * in the row, so the last match wins.
 */
function findInlineActionsWrapper(root: TestInstance): TestInstance {
  const wrappers = root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'View' &&
      typeof node.props.className === 'string' &&
      /(^|\s)ms-3(\s|$)/.test(node.props.className) &&
      !node.props.className.includes('shrink-0')
  );
  const wrapper = wrappers.at(-1);
  if (!wrapper) {
    throw new Error('inlineActions view not found');
  }
  return wrapper;
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
    routerState.dismissTo.mockReset().mockImplementation(href => {
      const index = routerState.routes.lastIndexOf(href.split('?')[0] ?? href);
      routerState.routes = index === -1 ? [href] : routerState.routes.slice(0, index + 1);
    });
    routerState.canGoBack.mockReset().mockImplementation(() => routerState.routes.length > 1);
    i18nManager.isRTL = false;
    platform.OS = 'ios';
    Object.assign(safeArea, { top: 0, bottom: 0, left: 0, right: 0 });
    Object.assign(layout, { width: 390, fontScale: 1 });
  });

  it('gives the back control the 48dp icon target and no hit slop', () => {
    const renderer = renderHeader({ title: 'Sessions' });

    const back = findBackPressable(renderer.root);
    expect(back.props.className).toContain(ICON_TARGET_BOX_CLASS);
    expect(back.props.className).toContain('active:opacity-70');
    expect(back.props.className).not.toContain('mr-1');
    expect(back.props.hitSlop).toBeUndefined();
    expect(findBackFrame(renderer.root).props.className).toContain('shrink-0');
    expect(findBackFrame(renderer.root).props.className).toContain('-ms-4');
  });

  it('clips the back control to a circle instead of letting the platform surface fill its box', () => {
    // Android draws the press and focus surface across the target's whole rect,
    // so a bare 48dp target pulled flush against the screen edge read as a hard
    // gray square taller than the title row. The frame rounds that surface; the
    // target keeps its rect, focusability and label.
    const renderer = renderHeader({ title: 'Sessions' });

    const frame = findBackFrame(renderer.root);
    expect(frame.props.className).toContain('rounded-full');
    expect(frame.props.className).toContain('overflow-hidden');
    const back = findBackPressable(renderer.root);
    expect(String(back.props.className)).not.toContain('overflow-hidden');
    expect(back.props.accessibilityRole).toBe('button');
  });

  it('dispatches one back for a burst of presses on the same header', () => {
    // One gesture owns the header's Back: four presses delivered inside the
    // window have to pop one screen, not four. The window is per header, so the
    // screen a dispatched back lands on starts a fresh one.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      routerState.routes = ['tabs', 'security-agent', 'security-agent-settings'];
      const renderer = renderHeader({ title: 'Settings' });

      const back = findBackPressable(renderer.root);
      for (let press = 0; press < 4; press += 1) {
        act(() => {
          (back.props.onPress as () => void)();
        });
      }
      expect(routerState.back).toHaveBeenCalledTimes(1);
      expect(routerState.routes).toEqual(['tabs', 'security-agent']);

      // A deliberate press after the window still walks the stack.
      vi.setSystemTime(new Date(Date.now() + HEADER_BACK_GUARD_MS));
      act(() => {
        (back.props.onPress as () => void)();
      });
      expect(routerState.back).toHaveBeenCalledTimes(2);
      expect(routerState.routes).toEqual(['tabs']);
    } finally {
      vi.useRealTimers();
    }
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
    // both writing directions. It rides on the frame, which is the row's child.
    const frame = findBackFrame(renderer.root);
    expect(frame.props.className).toContain('-ms-4');
    expect(await compiledMarginProperties(frame.props.className as string)).toEqual([
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
    // The cluster is content-sized and never shrinks, so a fixed-width
    // trailing control keeps its full width instead of being clamped and
    // painting past the screen edge (session-compose-kbup capture).
    expect(headerRight.props.className).toContain('shrink-0');
    expect(headerRight.props.className).not.toContain('max-w-[50%]');
    expect(headerRight.children).toEqual(['RIGHT']);
  });

  it('renders inlineActions in the title row uncapped beside the content-sized cluster', () => {
    const renderer = renderHeader({
      title: 'Agents',
      headerRight: 'RIGHT',
      inlineActions: 'ACTIONS',
    });

    const cluster = findHeaderRight(renderer.root);
    const inline = findInlineActionsWrapper(renderer.root);

    // Both trailing slots sit in the title row beside the heading, so the
    // heading keeps `flex-1 min-w-0` and the title keeps its tail ellipsis.
    expect(inline.parent).toBe(cluster.parent);
    expect(inline.children).toEqual(['ACTIONS']);
    expect(inline.parent?.props.className).toContain('flex-row');
    const heading = inline.parent?.children[0] as TestInstance;
    expect(heading.props.className).toContain('min-w-0 flex-1');
    // Neither trailing slot clamps itself: `headerRight` sizes to its content
    // and `inlineActions` keeps its full width instead of wrapping the controls.
    expect(cluster.children).toEqual(['RIGHT']);
    expect(inline.props.className).toContain('min-w-0');
    expect(inline.props.className).toContain('shrink');
  });

  it('renders inlineActions alone in the title row', () => {
    const renderer = renderHeader({ title: 'Agents', inlineActions: 'ACTIONS' });

    const inline = findInlineActionsWrapper(renderer.root);
    expect(inline.parent?.props.className).toContain('flex-row');
    // The inline slot is the row's only trailing wrapper: no `headerRight`
    // cluster is rendered beside it.
    const trailing = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'View' &&
        typeof node.props.className === 'string' &&
        /(^|\s)ms-3(\s|$)/.test(node.props.className)
    );
    expect(trailing).toEqual([inline]);
  });

  it('renders inlineActions beside a centered title too', () => {
    // A centered title (`centerTitle`, e.g. a modal with a title or eyebrow)
    // shares its row with the leading control; the inline actions slot must not
    // be dropped just because the title is centered.
    const renderer = renderHeader({ modal: true, title: 'Filters', inlineActions: 'ACTIONS' });

    const inline = findInlineActionsWrapper(renderer.root);
    expect(inline.children).toEqual(['ACTIONS']);
    expect(inline.parent?.props.className).toContain('flex-row');
    expect(inline.props.className).toContain('min-w-0');
    const title = renderer.root.findByProps({ accessibilityRole: 'header' });
    expect(title.props.className).toContain('text-center');
  });

  it('keeps the inlineActions on the title row when the cluster fits beside it', () => {
    // 390 - 44 - 12 - 92 leaves the title 242dp, above its 120dp minimum, so
    // the row is untouched.
    const renderer = renderHeader({
      title: 'Agenti',
      size: 'large',
      inlineActions: 'ACTIONS',
      inlineActionsWidth: 92,
    });

    expect(renderer.root.findAll(isStackedActionsRow)).toHaveLength(0);
    const inline = findInlineActionsWrapper(renderer.root);
    expect(inline.children).toEqual(['ACTIONS']);
    expect(inline.parent?.props.className).toContain('flex-row');
  });

  it('drops inlineActions to their own full-width row when they squeeze the title', () => {
    // A cluster this wide takes its own row: 390 - 44 - 12 - 333 leaves the
    // 30px title below its 120dp minimum. The Agents header took that shape
    // while its controls squeezed "Agenti" mid-word (owner capture,
    // agents-header-hr-20260929).
    const renderer = renderHeader({
      title: 'Agenti',
      size: 'large',
      inlineActions: 'ACTIONS',
      inlineActionsWidth: 333,
    });

    const stacked = renderer.root.findAll(isStackedActionsRow);
    expect(stacked).toHaveLength(1);
    const [stackedRow] = stacked;
    expect(stackedRow?.children).toEqual(['ACTIONS']);
    // The title row no longer carries the inline slot, and the heading keeps
    // its full-width `min-w-0 flex-1` box, so the title cannot be squeezed.
    const title = renderer.root.findByProps({ accessibilityRole: 'header' });
    expect(title.parent?.props.className).toContain('min-w-0 flex-1');
    expect(
      renderer.root.findAll(
        node =>
          typeof node.type === 'string' &&
          (node.type as string) === 'View' &&
          /(^|\s)ms-3(\s|$)/.test(String(node.props.className ?? ''))
      )
    ).toHaveLength(0);
  });

  it("keeps a mark-only heading's inlineActions on the row when the caller forbids a reflow", () => {
    // The shared-row check reserves 120dp of readable title per font-scale
    // unit: at a 3x accessibility scale on a 390dp phone that reserve is 360dp
    // against 334dp free, so the picker reflowed under the mark although both
    // fit. The home header turns the check off for its picker.
    Object.assign(layout, { width: 390, fontScale: 3 });

    const reflowed = renderHeader({
      title: 'Kilo',
      titleContent: 'MARK',
      size: 'large',
      inlineActions: 'ACTIONS',
    });
    expect(reflowed.root.findAll(isStackedActionsRow)).toHaveLength(1);

    const pinned = renderHeader({
      title: 'Kilo',
      titleContent: 'MARK',
      size: 'large',
      inlineActions: 'ACTIONS',
      allowInlineActionsStacking: false,
    });
    expect(pinned.root.findAll(isStackedActionsRow)).toHaveLength(0);
    const inline = findInlineActionsWrapper(pinned.root);
    expect(inline.children).toEqual(['ACTIONS']);
    expect(inline.parent?.props.className).toContain('flex-row');
    // Turning the reflow off must cap the slot instead: the heading sits on a
    // zero flex basis, so an unbounded cluster would keep all negative free
    // space and leave the heading at zero width, with a fixed-size mark
    // painting under the cluster.
    expect(inline.props.className).toContain('max-w-[50%]');

    // A caller that keeps the reflow keeps the uncapped slot.
    Object.assign(layout, { width: 390, fontScale: 1 });
    const uncapped = renderHeader({
      title: 'Kilo',
      titleContent: 'MARK',
      size: 'large',
      inlineActions: 'ACTIONS',
    });
    expect(findInlineActionsWrapper(uncapped.root).props.className).not.toContain('max-w-[50%]');
  });

  it('keeps the title touch area out of the row gap beside it', () => {
    // The heading's free side is the gap to the trailing slot, and a trailing
    // control can carry a slop that reaches into that gap. A title slop there
    // made the same strip two tap targets: measured on the session screen at
    // 10.33 dp across, in every state and every gate cell.
    const renderer = renderHeader({ title: 'Sessions', onTitlePress: () => undefined });

    const title = findTitlePressable(renderer.root);
    expect(title.props.hitSlop).toEqual({ top: 13, bottom: 13 });
  });

  it('keeps the title touch area identical in both directions', () => {
    // RN does not mirror hitSlop under RTL. With no side slop there is nothing
    // to mirror, so Back and the trailing cluster keep their own taps alike.
    i18nManager.isRTL = true;
    const renderer = renderHeader({ title: 'Sessions', onTitlePress: () => undefined });

    const title = findTitlePressable(renderer.root);
    expect(title.props.hitSlop).toEqual({ top: 13, bottom: 13 });
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

  it('paints the large route title in the foreground token, never a muted one', () => {
    // Explorer finding 5 (profile, f2181ae79) reported the Profile title muted
    // gray while every other heading is white. A pixel measure of the capture
    // refuted it: the large title is text-foreground, the same white as the
    // Kilo Pass row. Pin the token so the top of the hierarchy cannot silently
    // drop to text-muted-foreground.
    const renderer = renderHeader({ title: 'Profile', size: 'large' });
    const title = renderer.root.findByProps({ accessibilityRole: 'header' });
    expect(title.props.className).toContain('text-foreground');
    expect(title.props.className).not.toContain('text-muted-foreground');
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
        backFallback: AGENTS_SESSIONS_HREF,
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
    { history: true, backFallback: AGENTS_SESSIONS_HREF },
    { history: false, backFallback: AGENTS_SESSIONS_HREF },
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

  it('labels the title with its own text and hints at the action', () => {
    const renderer = renderHeader({ title: 'Sessions', onTitlePress: () => undefined });
    const title = findTitlePressable(renderer.root);
    expect(title.props.accessibilityLabel).toBe('Sessions');
    expect(title.props.accessibilityHint).toBe('Open menu for Sessions');

    const customRenderer = renderHeader({
      title: 'Sessions',
      onTitlePress: () => undefined,
      onTitlePressAccessibilityHint: 'Rename session',
    });
    const custom = findTitlePressable(customRenderer.root);
    expect(custom.props.accessibilityLabel).toBe('Sessions');
    expect(custom.props.accessibilityHint).toBe('Rename session');
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
      backFallback: AGENTS_SESSIONS_HREF,
    });
    expect(backPressableCount(explicitlyHidden.root)).toBe(0);
  });

  it('keeps the back control reachable from its fallback while the stack is unsettled', () => {
    // A restored screen renders before its stack holds the parent, so the only
    // thing that can answer Back is the declared fallback: the control must
    // paint from that first render, not wait for the navigation commit.
    routerState.canGoBack.mockReturnValue(false);
    const renderer = renderHeader({ title: 'Code Reviewer', backFallback: AGENTS_SESSIONS_HREF });
    expect(backPressableCount(renderer.root)).toBe(1);

    act(() => {
      (findBackPressable(renderer.root).props.onPress as () => void)();
    });
    expect(routerState.dismissTo).toHaveBeenLastCalledWith(AGENTS_SESSIONS_HREF);
    expect(routerState.back).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it('shows the back control when a later navigation commit supplies the history', () => {
    // The relaunch restore renders its screen before the navigator tree above
    // it holds the parents, so the first read is false; the header must not
    // stay headerless once the stack completes.
    routerState.canGoBack.mockReturnValue(false);
    const renderer = renderHeader({ title: 'Review style' });
    expect(backPressableCount(renderer.root)).toBe(0);

    routerState.canGoBack.mockReturnValue(true);
    act(() => {
      navigationContainer.emitState();
    });

    expect(backPressableCount(renderer.root)).toBe(1);
    renderer.unmount();
  });

  it('keeps the back bar and target classes when title is absent', () => {
    const renderer = renderHeader({});

    const back = findBackPressable(renderer.root);
    expect(back.props.className).toContain(ICON_TARGET_BOX_CLASS);
    expect(back.props.hitSlop).toBeUndefined();
  });

  it('preserves title line limits and back controls across layout variants', () => {
    const longTitle = 'A long session name that must stay on one row. '.repeat(4);
    const variants: ScreenHeaderProps[] = [
      { title: 'Sessions' },
      { title: 'Agents', size: 'large' },
      { title: 'Sessions', modal: true },
      { title: 'A long sheet title', centerTitle: true },
      { title: 'Sessions', eyebrow: 'Agents' },
      { title: 'Sessions', headerRight: 'RIGHT', reserveTitleSpace: true },
      { title: longTitle, titleNumberOfLines: 1, headerRight: 'METRICS' },
      { title: longTitle, titleNumberOfLines: 1, onTitlePress: () => undefined },
      { title: longTitle, titleNumberOfLines: 3, headerRight: 'METRICS', reserveTitleSpace: true },
      { title: longTitle, titleNumberOfLines: 9, reserveTitleSpace: true },
      { title: 'Agents', size: 'large', reserveTitleSpace: true },
      { title: longTitle, size: 'large', titleNumberOfLines: 2, reserveTitleSpace: true },
      {
        title: longTitle,
        size: 'large',
        titleNumberOfLines: 3,
        headerRight: 'METRICS',
        reserveTitleSpace: true,
      },
    ];

    for (const props of variants) {
      const renderer = renderHeader(props);
      const title = renderer.root.findByProps({ accessibilityRole: 'header' });
      // The cap is clamped to the three lines the reserved box covers, so a
      // title can never paint a line the reserve does not hold. The default
      // is one line: CJK titles ellipsize instead of orphaning characters.
      const cappedLines = Math.min(props.titleNumberOfLines ?? 1, 3);
      expect(title.props.numberOfLines).toBe(cappedLines);
      expect(title.props.ellipsizeMode).toBe('tail');
      expect(title.children).toEqual([props.title]);
      if (props.modal || props.centerTitle) {
        expect(title.props.className).toContain('text-center');
        // The centered title shares one row with the leading control, so the
        // control lines up with the title instead of drawing on its own row.
        expect(title.parent?.parent?.parent).toBe(findBackFrame(renderer.root).parent);
      }
    }
  });

  it('reserves the title cap in a band beside the heading, not around the title', () => {
    const renderer = renderHeader({
      title: 'Harbor Analytics',
      eyebrow: 'RECENT REVIEWS',
      titleNumberOfLines: 2,
      reserveTitleSpace: true,
    });

    const band = renderer.root.find(
      node =>
        typeof node.type === 'string' &&
        String(node.props.className ?? '')
          .split(' ')
          .includes('w-0')
    );
    // The band holds one eyebrow line and the title's two-line cap, so the row
    // keeps its height for a title that paints one line: the body below never
    // moves when the name arrives and wraps.
    expect(band.findAll(node => String(node.type) === 'Eyebrow')).toHaveLength(1);
    const capBox = band.findAll(
      node => typeof node.type === 'string' && String(node.props.className ?? '').includes('min-h')
    );
    expect(capBox.map(node => node.props.className)).toEqual(['min-h-14']);
    // The band is clipped to no width, so it holds height only: it never takes
    // space from the heading or paints beside the title.
    expect(String(band.props.className)).toContain('w-0');

    // The visible title keeps its own height, so the eyebrow sits right above
    // it instead of above the empty line the cap reserves.
    const title = renderer.root.findByProps({ accessibilityRole: 'header' });
    expect(title.parent?.props.className).toBe('min-w-0 flex-1');
    renderer.unmount();
  });

  // The reserve cannot know the arriving label, so it holds a no-ink no-break
  // space: the eyebrow variant's line box is the same for every script
  // (`EYEBROW_LINE_HEIGHT_DP`), so the space reserves exactly the height the
  // label takes, in either interface direction.
  it.each([false, true])(
    'reserves a blank filler when the arriving label is unknown (RTL=%s)',
    isRTL => {
      i18nManager.isRTL = isRTL;

      const banded = renderHeader({
        title: '#6054',
        reserveEyebrow: true,
        reserveTitleSpace: true,
      });
      const band = banded.root.find(
        node =>
          typeof node.type === 'string' &&
          String(node.props.className ?? '')
            .split(' ')
            .includes('w-0')
      );
      const twin = band.find(node => String(node.type) === 'Eyebrow');
      expect(twin.children).toEqual(['\u00A0']);
      // No eyebrow class is forced on the reserve: the size and family stay the
      // `Text` variant's business.
      expect(twin.props.className).toBe('mb-0.5');
      banded.unmount();

      // The hidden placeholder line, which is what holds the height when the
      // caller does not reserve the title space (the invoices boundary).
      const inline = renderHeader({ title: '#6054', reserveEyebrow: true });
      const placeholder = inline.root.findByType('Eyebrow');
      expect(placeholder.children).toEqual(['\u00A0']);
      // It still paints nothing and reaches no reader.
      expect(placeholder.props.className).toContain('opacity-0');
      inline.unmount();

      i18nManager.isRTL = false;
    }
  );

  it('keeps the reserved eyebrow twin out of the accessibility tree and the visible eyebrow readable', () => {
    const renderer = renderHeader({
      title: 'الفواتير',
      eyebrow: 'الفواتير',
      reserveTitleSpace: true,
    });

    const band = renderer.root.find(
      node =>
        typeof node.type === 'string' &&
        String(node.props.className ?? '')
          .split(' ')
          .includes('w-0')
    );
    expect(band.props['aria-hidden']).toBe(true);
    // The twin is still clipped to no width: it holds height only, so the
    // eyebrow line it lays out paints nothing.
    expect(band.props.className).toContain('w-0');
    expect(band.props.className).toContain('overflow-hidden');

    // Only the visible slot is the header's labelled eyebrow.
    const labelled = renderer.root.findAll(
      node => String(node.type) === 'Eyebrow' && node.props.accessible === true
    );
    expect(labelled).toHaveLength(1);
    expect(labelled[0]?.children).toEqual(['الفواتير']);
    renderer.unmount();
  });

  it('reserves no band on a header whose title has a single fixed line', () => {
    const renderer = renderHeader({
      title: 'Personal',
      eyebrow: 'RECENT REVIEWS',
      titleNumberOfLines: 1,
    });

    expect(
      renderer.root.findAll(
        node =>
          typeof node.type === 'string' && String(node.props.className ?? '').startsWith('w-0')
      )
    ).toHaveLength(0);
    renderer.unmount();
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
    const title = renderer.root.findByProps({ accessibilityRole: 'header' });
    // The control is the row's own leading sibling, so the chevron centres on
    // the title's own line while the eyebrow keeps its line above both.
    const titleRow = title.parent?.parent;
    const control = findBackFrame(renderer.root);
    expect(titleRow?.props.className).toContain('flex-row items-center');
    expect(control.parent).toBe(titleRow);
    expect(titleRow?.children[0]).toBe(control);
    expect(renderer.root.props.style).toBeUndefined();
    expect(renderer.root.props.className).toContain('pt-3');
  });

  it('starts a root header title on the gutter with no leading gap', () => {
    routerState.canGoBack.mockReturnValue(false);
    const renderer = renderHeader({ title: 'Agents', size: 'large' });

    const title = renderer.root.findByProps({ accessibilityRole: 'header' });
    const titleRow = title.parent?.parent;
    // No back control: no leading box and no row gap, so the title is the
    // start-most content of its column on the 14dp gutter.
    expect(titleRow?.props.className).toBe('flex-row items-center');
    expect(titleRow?.children).toHaveLength(1);
    expect(titleRow?.children[0]).toBe(title.parent);
  });

  it("keeps a one-line header on the control target's own row height", () => {
    const renderer = renderHeader({ title: 'Sessions' });

    const control = findBackFrame(renderer.root);
    // A single line has no second line to pull the control onto: the row is the
    // 48dp band the target has always filled, and the control keeps its own
    // box inside it.
    expect(control.props.className).not.toContain('-my-');
    expect(control.parent?.props.className).toContain('min-h-[48px]');
    const title = renderer.root.findByProps({ accessibilityRole: 'header' });
    expect(title.parent?.parent?.children).toHaveLength(2);
    expect(title.parent?.parent).toBe(control.parent);
  });

  it('keeps the back control inside the header when the title row is its first line', () => {
    safeArea.top = 48;

    const paddingTopOf = (props: ScreenHeaderProps): number => {
      const style = findOuterContainer(renderHeader(props).root).props.style as {
        paddingTop: number;
      };
      return style.paddingTop;
    };
    // The profile sections' header: a title with the profile's name under it and
    // no eyebrow above, so the title row is the header's first line.
    const twoLine = { title: 'Instructions', subtitle: 'Shared Agency Review Profile' };

    // The control sits whole inside the title row's 48dp band, so nothing
    // reaches above the row into the surface's own top edge: the header keeps
    // the plain 8dp gap under the surface's clearance, whatever lines it paints
    // and however large the font scale is.
    const frame = findBackFrame(renderHeader(twoLine).root);
    expect(frame.props.className).not.toContain('-my-');
    expect(frame.parent?.props.className).toContain('min-h-[48px]');
    expect(paddingTopOf(twoLine)).toBe(48 + 8);
    expect(paddingTopOf({ ...twoLine, eyebrow: 'KILO-ORG/CLOUD' })).toBe(48 + 8);
    expect(paddingTopOf({ title: 'Instructions' })).toBe(48 + 8);
    layout.fontScale = 2;
    expect(paddingTopOf(twoLine)).toBe(48 + 8);
  });

  it('aligns the eyebrow and subtitle with the title line the control centres on', () => {
    const renderer = renderHeader({
      title: 'Profile agents',
      eyebrow: 'KILO-ORG/CLOUD',
      subtitle: 'Shared Agency Review Profile',
    });

    const control = findBackFrame(renderer.root);

    const title = renderer.root.findByProps({ accessibilityRole: 'header' });
    const titleRow = title.parent?.parent;
    // The control sits in the title row's band: the row is at least the 48dp
    // target, so the target is whole inside its parent, and the row's
    // `items-center` centres it on the title line without a negative margin.
    expect(control.props.className).not.toContain('-my-');
    expect(control.parent).toBe(titleRow);
    expect(titleRow?.props.className).toContain('min-h-[48px]');
    expect(titleRow?.props.className).toContain('gap-1');

    // The eyebrow above and the subtitle below carry the control's column plus
    // the row gap as a spacer, so all three lines start on one column. Those
    // rows keep the spacer without the band's height: the band's space belongs
    // to the title's line alone.
    const headingRows = titleRow?.parent?.children ?? [];
    expect(headingRows).toHaveLength(3);
    const instanceAt = (nodes: typeof headingRows, index: number) => {
      const node = nodes[index];
      if (node === undefined || typeof node === 'string') {
        throw new Error(`expected an element at ${String(index)}`);
      }
      return node;
    };
    const eyebrowRow = instanceAt(headingRows, 0);
    const subtitleRow = instanceAt(headingRows, 2);
    expect(eyebrowRow.props.className).toContain('flex-row items-center');
    expect(eyebrowRow.props.className).not.toContain('min-h-');
    expect(subtitleRow.props.className).toContain('flex-row items-center');
    expect(subtitleRow.props.className).not.toContain('min-h-');
    expect(instanceAt(eyebrowRow.children, 0).props.className).toBe('h-0 w-[48px] shrink-0 -ms-4');
    expect(instanceAt(subtitleRow.children, 0).props.className).toBe('h-0 w-[48px] shrink-0 -ms-4');
  });

  it('seats the title and the back control in one full-height band', () => {
    const renderer = renderHeader({
      title: 'Instructions',
      subtitle: 'Shared Agency Review Profile',
    });

    const control = findBackFrame(renderer.root);
    const title = renderer.root.findByProps({ accessibilityRole: 'header' });
    const band = control.parent;
    // The control and the title are the band's own children. React Native
    // hit-tests inside each view's bounds, so a 48dp target in a row only as
    // tall as the title's line answers touches across that line alone; the band
    // is what puts the whole target inside its parent. It floors the row rather
    // than fixing it, so a deeper title cap grows the band instead of clipping
    // the target or the text.
    expect(band?.props.className).toContain('min-h-[48px]');
    expect(band?.props.className).toContain('items-center');
    expect(title.parent?.parent).toBe(band);
    expect(band?.children[0]).toBe(control);
  });

  it('keeps the modal close control on the centered title row with a mirroring spacer', () => {
    const renderer = renderHeader({ title: 'Kilo Pass', modal: true });

    const row = findBackFrame(renderer.root).parent;
    if (!row || typeof row.props.className !== 'string') {
      throw new Error('back control row not found');
    }
    expect(row.props.className).toContain('flex-row items-center');
    expect(row.props.className).toContain('min-h-11');

    const title = renderer.root.findByProps({ accessibilityRole: 'header' });
    expect(title.props.className).toContain('text-center');
    expect(title.parent?.parent?.parent).toBe(row);

    const spacer = row.find(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'View' &&
        node.props.className === 'h-[48px] w-[48px] shrink-0'
    );
    expect(spacer).toBeDefined();
  });

  it('omits the mirroring spacer when the centered header has no back control', () => {
    routerState.canGoBack.mockReturnValue(false);
    const renderer = renderHeader({ title: 'Kilo Pass', modal: true });

    const spacers = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'View' &&
        node.props.className === 'h-[48px] w-[48px] shrink-0'
    );
    expect(spacers).toHaveLength(0);
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
      // The label paints on its own line above the title, inside the heading
      // column the back control centres on.
      expect(label.parent?.props.className).toContain('mb-0.5');
      expect(label.parent?.parent?.props.className).toContain('min-w-0 flex-1');

      // Files and Discussion have fewer header actions than Overview. Keep the
      // same line limit as their available width changes instead of reflowing.
      act(() => {
        renderer.update(createElement(ScreenHeader, { title: '#6054', eyebrow }));
      });
      expect(renderer.root.findByType('Eyebrow').props.numberOfLines).toBe(1);
      expect(findBackPressable(renderer.root).props.className).toContain(ICON_TARGET_BOX_CLASS);
      renderer.unmount();
    }
  });

  it('paints a placeholder on the reserved eyebrow line above the title', () => {
    const renderer = renderHeader({
      title: '#6054',
      reserveEyebrow: true,
      centerTitle: true,
      eyebrowPlaceholder: createElement('PlaceholderBar'),
    });

    // The reserved line stays in flow above the title, so the heading block the
    // back control centres on is already the height the label will leave it.
    const heading = renderer.root.findByProps({ className: 'min-w-0 flex-1' });
    expect(
      heading
        .findAll(
          node => String(node.type) === 'Eyebrow' || node.props.accessibilityRole === 'header'
        )
        .map(node => node.type)
    ).toEqual(['Eyebrow', 'Text']);
    expect(heading.findAllByType('PlaceholderBar')).toHaveLength(1);

    // The reserved copy holds the line's height and the placeholder paints over
    // it. A blank line is not a label, so the line stays hidden from assistive
    // readers until the real text arrives.
    const reserved = heading.findByType('Eyebrow');
    expect(reserved.children).toEqual(['\u00A0']);
    expect(reserved.props.className).toContain('opacity-0');
    expect(reserved.props.accessible).toBe(false);
    expect(reserved.props.accessibilityElementsHidden).toBe(true);
    expect(reserved.props.importantForAccessibility).toBe('no-hide-descendants');

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
    expect(label.children).toEqual(['KILO-ORG/CLOUD']);
    expect(label.props.numberOfLines).toBe(1);
    expect(label.props.className).toContain('text-center');
    expect(label.props.className).not.toContain('opacity-0');
    expect(label.props.accessible).toBe(true);
    // The line the placeholder held is the line the label now paints, so the
    // header keeps its height and the placeholder is gone.
    const labelledHeading = renderer.root.findByProps({ className: 'min-w-0 flex-1' });
    expect(labelledHeading.findAllByType('Eyebrow')).toHaveLength(1);
    expect(labelledHeading.findAllByType('PlaceholderBar')).toHaveLength(0);
    renderer.unmount();
  });

  it('omits an absent eyebrow when no space is reserved', () => {
    const renderer = renderHeader({ title: '#6054' });
    expect(renderer.root.findAllByType('Eyebrow')).toHaveLength(0);
    renderer.unmount();
  });

  it('renders the subtitle under the title on one muted line', () => {
    const renderer = renderHeader({
      title: 'Profile agents',
      subtitle: 'Shared Agency Review Profile',
    });

    // The two-line heading is the block that carries the title row and the
    // subtitle row the back control stays centred on.
    const title = renderer.root.findByProps({ accessibilityRole: 'header' });
    const heading = title.parent?.parent?.parent;
    if (!heading) {
      throw new Error('heading block not found');
    }
    const texts = heading.findAllByType('Text');
    expect(texts[0]?.children).toEqual(['Profile agents']);
    const subtitle = texts[1];
    expect(subtitle?.children).toEqual(['Shared Agency Review Profile']);
    // Context under the title, never a second title: one line, tail ellipsis,
    // and the muted body style with no uppercase or tracking of its own.
    expect(subtitle?.props.variant).toBe('muted');
    expect(subtitle?.props.numberOfLines).toBe(1);
    expect(subtitle?.props.ellipsizeMode).toBe('tail');
    expect(subtitle?.props.className).not.toContain('uppercase');
    expect(subtitle?.props.className).not.toContain('tracking');
    expect(subtitle?.props.accessible).toBe(true);
    renderer.unmount();
  });

  it('keeps a reserved subtitle line hidden until its name arrives', () => {
    const renderer = renderHeader({
      title: 'Profile agents',
      reserveSubtitle: true,
      centerTitle: true,
    });

    const placeholder = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Text' &&
        node.props.variant === 'muted'
    )[0];
    expect(placeholder?.props.numberOfLines).toBe(1);
    expect(placeholder?.children).toEqual(['\u00A0']);
    expect(placeholder?.props.className).toContain('opacity-0');
    expect(placeholder?.props.accessible).toBe(false);
    expect(placeholder?.props.accessibilityElementsHidden).toBe(true);
    expect(placeholder?.props.importantForAccessibility).toBe('no-hide-descendants');

    act(() => {
      renderer.update(
        createElement(ScreenHeader, {
          title: 'Profile agents',
          reserveSubtitle: true,
          centerTitle: true,
          subtitle: 'Shared Agency Review Profile',
        })
      );
    });
    const name = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Text' &&
        node.props.variant === 'muted'
    )[0];
    expect(name?.children).toEqual(['Shared Agency Review Profile']);
    expect(name?.props.className).not.toContain('opacity-0');
    expect(name?.props.className).toContain('text-center');
    renderer.unmount();
  });

  it('paints a placeholder on the reserved subtitle line while the name loads', () => {
    const renderer = renderHeader({
      title: 'Profile agents',
      reserveSubtitle: true,
      subtitlePlaceholder: createElement('PlaceholderBar'),
    });

    expect(
      renderer.root.findAll(
        node => typeof node.type === 'string' && (node.type as string) === 'PlaceholderBar'
      )
    ).toHaveLength(1);
    // The placeholder is painted over the reserved line, which still holds the
    // height the name will take, so the placeholder and the name lay out the same.
    const reserved = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Text' &&
        node.props.variant === 'muted'
    );
    expect(reserved).toHaveLength(1);
    expect(reserved[0]?.children).toEqual(['\u00A0']);

    act(() => {
      renderer.update(
        createElement(ScreenHeader, {
          title: 'Profile agents',
          subtitle: 'Shared Agency Review Profile',
        })
      );
    });
    expect(
      renderer.root.findAll(
        node => typeof node.type === 'string' && (node.type as string) === 'PlaceholderBar'
      )
    ).toHaveLength(0);
    renderer.unmount();
  });

  it('omits the subtitle line when the caller reserves no space for it', () => {
    const renderer = renderHeader({ title: 'Profile agents' });
    const subtitles = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Text' &&
        node.props.variant === 'muted'
    );
    expect(subtitles).toHaveLength(0);
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
    expect(findBackFrame(renderer.root).props.className).toContain('-ms-4');
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

  it('pads a full-window modal below the status bar and keeps a sheet modal at its grabber clearance', () => {
    safeArea.top = 48;
    // The `modal` presentation reaches the window top on Android, so its header
    // adds the status-bar inset on top of the standard gap.
    platform.OS = 'android';
    const androidModal = findOuterContainer(renderHeader({ title: 'Sessions', modal: true }).root)
      .props.style;
    // A `formSheet` presents below the status bar there, and the sheet edge is
    // what provides the clearance, so the header adds no inset of its own.
    const androidSheet = findOuterContainer(
      renderHeader({ title: 'Sessions', modal: true, modalTopInset: 'bottom-form-sheet' }).root
    ).props.style;
    const androidPinned = findOuterContainer(renderHeader({ title: 'Sessions' }).root).props.style;

    platform.OS = 'ios';
    const iosModal = findOuterContainer(renderHeader({ title: 'Sessions', modal: true }).root).props
      .style;
    const iosSheet = findOuterContainer(
      renderHeader({ title: 'Sessions', modal: true, modalTopInset: 'bottom-form-sheet' }).root
    ).props.style;
    const iosPinned = findOuterContainer(renderHeader({ title: 'Sessions' }).root).props.style;

    expect(androidModal).toEqual({ paddingTop: 56 });
    expect(androidSheet).toEqual({ paddingTop: 32 });
    expect(androidPinned).toEqual({ paddingTop: 56 });
    // The same presentation is a native sheet there, so neither modal may take
    // the window inset: that would leave a dead band above the title.
    expect(iosModal).toEqual({ paddingTop: 32 });
    expect(iosSheet).toEqual({ paddingTop: 32 });
    expect(iosPinned).toEqual({ paddingTop: 56 });
  });

  it('keeps the grabber clearance when a modal surface reports no top edge', () => {
    const iosStyle = findOuterContainer(renderHeader({ title: 'Sessions', modal: true }).root).props
      .style;

    platform.OS = 'android';
    const androidStyle = findOuterContainer(renderHeader({ title: 'Sessions', modal: true }).root)
      .props.style;

    // Zero safe-area top: the surface already clears the system bar on both.
    expect(iosStyle).toEqual({ paddingTop: 32 });
    expect(androidStyle).toEqual(iosStyle);
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

  it('caps the eyebrow to one line with a middle ellipsis when eyebrowNumberOfLines is set', () => {
    const renderer = renderHeader({
      title: '#1',
      eyebrow: 'KILO-STUB/DISCUSSION-MIXED',
      eyebrowNumberOfLines: 1,
    });

    const eyebrow = renderer.root.findByType('Eyebrow');
    expect(eyebrow.props.numberOfLines).toBe(1);
    expect(eyebrow.props.ellipsizeMode).toBe('middle');
    expect(eyebrow.children).toEqual(['KILO-STUB/DISCUSSION-MIXED']);
  });

  it('keeps a reserved eyebrow on its own capped line above the title', () => {
    const renderer = renderHeader({ reserveEyebrow: true, eyebrowNumberOfLines: 1 });

    // The reserve is the eyebrow itself: a blank line in the same style, capped
    // and middle-ellipsized the way the label will be, so the header is already
    // the height the label leaves it and a path's distinguishing tail survives.
    const [reserved] = renderer.root.findAllByType('Eyebrow');
    expect(reserved?.children).toEqual(['\u00A0']);
    expect(reserved?.props.numberOfLines).toBe(1);
    expect(reserved?.props.ellipsizeMode).toBe('middle');
    expect(reserved?.props.accessible).toBe(false);
  });

  it('hands the title node to the caller that drives reading order', () => {
    const titleRef = vi.fn<(node: unknown) => void>();
    const renderer = renderHeader({ title: 'Sessions', titleRef });

    expect(titleRef).toHaveBeenCalled();
    expect(titleRef.mock.calls[0]?.[0]).not.toBeNull();
    renderer.unmount();
  });

  it('leaves titleRef unwired when titleContent replaces the title node', () => {
    const titleRef = vi.fn<(node: unknown) => void>();
    const renderer = renderHeader({
      title: 'Sessions',
      titleContent: createElement('Text', null, 'Sessions'),
      titleRef,
    });

    // A replaced title is the caller's own node, so the header has no title
    // Text to hand over; the caller refs its content instead.
    expect(titleRef).not.toHaveBeenCalled();
    renderer.unmount();
  });
});

describe('header actions row', () => {
  // This describe owns its window geometry, so every case starts from the
  // normal phone window the file's defaults describe.
  beforeEach(() => {
    Object.assign(layout, { width: 390, fontScale: 1 });
    Object.assign(safeArea, { top: 0, bottom: 0, left: 0, right: 0 });
    platform.OS = 'ios';
  });
  // The geometry stops leaking at the describe boundary.
  afterEach(() => {
    Object.assign(layout, { width: 390, fontScale: 1 });
    Object.assign(safeArea, { top: 0, bottom: 0, left: 0, right: 0 });
    platform.OS = 'ios';
  });

  it('keeps the actions on the title row at a normal phone width', () => {
    const renderer = renderHeader({ title: 'Agents', size: 'large', headerRight: 'RIGHT' });

    expect(renderer.root.findAll(isStackedActionsRow)).toHaveLength(0);
    const cluster = findHeaderRight(renderer.root);
    // The cluster's gap is the logical start margin (`ms-3`), which the RTL
    // swap cannot mirror away; it sizes to its content and never shrinks, so
    // the heading's `flex-1 min-w-0` box is what absorbs the squeeze.
    expect(cluster.props.className).toContain('ms-3');
    expect(cluster.props.className).toContain('shrink-0');
  });

  it('drops the actions to their own row when the window cannot hold the title beside them', () => {
    // The e1 geometry: 160dp wide with a 1.5 font scale left the 30px title
    // 48dp, which broke it and the mono link beside it into letter columns.
    layout.width = 160;
    layout.fontScale = 1.5;
    const renderer = renderHeader({ title: 'Agents', size: 'large', headerRight: 'RIGHT' });

    expect(renderer.root.findAll(isStackedActionsRow)).toHaveLength(1);
    // The single-row cluster is gone: the actions own a full-width row.
    expect(
      renderer.root.findAll(
        node =>
          typeof node.type === 'string' &&
          (node.type as string) === 'View' &&
          String(node.props.className ?? '').includes('ms-3 shrink-0')
      )
    ).toHaveLength(0);
    // The title still shares its row with the back control; only the actions moved.
    const title = renderer.root.findByProps({ accessibilityRole: 'header' });
    expect(title.parent?.parent).toBe(findBackFrame(renderer.root).parent);
  });

  it('reflows a centered modal header the same way', () => {
    layout.width = 160;
    layout.fontScale = 1.5;
    const renderer = renderHeader({ title: 'Agents', modal: true, headerRight: 'RIGHT' });

    expect(renderer.root.findAll(isStackedActionsRow)).toHaveLength(1);
    const title = renderer.root.findByProps({ accessibilityRole: 'header' });
    expect(title.parent?.parent?.parent).toBe(findBackFrame(renderer.root).parent);
  });

  it('leaves a header without actions on its single row', () => {
    layout.width = 160;
    layout.fontScale = 1.5;
    const renderer = renderHeader({ title: 'Agents', size: 'large' });

    expect(renderer.root.findAll(isStackedActionsRow)).toHaveLength(0);
  });

  it('drops a declared trailing cluster to its own row before it squeezes the title', () => {
    // A wide fixed-width cluster leaves too little room for a readable title.
    layout.width = 320;
    layout.fontScale = 2;
    const renderer = renderHeader({
      title: 'Detail',
      eyebrow: 'owner/repo',
      headerRight: 'RIGHT',
      headerRightWidth: 236,
    });

    expect(renderer.root.findAll(isStackedActionsRow)).toHaveLength(1);
  });

  it('keeps a narrower declared cluster on the title row', () => {
    // Two fixed-size icon controls with a 4dp gap.
    const renderer = renderHeader({
      title: 'Detail',
      eyebrow: 'owner/repo',
      headerRight: 'RIGHT',
      headerRightWidth: 92,
    });

    expect(renderer.root.findAll(isStackedActionsRow)).toHaveLength(0);
  });

  it.each([false, true])(
    'keeps compact actions beside the title when opted out (centered: %s)',
    centerTitle => {
      layout.width = 320;
      layout.fontScale = 3;
      const renderer = renderHeader({
        title: 'PR review #7',
        titleNumberOfLines: 1,
        centerTitle,
        headerRight: 'SHARE REVIEW MERGE',
        headerRightWidth: 140,
        allowHeaderRightStacking: false,
      });

      expect(renderer.root.findAll(isStackedActionsRow)).toHaveLength(0);
      const title = renderer.root.findByProps({ accessibilityRole: 'header' });
      expect(title.props.numberOfLines).toBe(1);
      expect(title.props.ellipsizeMode).toBe('tail');
      const controls = findHeaderRight(renderer.root);
      expect(controls.children).toEqual(['SHARE REVIEW MERGE']);
    }
  );
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

  it('reflows for a declared trailing cluster the title cannot share the row with', () => {
    // Declaring a wide cluster makes it reflow before the title is squeezed.
    expect(shouldStackHeaderActions(320, 2)).toBe(false);
    expect(shouldStackHeaderActions(320, 2, { headerRightWidth: 236 })).toBe(true);
    // A narrower cluster still fits beside the title at a normal phone width.
    expect(shouldStackHeaderActions(390, 1, { headerRightWidth: 92 })).toBe(false);
    expect(shouldStackHeaderActions(390, 1, { headerRightWidth: 236 })).toBe(true);
  });

  it('treats a missing window measurement as a single row', () => {
    expect(shouldStackHeaderActions(Number.NaN, 1)).toBe(false);
    expect(shouldStackHeaderActions(160, Number.NaN)).toBe(true);
  });

  it('reserves the title width the caller declares instead of the list title default', () => {
    // A detail header's title is the 18px style, narrower than the 30px list
    // title the default reserve assumes. Declaring its own width keeps that
    // header on one row where the default would already have reflowed it, and
    // still reflows when the cluster leaves the title below what it needs.
    expect(shouldStackHeaderActions(411, 1, { headerRightWidth: 240 })).toBe(true);
    expect(shouldStackHeaderActions(411, 1, { headerRightWidth: 240, titleMinWidth: 104 })).toBe(
      false
    );
    expect(shouldStackHeaderActions(360, 1, { headerRightWidth: 240, titleMinWidth: 104 })).toBe(
      true
    );
  });

  it('counts the row space the caller declares before its title', () => {
    // The default inset is the widest list gutter, which a header that shows a
    // back control beside its title does not charge. Declaring the real inset
    // reflows a window the default keeps on one row with a title too narrow to
    // paint, and leaves the compact phone width on a single row.
    const widths = { headerRightWidth: 238, titleMinWidth: 40 };
    expect(shouldStackHeaderActions(340, 1, widths)).toBe(false);
    expect(shouldStackHeaderActions(340, 1, { ...widths, contentInset: 65.5 })).toBe(true);
    expect(shouldStackHeaderActions(360, 1, { ...widths, contentInset: 65.5 })).toBe(false);
  });
});
