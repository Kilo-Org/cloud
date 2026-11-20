import {
  type ComponentProps,
  createElement,
  type ForwardedRef,
  forwardRef,
  useImperativeHandle,
} from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SheetHeader } from './sheet-header';
import '@/i18n';

const native = vi.hoisted(() => ({
  /** The surface's origin in window coordinates, as the native read answers it. */
  origin: 0 as number | null,
  /** The window's own top inset: 20pt on the SE, 62pt on a 17 Pro. */
  insetTop: 20,
  available: true,
  read: vi.fn<(tag: number) => void>(),
}));

vi.mock('react-native', () => {
  // The header measures its own window edge through the transform-aware rect,
  // which reads the sheet's own origin on every device.
  const View = forwardRef(function MeasurableView(
    props: Record<string, unknown>,
    ref: ForwardedRef<unknown>
  ) {
    useImperativeHandle(ref, () => ({ getBoundingClientRect: () => ({ top: 0 }) }));
    return createElement('View', props);
  });
  return {
    ActivityIndicator: 'ActivityIndicator',
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    View,
    I18nManager: { allowRTL: vi.fn(), isRTL: false, forceRTL: vi.fn() },
    Platform: { OS: 'ios' },
    StatusBar: { currentHeight: 0 },
    BackHandler: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
    findNodeHandle: () => 41,
    Keyboard: { addListener: vi.fn(() => ({ remove: vi.fn() })) },
  };
});
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: native.insetTop, bottom: 34, left: 0, right: 0 }),
}));
// The presented origin is the read no JS measurement can make: it is the only
// value that differs between a phone whose sheet reaches the window top and one
// where the sheet presents below the status bar.
vi.mock('@/lib/native-surface-geometry', () => ({
  get isNativeSurfaceGeometryAvailable() {
    return native.available;
  },
  presentedSurfaceOriginTop: async (tag: number) => {
    native.read(tag);
    await Promise.resolve();
    return native.origin;
  },
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ back: vi.fn() }),
}));
vi.mock('@/components/empty-state', () => ({
  EmptyState: 'EmptyState',
  StateAction: 'StateAction',
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({ Info: 'Info', Share: 'Share', X: 'X' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#111827', primary: '#2563eb', mutedForeground: '#6b7280' }),
}));
vi.mock('@/components/keyboard-motion-provider', () => ({
  useKeyboardMotionHeight: () => ({ value: 0 }),
}));

async function mount(
  props: ComponentProps<typeof SheetHeader>
): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(createElement(SheetHeader, props));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

/**
 * The header's inner wrapper carries the top band as an inline `paddingTop`; it
 * is the closest className-less host view above the action row.
 */
function topClearance(renderer: TestRenderer.ReactTestRenderer): number {
  const row = renderer.root.find(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'View' &&
      typeof node.props.className === 'string' &&
      node.props.className.includes('flex-row')
  );
  let candidate = row.parent;
  while (candidate !== null) {
    if (
      typeof candidate.type === 'string' &&
      (candidate.type as string) === 'View' &&
      candidate.props.className === undefined
    ) {
      const style = candidate.props.style as { paddingTop?: number } | undefined;
      return style?.paddingTop ?? 0;
    }
    candidate = candidate.parent;
  }
  throw new Error('safe-area wrapper not found');
}

function mountHeader(): Promise<TestRenderer.ReactTestRenderer> {
  return mount({ title: 'Invite member', onDone: () => undefined, topInset: 'bottom-form-sheet' });
}

/** Runs every sample of the presentation burst and lets its reads settle. */
async function settlePresentation(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1400);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  native.origin = 0;
  native.insetTop = 20;
  native.available = true;
});

describe('SheetHeader presented top clearance', () => {
  it('clears the status bar on a phone whose sheet presents at the window top', async () => {
    // iPhone SE: the native sheet's maximum height is the whole window, so its
    // origin converts to 0 and the header's first row starts 5pt inside the
    // 20pt status-bar band without this.
    const renderer = await mountHeader();
    await settlePresentation();

    expect(native.read).toHaveBeenCalledWith(41);
    expect(topClearance(renderer)).toBe(20);
    renderer.unmount();
  });

  it('adds no band on a phone whose sheet presents below the status bar', async () => {
    // iPhone 17 Pro: the same route presents its sheet at the 62pt window
    // inset, so the header is already below the status bar and any band here
    // would be dead space above the title.
    native.insetTop = 62;
    native.origin = 62;
    const renderer = await mountHeader();
    await settlePresentation();

    expect(topClearance(renderer)).toBe(0);
    renderer.unmount();
  });

  it('adds no band where the binary has no native origin read', async () => {
    native.available = false;
    const renderer = await mountHeader();
    await settlePresentation();

    expect(native.read).not.toHaveBeenCalled();
    expect(topClearance(renderer)).toBe(0);
    renderer.unmount();
  });

  it('leaves a header that promises it never reaches the window top untouched', async () => {
    const renderer = await mount({
      title: 'Discard changes?',
      onDone: () => undefined,
      topInset: 'never',
    });
    await settlePresentation();

    expect(topClearance(renderer)).toBe(0);
    renderer.unmount();
  });

  it('leaves an iOS page sheet untouched, which presents below the status bar itself', async () => {
    const renderer = await mount({
      title: 'Session',
      onDone: () => undefined,
      topInset: 'ios-page-sheet',
    });
    await settlePresentation();

    expect(topClearance(renderer)).toBe(0);
    renderer.unmount();
  });
});
