/* eslint-disable max-lines -- close button, trigger, two-axis modal, and table a11y semantics share one ~75-line native-module mock block; splitting the file would duplicate it */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';

import { moveA11yFocus } from '@/lib/a11y/announce';

import { MarkdownTable, TableRow } from './markdown-table';

import { type MarkdownPalette } from './markdown-palette';

// Stub native modules that markdown-table.tsx imports at module scope. Without
// a stub, the reanimated / gesture-handler / worklets entry points reach this
// `node` project as Flow source and the suite dies on `SyntaxError: Unexpected
// token 'typeof'`.
// `useState` returns `true` so the modal renders its children, exposing the
// rows, title, and close Pressable in the element tree for direct-call
// assertions. `useEffect` runs its callback so the zoom-reset effect is
// exercised; with the modal open it is a no-op. Focus moves through the Modal
// `onShow` callback, which the tests invoke directly.
vi.mock('react', async () => {
  const actual = await vi.importActual('react');
  return {
    ...actual,
    useCallback: (fn: unknown) => fn,
    useEffect: (fn: unknown) => {
      if (typeof fn === 'function') {
        (fn as () => void)();
      }
    },
    useRef: () => ({ current: null }),
    useState: () => [true, vi.fn()],
  };
});
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
vi.mock('@/components/ui/icons', () => ({
  Table2: 'Table2',
  X: 'X',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    foreground: '#000000',
  }),
}));
vi.mock('@/lib/a11y/announce', () => ({
  moveA11yFocus: vi.fn(),
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
  type: unknown;
  props: Record<string, unknown> & {
    children?: React.ReactNode;
  };
};

/** Walk the whole element tree, including arrays, and visit every element. */
function walkTree(element: unknown, visit: (node: RenderedElement) => void): void {
  if (element === null || element === undefined || typeof element !== 'object') {
    return;
  }
  if (Array.isArray(element)) {
    for (const child of element) {
      walkTree(child, visit);
    }
    return;
  }
  const node = element as RenderedElement;
  visit(node);
  const children = node.props.children;
  if (children !== undefined) {
    walkTree(children, visit);
  }
}

function findFirst(
  element: unknown,
  predicate: (node: RenderedElement) => boolean
): RenderedElement | null {
  let match: RenderedElement | null = null;
  walkTree(element, node => {
    if (match === null && predicate(node)) {
      match = node;
    }
  });
  return match;
}

function findAll(
  element: unknown,
  predicate: (node: RenderedElement) => boolean
): RenderedElement[] {
  const matches: RenderedElement[] = [];
  walkTree(element, node => {
    if (predicate(node)) {
      matches.push(node);
    }
  });
  return matches;
}

function accessibilityLabelOf(node: RenderedElement | null | undefined): string {
  if (node === null || node === undefined) {
    return '';
  }
  return typeof node.props.accessibilityLabel === 'string' ? node.props.accessibilityLabel : '';
}

/** The one accessible element per row that carries the linear reading label. */
function isAccessibleLabelElement(node: RenderedElement): boolean {
  return (
    node.type === 'View' &&
    node.props.accessible === true &&
    typeof node.props.accessibilityLabel === 'string'
  );
}

/**
 * A TableRow's cell elements. A direct call does not render nested components,
 * so match the TableCell nodes by the prop that carries the row's decision.
 */
function isTableCell(node: RenderedElement): boolean {
  return typeof node.props.hiddenFromA11y === 'boolean';
}

/** The row container: a flex-row View that must stay a non-accessible wrapper. */
function isRowContainer(node: RenderedElement): boolean {
  return node.type === 'View' && node.props.className === 'flex-row';
}

/**
 * The chip Pressable that opens the modal. Its accessible name is the linear
 * table summary ("Table, 1 column, 1 row, opens full screen"), so match on the
 * "Table," prefix; the visible chip text stays "View table".
 */
function findTriggerPressable(element: unknown): RenderedElement | null {
  return findFirst(
    element,
    node => node.type === 'Pressable' && accessibilityLabelOf(node).startsWith('Table,')
  );
}

/** Walk the element tree for a Text node rendering exactly the summary string. */
function findSummaryText(element: unknown, summary: string): RenderedElement | null {
  return findFirst(element, node => node.type === 'Text' && node.props.children === summary);
}

/** Every ScrollView node in tree order. */
function collectScrollViews(element: unknown): RenderedElement[] {
  return findAll(element, node => node.type === 'ScrollView');
}

/** Whether `node` appears anywhere inside `ancestor`'s subtree. */
function isDescendant(ancestor: RenderedElement, node: RenderedElement): boolean {
  return findAll(ancestor, () => true).includes(node);
}

describe('MarkdownTable close button', () => {
  it('renders a close Pressable with accessibilityLabel "Close table" and hitSlop 8', () => {
    // eslint-disable-next-line new-cap
    const element = MarkdownTable({ palette: mockPalette, header, rows });
    const closeButton = findFirst(
      element,
      node => node.type === 'Pressable' && accessibilityLabelOf(node) === 'Close table'
    );

    expect(closeButton).not.toBeNull();
    if (!closeButton) {
      throw new Error('closeButton should not be null');
    }
    expect(closeButton.props.accessibilityLabel).toBe('Close table');
    expect(closeButton.props.accessibilityRole).toBe('button');
    expect(closeButton.props.hitSlop).toBe(8);
  });
});

describe('MarkdownTable table semantics', () => {
  it('chip label states columns, rows, and the full-screen action', () => {
    // eslint-disable-next-line new-cap
    const element = MarkdownTable({ palette: mockPalette, header, rows });
    const chip = findFirst(
      element,
      node => node.type === 'Pressable' && accessibilityLabelOf(node).startsWith('Table,')
    );

    expect(chip).not.toBeNull();
    expect(chip?.props.accessibilityLabel).toBe('Table, 1 column, 1 row, opens full screen');
  });

  it('keeps the visible chip text and summary unchanged', () => {
    // eslint-disable-next-line new-cap
    const element = MarkdownTable({ palette: mockPalette, header, rows });
    const visibleTexts = findAll(element, node => node.type === 'Text').map(node => {
      const children = node.props.children;
      return typeof children === 'string' ? children : '';
    });

    expect(visibleTexts).toContain('View table');
    expect(visibleTexts).toContain('1 column · 1 row');
  });

  it('renders every row through TableRow with the flattened header texts', () => {
    // eslint-disable-next-line new-cap
    const element = MarkdownTable({ palette: mockPalette, header, rows });
    const rowNodes = findAll(element, node => node.type === TableRow);

    expect(rowNodes.length).toBe(2);
    expect(rowNodes[0]?.props.isHeader).toBe(true);
    expect(rowNodes[0]?.props.headerTexts).toEqual(['Column 1']);
    expect(rowNodes[1]?.props.headerTexts).toEqual(['Column 1']);
  });

  it('header row exposes its linear label as one accessible element', () => {
    // eslint-disable-next-line new-cap
    const element = TableRow({
      palette: mockPalette,
      cells: header,
      columnCount: 1,
      columnWidth: 200,
      isLastRow: false,
      isHeader: true,
      headerTexts: ['Column 1'],
    });
    const labelElement = findFirst(element, isAccessibleLabelElement);

    expect(labelElement).not.toBeNull();
    expect(accessibilityLabelOf(labelElement)).toBe('Column 1');
    // The container stays non-accessible so nested controls remain reachable.
    const container = findFirst(element, isRowContainer);
    expect(container?.props.accessible).not.toBe(true);
    expect(container?.props.accessibilityLabel).toBeUndefined();
  });

  it('body row exposes its linear label as one accessible element', () => {
    // eslint-disable-next-line new-cap
    const element = TableRow({
      palette: mockPalette,
      cells: [['Row 1']],
      columnCount: 1,
      columnWidth: 200,
      isLastRow: true,
      headerTexts: ['Column 1'],
    });
    const labelElement = findFirst(element, isAccessibleLabelElement);

    expect(labelElement).not.toBeNull();
    expect(accessibilityLabelOf(labelElement)).toBe('Column 1: Row 1');
    // The container stays non-accessible so nested controls remain reachable.
    const container = findFirst(element, isRowContainer);
    expect(container?.props.accessible).not.toBe(true);
    expect(container?.props.accessibilityLabel).toBeUndefined();
  });

  it('hides the cells of a plain row so the linear label is not read twice', () => {
    // eslint-disable-next-line new-cap
    const element = TableRow({
      palette: mockPalette,
      cells: [['John'], ['30']],
      columnCount: 2,
      columnWidth: 200,
      isLastRow: true,
      headerTexts: ['Name', 'Age'],
    });

    expect(accessibilityLabelOf(findFirst(element, isAccessibleLabelElement))).toBe(
      'Name: John, Age: 30'
    );
    const cells = findAll(element, isTableCell);
    expect(cells).toHaveLength(2);
    for (const cell of cells) {
      expect(cell.props.hiddenFromA11y).toBe(true);
    }
  });

  it('keeps a row with a nested control reachable and drops its linear label', () => {
    const link = createElement('Pressable', { onPress: () => undefined }, 'kilocode.ai');
    // eslint-disable-next-line new-cap
    const element = TableRow({
      palette: mockPalette,
      cells: [[link], ['30']],
      columnCount: 2,
      columnWidth: 200,
      isLastRow: true,
      headerTexts: ['Site', 'Age'],
    });

    // No row label: an accessible sibling plus reachable cells would read the
    // row twice, and the nested link must keep its own focus and tap target.
    expect(findFirst(element, isAccessibleLabelElement)).toBeNull();
    const cells = findAll(element, isTableCell);
    expect(cells).toHaveLength(2);
    for (const cell of cells) {
      expect(cell.props.hiddenFromA11y).toBe(false);
    }
  });

  it('keeps nested cell content as reachable siblings of the row label element', () => {
    // A cell carrying an interactive link stays a child of the NON-accessible
    // row container (and a sibling of the label element), so the nested
    // control is not shadowed by an accessible ancestor.
    const link = createElement(
      'Pressable',
      { accessibilityRole: 'link', accessibilityLabel: 'Open docs' },
      'docs'
    );
    // eslint-disable-next-line new-cap
    const element = TableRow({
      palette: mockPalette,
      cells: [[link]],
      columnCount: 1,
      columnWidth: 200,
      isLastRow: true,
      headerTexts: ['Docs'],
    });
    const container = findFirst(element, isRowContainer);
    const labelElement = findFirst(element, isAccessibleLabelElement);
    const nestedLink = findFirst(element, node => node.type === 'Pressable');

    expect(container).not.toBeNull();
    expect(container?.props.accessible).not.toBe(true);
    expect(labelElement).not.toBeNull();
    expect(accessibilityLabelOf(labelElement)).toBe('Docs: Open docs');
    expect(nestedLink).not.toBeNull();
  });

  it('modal title is a header and onShow moves focus to it after presentation', () => {
    // eslint-disable-next-line new-cap
    const element = MarkdownTable({ palette: mockPalette, header, rows });
    const title = findFirst(
      element,
      node => node.type === 'Text' && node.props.accessibilityRole === 'header'
    );
    const modal = findFirst(element, node => node.type === 'Modal');
    const onShow = modal?.props.onShow as (() => void) | undefined;

    expect(title).not.toBeNull();
    expect(title?.props.children).toBe('Table');
    expect(modal).not.toBeNull();
    expect(typeof onShow).toBe('function');
    expect(moveA11yFocus).not.toHaveBeenCalled();
    onShow?.();
    expect(moveA11yFocus).toHaveBeenCalled();
  });
});

describe('MarkdownTable trigger and two-axis modal', () => {
  it('renders the "View table" trigger Pressable', () => {
    // eslint-disable-next-line new-cap
    const element = MarkdownTable({ palette: mockPalette, header, rows });
    const trigger = findTriggerPressable(element);

    expect(trigger).not.toBeNull();
    if (!trigger) {
      throw new Error('trigger should not be null');
    }
    expect(trigger.props.accessibilityRole).toBe('button');
  });

  it('summarizes the existing 1-by-1 fixture as "1 column · 1 row"', () => {
    // eslint-disable-next-line new-cap
    const element = MarkdownTable({ palette: mockPalette, header, rows });

    expect(findSummaryText(element, '1 column · 1 row')).not.toBeNull();
  });

  it('summarizes a 2-by-3 fixture as "2 columns · 3 rows"', () => {
    const twoByThreeHeader: React.ReactNode[][] = [['A'], ['B']];
    const twoByThreeRows: React.ReactNode[][][] = [
      [['1'], ['2']],
      [['3'], ['4']],
      [['5'], ['6']],
    ];
    // eslint-disable-next-line new-cap
    const element = MarkdownTable({
      palette: mockPalette,
      header: twoByThreeHeader,
      rows: twoByThreeRows,
    });

    expect(findSummaryText(element, '2 columns · 3 rows')).not.toBeNull();
  });

  it('renders exactly two axis ScrollViews, inner horizontal nested in outer vertical', () => {
    // eslint-disable-next-line new-cap
    const element = MarkdownTable({ palette: mockPalette, header, rows });
    const scrollViews = collectScrollViews(element);

    expect(scrollViews).toHaveLength(2);
    const [outerScrollView, innerScrollView] = scrollViews;
    if (!outerScrollView || !innerScrollView) {
      throw new Error('expected exactly two ScrollViews');
    }
    expect(outerScrollView.props.horizontal).toBeUndefined();
    expect(innerScrollView.props.horizontal).toBe(true);
    expect(isDescendant(outerScrollView, innerScrollView)).toBe(true);
  });
});
