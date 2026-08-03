import { describe, expect, it, vi } from 'vitest';

import { MarkdownTable } from './markdown-table';

import { type MarkdownPalette } from './markdown-palette';

// Stub native modules that markdown-table.tsx imports at module scope. Without
// a stub, the reanimated / gesture-handler / worklets entry points reach this
// `node` project as Flow source and the suite dies on `SyntaxError: Unexpected
// token 'typeof'`.
// `useState` returns `true` so the modal renders its children, exposing
// the close Pressable in the element tree for direct-call assertions.
vi.mock('react', () => ({
  useCallback: (fn: unknown) => fn,
  useEffect: vi.fn(),
  useRef: () => ({ current: null }),
  useState: () => [true, vi.fn()],
}));
vi.mock('react-native', () => ({
  Modal: 'Modal',
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));
vi.mock('react-native-gesture-handler', () => {
  // RNGH's builder API chains without a fixed shape: `Gesture.Pinch()
  // .simultaneousWithExternalGesture(...).onStart(...).onEnd(...)`. One
  // self-returning proxy answers every link, so a new builder call in the
  // component never needs a new stub here.
  const chainable: unknown = new Proxy(vi.fn(), {
    apply: () => chainable,
    get: () => chainable,
  });
  return {
    Gesture: chainable,
    GestureDetector: 'GestureDetector',
    GestureHandlerRootView: 'GestureHandlerRootView',
    ScrollView: 'ScrollView',
  };
});
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  useAnimatedStyle: () => ({}),
  useSharedValue: (initial: unknown) => ({ value: initial }),
}));
vi.mock('react-native-worklets', () => ({
  scheduleOnRN: vi.fn(),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('lucide-react-native', () => ({
  Table2: 'Table2',
  X: 'X',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    foreground: '#000000',
  }),
}));

const mockPalette: MarkdownPalette = {
  textColor: '#000000',
  mutedTextColor: '#888888',
  codeBackground: '#f5f5f5',
  borderColor: '#cccccc',
  surfaceColor: '#ffffff',
};

const header: React.ReactNode[][] = [['Column 1']];
const rows: React.ReactNode[][][] = [[['Row 1']]];

/** Rendered element shape from direct-call component tests (mocked native primitives). */
type RenderedElement = {
  type: string;
  props: Record<string, unknown> & {
    children?: RenderedElement | RenderedElement[];
  };
};

/** Walk the element tree for a Pressable with accessibilityLabel="Close table". */
function findClosePressable(element: unknown): RenderedElement | null {
  if (!element || typeof element !== 'object') {
    return null;
  }
  const node = element as RenderedElement;
  if (node.type === 'Pressable' && node.props.accessibilityLabel === 'Close table') {
    return node;
  }
  const children = node.props.children;
  if (children) {
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) {
      const found = findClosePressable(child);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

describe('MarkdownTable close button', () => {
  it('renders a close Pressable with accessibilityLabel "Close table" and hitSlop 8', () => {
    // eslint-disable-next-line new-cap
    const element = MarkdownTable({ palette: mockPalette, header, rows });
    const closeButton = findClosePressable(element);

    expect(closeButton).not.toBeNull();
    if (!closeButton) {
      throw new Error('closeButton should not be null');
    }
    expect(closeButton.props.accessibilityLabel).toBe('Close table');
    expect(closeButton.props.accessibilityRole).toBe('button');
    expect(closeButton.props.hitSlop).toBe(8);
  });
});
