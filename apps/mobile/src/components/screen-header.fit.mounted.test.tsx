import { createElement, type ForwardedRef, forwardRef, useImperativeHandle } from 'react';
import { View } from 'react-native';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ScreenHeader } from './screen-header';

// The emulator's density and the widths it measured for German "Unterhaltung"
// beside the account picker: the word needs 441px, the row gave it 440px.
const PIXEL_RATIO = 2.625;
const widths = vi.hoisted(() => ({ natural: 0, box: 0 }));

// The header reads the title's natural width (the hidden copy, a Text) and the
// room the row gives it (the box around the visible title, a View) through the
// synchronous host rect.
vi.mock('react-native', () => {
  const measurable = (type: string, width: () => number) =>
    forwardRef(function Measurable(props: Record<string, unknown>, ref: ForwardedRef<unknown>) {
      useImperativeHandle(ref, () => ({ getBoundingClientRect: () => ({ width: width() }) }));
      return createElement(type, props);
    });
  return {
    I18nManager: { isRTL: false },
    Platform: { OS: 'android' },
    PixelRatio: { get: () => 2.625 },
    StatusBar: { currentHeight: 24 },
    Pressable: 'Pressable',
    View: measurable('View', () => widths.box),
    useWindowDimensions: () => ({ width: 411.43, height: 914, fontScale: 1 }),
  };
});
vi.mock('@/components/ui/text', () => {
  const Text = forwardRef(function MeasurableText(
    props: Record<string, unknown>,
    ref: ForwardedRef<unknown>
  ) {
    useImperativeHandle(ref, () => ({ getBoundingClientRect: () => ({ width: widths.natural }) }));
    return createElement('Text', props);
  });
  return { Text };
});
vi.mock('expo-router', () => ({
  useRouter: () => ({
    back: vi.fn(),
    replace: vi.fn(),
    dismissTo: vi.fn(),
    canGoBack: () => false,
  }),
  useNavigationContainerRef: () => ({ addListener: () => () => undefined }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@/components/ui/icons', () => ({
  ChevronDown: 'ChevronDown',
  ChevronLeft: 'ChevronLeft',
}));
vi.mock('@/components/ui/eyebrow', () => ({ Eyebrow: 'Eyebrow' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({ foreground: '#000' }) }));

// A node slot under the narrowed contract: the header's slots take elements,
// never bare strings, so the cluster is an empty view carrying a testID the
// stacked-row matcher can find.
const INLINE_ACTIONS_MARKER = 'inline-actions-marker';

function stackedActionRows(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'View' &&
      String(node.props.className ?? '').includes('mt-2') &&
      node.findAll(marker => marker.props.testID === INLINE_ACTIONS_MARKER).length > 0
  );
}

function render(title: string): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(ScreenHeader, {
        title,
        size: 'large',
        showBackButton: false,
        inlineActions: createElement(View, { testID: INLINE_ACTIONS_MARKER }),
        allowInlineActionsStacking: false,
      })
    );
  });
  if (!ref.current) {
    throw new Error('renderer was not created');
  }
  return ref.current;
}

describe('ScreenHeader title fit, read before the first frame', () => {
  beforeEach(() => {
    Object.assign(widths, { natural: 0, box: 0 });
  });

  // No layout event fires in these tests: the decision comes from the layout
  // effect's synchronous read alone, so the frame that mounts the header never
  // shows the cut title beside the cluster.
  it('mounts a cut title with the cluster already under it', () => {
    Object.assign(widths, { natural: 441 / PIXEL_RATIO, box: 440 / PIXEL_RATIO });
    expect(stackedActionRows(render('Unterhaltung'))).toHaveLength(1);
  });

  it('mounts a title that gets its natural width with the cluster beside it', () => {
    Object.assign(widths, { natural: 288 / PIXEL_RATIO, box: 288 / PIXEL_RATIO });
    expect(stackedActionRows(render('Agenten'))).toHaveLength(0);
  });
});
