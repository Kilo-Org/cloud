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

const surface = vi.hoisted(() => ({
  top: 24,
  show: [] as (() => void)[],
  hide: [] as (() => void)[],
}));
const keyboardMotion = vi.hoisted(() => ({ value: 0 }));

vi.mock('react-native', () => {
  // The header measures its own window edge through the transform-aware rect,
  // which is the only read that sees where the platform put the sheet.
  const View = forwardRef(function MeasurableView(
    props: Record<string, unknown>,
    ref: ForwardedRef<unknown>
  ) {
    useImperativeHandle(ref, () => ({
      getBoundingClientRect: () => ({ top: surface.top }),
    }));
    return createElement('View', props);
  });
  return {
    ActivityIndicator: 'ActivityIndicator',
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    View,
    I18nManager: { allowRTL: vi.fn(), isRTL: false, forceRTL: vi.fn() },
    Platform: { OS: 'android' },
    StatusBar: { currentHeight: 51.81 },
    BackHandler: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
    Keyboard: {
      addListener: (event: string, listener: () => void) => {
        if (event === 'keyboardDidShow') {
          surface.show.push(listener);
        } else {
          surface.hide.push(listener);
        }
        return { remove: vi.fn() };
      },
    },
  };
});
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 51.81, bottom: 24, left: 0, right: 0 }),
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
// The keyboard's UI-thread height; a header must not grow from it alone.
vi.mock('@/components/keyboard-motion-provider', () => ({
  useKeyboardMotionHeight: () => keyboardMotion,
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
 * The header row sits in an inner wrapper that carries the top and landscape
 * side insets. It is the closest className-less host view above the row: the
 * mounted `View` is a component here (so the test can hand the header a
 * measurable surface), so the row's direct parent is that component, not the
 * wrapper element.
 */
function findSafeAreaWrapper(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
  const row = root.find(
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
      return candidate;
    }
    candidate = candidate.parent;
  }
  throw new Error('safe-area wrapper not found');
}

function topClearance(renderer: TestRenderer.ReactTestRenderer): unknown {
  const style = findSafeAreaWrapper(renderer.root).props.style as
    | { paddingTop?: number }
    | undefined;
  return style?.paddingTop ?? 0;
}

function mountHeader(): Promise<TestRenderer.ReactTestRenderer> {
  return mount({
    title: 'New list',
    onDone: () => undefined,
    onCancel: () => undefined,
    topInset: 'bottom-form-sheet',
  });
}

describe('SheetHeader settled top clearance', () => {
  beforeEach(() => {
    surface.top = 24;
    surface.show = [];
    surface.hide = [];
    keyboardMotion.value = 0;
  });

  it('keeps a never-inset header at the surface edge whatever the sheet measures', async () => {
    // A surface that can never reach the window top reserves no inset, and the
    // settled read must not top one up: it measures the header inside its own
    // surface, so a surface that places its content at its own origin reads as
    // the window top and would push the title down by the whole inset.
    vi.useFakeTimers();
    try {
      surface.top = 0;
      const renderer = await mount({
        title: 'Discard changes?',
        onDone: () => undefined,
        topInset: 'never',
      });
      await act(async () => {
        vi.advanceTimersByTime(800);
        await Promise.resolve();
      });

      expect(topClearance(renderer)).toBe(0);

      renderer.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('covers the inset the presented sheet left above the header', async () => {
    vi.useFakeTimers();
    try {
      const renderer = await mountHeader();
      await act(async () => {
        vi.advanceTimersByTime(800);
        await Promise.resolve();
      });

      // 24 dp edge inside a 51.81 dp inset: the header adds the 27.8 dp band.
      expect(topClearance(renderer)).toBeCloseTo(27.81);

      renderer.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('adds no space above the row while the keyboard is up and the sheet stays at the half detent', async () => {
    // The sheet can keep its half detent with the keyboard up (list settings
    // in the dark, compact and Arabic gate cells). Its header is far below the
    // status bar, so any band above the row only pushes the Emoji and Name
    // fields under the keyboard.
    vi.useFakeTimers();
    try {
      surface.top = 443.05;
      keyboardMotion.value = 330;
      const renderer = await mountHeader();
      await act(async () => {
        for (const listener of surface.show) {
          listener();
        }
        vi.advanceTimersByTime(1100);
        await Promise.resolve();
      });

      expect(topClearance(renderer)).toBe(0);
      expect(findSafeAreaWrapper(renderer.root).children).toHaveLength(1);

      renderer.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('follows the sheet into the status bar when the keyboard expands it', async () => {
    vi.useFakeTimers();
    try {
      const renderer = await mountHeader();
      await act(async () => {
        vi.advanceTimersByTime(800);
        await Promise.resolve();
      });
      expect(topClearance(renderer)).toBeCloseTo(27.81);

      // The Name field raises the keyboard, the sheet expands to the full
      // detent and its header edge reaches the window top after the samples
      // taken during the presentation.
      surface.top = 0;
      await act(async () => {
        for (const listener of surface.show) {
          listener();
        }
        vi.advanceTimersByTime(1100);
        await Promise.resolve();
      });

      expect(topClearance(renderer)).toBeCloseTo(51.81);

      renderer.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the reserve when the sheet settles lower again', async () => {
    vi.useFakeTimers();
    try {
      const renderer = await mountHeader();
      await act(async () => {
        vi.advanceTimersByTime(800);
        await Promise.resolve();
      });

      surface.top = 0;
      await act(async () => {
        for (const listener of surface.show) {
          listener();
        }
        vi.advanceTimersByTime(1100);
        await Promise.resolve();
      });
      expect(topClearance(renderer)).toBeCloseTo(51.81);

      // Dismissing the keyboard drops the sheet back to the half detent; the
      // reserve only grows within a mount, so the header stays where it is
      // instead of jumping while the sheet moves.
      surface.top = 457.14;
      await act(async () => {
        for (const listener of surface.hide) {
          listener();
        }
        vi.advanceTimersByTime(1100);
        await Promise.resolve();
      });

      expect(topClearance(renderer)).toBeCloseTo(51.81);

      renderer.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
