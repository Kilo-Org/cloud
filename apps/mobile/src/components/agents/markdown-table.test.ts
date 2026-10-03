/* eslint-disable max-lines -- Table semantics and modal tests share the direct-invocation tree-walk harness. */
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line import/no-nodejs-modules -- patching the CJS loader is the only way to stub react-native for the externalized react-native-marked; the library under test stays real
import Module from 'node:module';

import { moveA11yFocus } from '@/lib/a11y/announce';

import {
  MarkdownTable,
  MarkdownTableBodyRenderer,
  MemoTableRow,
  TABLE_ROW_MOUNT_LIMIT,
  TABLE_ROW_MOUNT_STEP,
  TableRow,
} from './markdown-table';

import { type MarkdownPalette } from './markdown-palette';
import { useMarkdown } from 'react-native-marked';

import '@/i18n';
import type * as ReactI18next from 'react-i18next';

// The press-path suite un-mocks react-native-marked so the real parser builds
// the cell tree. That library is externalized by vitest, so vi.mock('react-native')
// does not intercept its nested requires; patch Module._load here (before any
// dynamic import) so the real Renderer/useMarkdown can construct under node.
// The link-press observation uses a real Linking stub: a regression back to the
// library Renderer would call openURL through this spy instead of the confirm
// helper.
const linkingOpenURL = vi.fn();
const rnLibStub = {
  Text: 'Text',
  View: 'View',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  TouchableHighlight: 'TouchableHighlight',
  Image: 'Image',
  Linking: { openURL: linkingOpenURL },
  StyleSheet: {
    create: (styles: Record<string, unknown>) => styles,
    hairlineWidth: 1,
    flatten: (style: unknown) =>
      Array.isArray(style)
        ? Object.assign({}, ...(style.filter(Boolean) as Record<string, unknown>[]))
        : style,
  },
  Dimensions: {
    get: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
    addEventListener: () => ({ remove: () => undefined }),
  },
  Platform: {
    OS: 'ios',
    select: (spec: { ios?: unknown; default?: unknown }) => spec.ios ?? spec.default,
  },
  I18nManager: { isRTL: false },
  PixelRatio: { get: () => 3 },
  NativeModules: {},
  requireNativeComponent: () => 'NativeComponent',
};
type CjsLoad = (request: string, parent: NodeJS.Module | null, isMain: boolean) => unknown;
const ModuleWithLoad = Module as unknown as { _load: CjsLoad };
const originalLoad = ModuleWithLoad._load.bind(ModuleWithLoad);
ModuleWithLoad._load = (request: string, parent: NodeJS.Module | null, isMain: boolean) => {
  if (request === 'react-native') {
    return rnLibStub;
  }
  if (request === 'react-native-svg') {
    return { default: 'Svg', Svg: 'Svg', Path: 'Path', G: 'G', Rect: 'Rect', Circle: 'Circle' };
  }
  return originalLoad(request, parent, isMain);
};

vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return {
    ...actual,
    useTranslation: () => {
      const i18n = actual.getI18n();
      return { t: i18n.t.bind(i18n), i18n };
    },
  };
});

// The body parse is mocked here: tests drive MarkdownTableBody's open/empty/
// wait states through `useMarkdown`'s return value, and assert the cell tree
// is only ever requested after the modal opens.
vi.mock('react-native-marked', () => ({
  useMarkdown: vi.fn(() => []),
  // eslint-disable-next-line typescript-eslint/no-extraneous-class -- minimal base class so MarkdownTableBodyRenderer can extend it under the mocked module
  Renderer: class Renderer {},
}));

vi.mock('@/components/ui/activity-indicator', () => ({
  ActivityIndicator: 'ActivityIndicator',
}));
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  I18nManager: { isRTL: false },
  Modal: 'Modal',
  Platform: {
    OS: 'ios',
    select: (spec: { ios?: unknown; default?: unknown }) => spec.ios ?? spec.default,
  },
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
  useColorScheme: () => 'light',
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));
// MarkdownTableBodyRenderer extends the real MarkdownRenderer, whose module
// imports CodeBlock / MarkdownImage / the link-confirm helper. Be inert here:
// the renderer's link press-path is asserted against the confirm helper, and
// the other suites never mount those subtrees.
vi.mock('./code-block', () => ({
  CodeBlock: 'CodeBlock',
}));
vi.mock('./markdown-image', () => ({
  MarkdownImage: 'MarkdownImage',
}));
vi.mock('./markdown-link-confirm', () => ({
  confirmAndOpenMarkdownLink: vi.fn(),
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
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/centered-state-surface', () => ({ StateSurface: 'StateSurface' }));
vi.mock('@/components/ui/accessible-status', () => ({
  AccessibleStatus: 'AccessibleStatus',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    foreground: '#000000',
  }),
}));
vi.mock('@/lib/a11y/announce', () => ({
  moveA11yFocus: vi.fn(() => true),
}));

const mockPalette: MarkdownPalette = {
  textColor: '#000000',
  mutedTextColor: '#888888',
  codeBackground: '#f5f5f5',
  borderColor: '#cccccc',
  surfaceColor: '#ffffff',
};

const header: React.ReactNode[][] = [['Column 1']];

const defaultProps = {
  palette: mockPalette,
  raw: '| Column 1 |\n| --- |\n| Row 1 |',
  tableKey: 'md-table-0',
  columnCount: 1,
  rowCount: 1,
  selectable: true,
};

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

/**
 * Mount the element tree a `MarkdownTableBodyRenderer.table()` call returns.
 * A direct call does not descend into the components the tree contains, so the
 * capped body rows are only observable once that element is rendered.
 */
function renderTableElement(element: React.ReactNode): TestRenderer.ReactTestRenderer {
  let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
  act(() => {
    renderer = TestRenderer.create(element as React.ReactElement);
  });
  // oxlint-disable-next-line @typescript-eslint/no-unnecessary-condition -- act callback assignment, not statically guaranteed
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

/**
 * A mounted row is `MemoTableRow`; the renderer exposes the memo wrapper's
 * inner function as the fiber type, so match either identity.
 */
function isRenderedTableRow(node: { type: unknown }): boolean {
  return node.type === MemoTableRow || node.type === TableRow;
}

/** Every mounted row of a rendered table body, in tree order. */
function memoTableRows(renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance[] {
  return renderer.root.findAll(isRenderedTableRow);
}

/** The Load more footer Pressable, present while rows remain unmounted. */
function loadMoreNode(renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance {
  const nodes = renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'Pressable' &&
      node.props.accessibilityLabel === 'Load more'
  );
  const first = nodes[0];
  if (!first) {
    throw new Error('Load more Pressable missing');
  }
  return first;
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

function renderTable(overrides: Partial<typeof defaultProps> = {}): TestRenderer.ReactTestRenderer {
  let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
  act(() => {
    renderer = TestRenderer.create(createElement(MarkdownTable, { ...defaultProps, ...overrides }));
  });
  // oxlint-disable-next-line @typescript-eslint/no-unnecessary-condition -- act callback assignment, not statically guaranteed
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function chipNode(renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance {
  const chip = renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'Pressable' &&
      node.props.testID === 'md-table-0'
  );
  expect(chip).toHaveLength(1);
  const first = chip[0];
  if (!first) {
    throw new Error('chip Pressable missing');
  }
  return first;
}

function closeNode(renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance {
  const close = renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'Pressable' &&
      node.props.accessibilityLabel === 'Close table'
  );
  expect(close).toHaveLength(1);
  const first = close[0];
  if (!first) {
    throw new Error('close Pressable missing');
  }
  return first;
}

function openTable(renderer: TestRenderer.ReactTestRenderer): void {
  act(() => {
    (chipNode(renderer).props.onPress as (() => void) | undefined)?.();
  });
}

/** The reader's header; accessibility focus is tied to its first layout. */
function titleNode(renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance {
  const nodes = renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'Text' &&
      node.props.accessibilityRole === 'header'
  );
  expect(nodes).toHaveLength(1);
  const first = nodes[0];
  if (!first) {
    throw new Error('table title missing');
  }
  return first;
}

/** The native layout pass that runs once the presented sheet's title exists. */
function layoutTitle(renderer: TestRenderer.ReactTestRenderer): void {
  act(() => {
    (titleNode(renderer).props.onLayout as (() => void) | undefined)?.();
  });
}

/**
 * The native sheet host: `Sheet` renders `@expo/ui/community/bottom-sheet`'s
 * `BottomSheet`, which the shared setup stubs as this host string. `Sheet`
 * returns null until it is first shown, so a never-opened tree has none.
 */
function findSheets(
  root: TestRenderer.ReactTestInstance | undefined
): TestRenderer.ReactTestInstance[] {
  return root === undefined ? [] : root.findAll(node => (node.type as unknown) === 'BottomSheet');
}

beforeEach(() => {
  vi.mocked(useMarkdown).mockReset();
  vi.mocked(useMarkdown).mockReturnValue([]);
  vi.mocked(moveA11yFocus).mockClear();
});

describe('MarkdownTable closed tree', () => {
  it('renders the chip and no sheet chrome when closed', () => {
    const renderer = renderTable();

    expect(chipNode(renderer)).toBeTruthy();
    expect(findSheets(renderer.root)).toHaveLength(0);
    expect(
      renderer.root.findAll(
        node =>
          typeof node.type === 'string' &&
          (node.type as string) === 'Pressable' &&
          node.props.accessibilityLabel === 'Close table'
      )
    ).toHaveLength(0);
  });

  it('chip label states columns, rows, and the full-screen action', () => {
    const renderer = renderTable();
    expect(chipNode(renderer).props.accessibilityLabel).toBe(
      'Table, 1 column, 1 row, opens full screen'
    );
  });

  it('summarizes the existing 1-by-1 fixture as "1 column · 1 row"', () => {
    const renderer = renderTable();
    expect(
      renderer.root.findAll(
        node =>
          typeof node.type === 'string' &&
          (node.type as string) === 'Text' &&
          node.props.children === '1 column · 1 row'
      )
    ).toHaveLength(1);
  });

  it('summarizes a 2-by-3 fixture as "2 columns · 3 rows"', () => {
    const renderer = renderTable({ columnCount: 2, rowCount: 3 });
    expect(
      renderer.root.findAll(
        node =>
          typeof node.type === 'string' &&
          (node.type as string) === 'Text' &&
          node.props.children === '2 columns · 3 rows'
      )
    ).toHaveLength(1);
  });

  it('does not parse the table until the chip opens the modal', () => {
    renderTable();
    expect(useMarkdown).not.toHaveBeenCalled();
  });
});

describe('MarkdownTable open path', () => {
  it('opens the sheet and renders title, Close, then the parsed cells', () => {
    vi.mocked(useMarkdown).mockReturnValue([
      createElement('View', { testID: 'body-cells' }, 'cells'),
    ]);
    const renderer = renderTable();
    openTable(renderer);

    expect(findSheets(renderer.root)).toHaveLength(1);
    const title = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Text' &&
        node.props.accessibilityRole === 'header'
    );
    expect(title).toHaveLength(1);
    expect(title[0]?.props.children).toBe('Table');
    expect(closeNode(renderer)).toBeTruthy();
    expect(renderer.root.findAll(node => node.props.testID === 'body-cells')).toHaveLength(1);
    expect(useMarkdown).toHaveBeenCalledTimes(1);
  });

  it('keeps the sheet open and re-parses when raw changes under the same key', () => {
    vi.mocked(useMarkdown).mockReturnValue([
      createElement('View', { testID: 'body-cells' }, 'cells'),
    ]);
    const renderer = renderTable();
    openTable(renderer);
    expect(findSheets(renderer.root)).toHaveLength(1);

    act(() => {
      renderer.update(
        createElement(MarkdownTable, {
          ...defaultProps,
          raw: '| Column 2 |\n| --- |\n| Row 2 |',
        })
      );
    });

    expect(findSheets(renderer.root)).toHaveLength(1);
    expect(useMarkdown).toHaveBeenLastCalledWith(
      '| Column 2 |\n| --- |\n| Row 2 |',
      expect.anything()
    );
  });

  it('shows the empty status for a zero-row table and keeps Close available', () => {
    const renderer = renderTable({ rowCount: 0 });
    openTable(renderer);

    const status = renderer.root.findAll(
      node => typeof node.type === 'string' && (node.type as string) === 'AccessibleStatus'
    );
    expect(status).toHaveLength(1);
    expect(status[0]?.props.message).toBe('This table has no rows.');
    expect(status[0]?.props.tone).toBe('status');
    expect(closeNode(renderer)).toBeTruthy();
    const centered = renderer.root.findAll(node => (node.type as string) === 'CenteredState');
    expect(centered).toHaveLength(1);
    expect(renderer.root.findAll(node => (node.type as string) === 'ScrollView')).toHaveLength(0);
    expect(renderer.root.findAll(node => (node.type as string) === 'GestureDetector')).toHaveLength(
      0
    );
    const surface = renderer.root.find(
      node => (node.type as string) === 'View' && node.props.className === 'flex-1 bg-background'
    );
    expect(surface.parent?.type).toBe('BottomSheet');
  });

  it('replaces the centered state with cells and retains cells across an empty parse', () => {
    const renderer = renderTable({ rowCount: 0 });
    openTable(renderer);
    vi.mocked(useMarkdown).mockReturnValue([
      createElement('View', { testID: 'retained-cells' }, 'row'),
    ]);
    act(() => {
      renderer.update(createElement(MarkdownTable, defaultProps));
    });
    expect(renderer.root.findAll(node => (node.type as string) === 'CenteredState')).toHaveLength(
      0
    );
    expect(renderer.root.findAll(node => (node.type as string) === 'ScrollView')).toHaveLength(2);
    vi.mocked(useMarkdown).mockReturnValue([]);
    act(() => {
      renderer.update(createElement(MarkdownTable, { ...defaultProps, rowCount: 0, raw: '' }));
    });
    expect(renderer.root.findAll(node => node.props.testID === 'retained-cells')).toHaveLength(1);
    expect(renderer.root.findAll(node => (node.type as string) === 'CenteredState')).toHaveLength(
      0
    );
    expect(renderer.root.findAll(node => (node.type as string) === 'ScrollView')).toHaveLength(2);
    act(() => {
      renderer.unmount();
    });
  });

  it('shows the loading wait before first cells and Close still works', () => {
    const renderer = renderTable({ rowCount: 2 });
    openTable(renderer);

    expect(
      renderer.root.findAll(
        node => typeof node.type === 'string' && (node.type as string) === 'ActivityIndicator'
      )
    ).toHaveLength(1);
    const status = renderer.root.findAll(
      node => typeof node.type === 'string' && (node.type as string) === 'AccessibleStatus'
    );
    expect(status).toHaveLength(1);
    expect(status[0]?.props.message).toBe('Loading table');

    act(() => {
      (closeNode(renderer).props.onPress as (() => void) | undefined)?.();
    });
    // Close starts the native dismiss (`index` -1); the native dismiss event
    // then unmounts the sheet (`Sheet` returns null while not mounted).
    const dismissing = findSheets(renderer.root)[0];
    expect(dismissing?.props.index).toBe(-1);
    act(() => {
      (dismissing?.props.onDismiss as (() => void) | undefined)?.();
    });
    expect(findSheets(renderer.root)).toHaveLength(0);
  });

  it('close button is a button with accessibilityLabel "Close table"', () => {
    vi.mocked(useMarkdown).mockReturnValue([
      createElement('View', { testID: 'body-cells' }, 'cells'),
    ]);
    const renderer = renderTable();
    openTable(renderer);

    const close = closeNode(renderer);
    expect(close.props.accessibilityRole).toBe('button');
    expect(close.props.accessibilityLabel).toBe('Close table');
  });

  it('moves focus to the title only once the presented sheet lays it out', () => {
    vi.mocked(useMarkdown).mockReturnValue([
      createElement('View', { testID: 'body-cells' }, 'cells'),
    ]);
    const renderer = renderTable();
    expect(moveA11yFocus).not.toHaveBeenCalled();

    openTable(renderer);
    expect(findSheets(renderer.root)).toHaveLength(1);
    // `Sheet` returns null on the commit that flips `open`, so the title mounts
    // a render later; the open flag alone must not move focus.
    expect(moveA11yFocus).not.toHaveBeenCalled();

    layoutTitle(renderer);
    expect(moveA11yFocus).toHaveBeenCalledTimes(1);
    // A move to a ref that is still empty would focus nothing.
    expect(vi.mocked(moveA11yFocus).mock.calls[0]?.[0]?.current).toBeTruthy();
  });

  it('retries the title focus after a layout that landed before the title handle existed', () => {
    vi.mocked(useMarkdown).mockReturnValue([
      createElement('View', { testID: 'body-cells' }, 'cells'),
    ]);
    // Android delivers the first layout before the ref is attached, and
    // `findNodeHandle` on an empty ref resolves nothing, so the helper reports
    // false. That must not burn the once-per-presentation guard.
    vi.mocked(moveA11yFocus).mockReturnValueOnce(false).mockReturnValue(true);
    const renderer = renderTable();
    openTable(renderer);

    layoutTitle(renderer);
    expect(moveA11yFocus).toHaveBeenCalledTimes(1);

    layoutTitle(renderer);
    expect(moveA11yFocus).toHaveBeenCalledTimes(2);
    expect(vi.mocked(moveA11yFocus).mock.calls[1]?.[0]?.current).toBeTruthy();
  });

  it('re-focuses the title when the reader is reopened before the dismissal reports', () => {
    vi.mocked(useMarkdown).mockReturnValue([
      createElement('View', { testID: 'body-cells' }, 'cells'),
    ]);
    const renderer = renderTable();
    openTable(renderer);
    layoutTitle(renderer);
    expect(moveA11yFocus).toHaveBeenCalledTimes(1);

    act(() => {
      (closeNode(renderer).props.onPress as (() => void) | undefined)?.();
    });
    expect(findSheets(renderer.root)[0]?.props.index).toBe(-1);
    vi.mocked(moveA11yFocus).mockClear();

    // The reopen is deferred until the native dismissal reports (re-presenting
    // mid-transition leaves the sheet gone), but the title never unmounted, so
    // it takes focus again.
    openTable(renderer);
    expect(findSheets(renderer.root)[0]?.props.index).toBe(-1);
    expect(moveA11yFocus).toHaveBeenCalledTimes(1);
    expect(vi.mocked(moveA11yFocus).mock.calls[0]?.[0]?.current).toBeTruthy();
    vi.mocked(moveA11yFocus).mockClear();

    // The dismissal report re-presents the reader instead of closing it, and
    // does not move focus again.
    act(() => {
      (findSheets(renderer.root)[0]?.props.onDismiss as (() => void) | undefined)?.();
    });
    expect(findSheets(renderer.root)[0]?.props.index).toBe(0);
    expect(moveA11yFocus).not.toHaveBeenCalled();
  });
});

describe('MarkdownTableBodyRenderer table()', () => {
  it('returns null for a header with no rows', () => {
    const renderer = new MarkdownTableBodyRenderer(mockPalette, 200, 1, true, {});
    expect(renderer.table([['A']], [], undefined, undefined, undefined)).toBeNull();
  });

  it('builds the header and body TableRow tree with headerTexts from extractNodeText', () => {
    const bodyRenderer = new MarkdownTableBodyRenderer(mockPalette, 200, 1, true, {});
    const element = bodyRenderer.table(
      [['Column 1']],
      [[['Row 1']]],
      undefined,
      undefined,
      undefined
    );

    const renderer = renderTableElement(element);
    const tableRows = memoTableRows(renderer);
    expect(tableRows).toHaveLength(2);
    expect(tableRows[0]?.props.headerTexts).toEqual(['Column 1']);
    expect(tableRows[0]?.props.isHeader).toBe(true);
    expect(tableRows[0]?.props.columnWidth).toBe(200);
    expect(tableRows[1]?.props.isHeader).toBeUndefined();
    expect(tableRows[1]?.props.cells).toEqual([['Row 1']]);
    expect(tableRows[1]?.props.isLastRow).toBe(true);
  });

  it('caps the mounted rows at the limit', () => {
    const bodyRenderer = new MarkdownTableBodyRenderer(mockPalette, 200, 1, true, {});
    const rows = Array.from(
      { length: TABLE_ROW_MOUNT_LIMIT + TABLE_ROW_MOUNT_STEP + 5 },
      (_, index) => [[`Row ${index}`]]
    );
    const renderer = renderTableElement(
      bodyRenderer.table([['Column 1']], rows, undefined, undefined, undefined)
    );

    // Header plus exactly the mount limit; every other row stays unmounted.
    const mounted = memoTableRows(renderer);
    expect(mounted).toHaveLength(1 + TABLE_ROW_MOUNT_LIMIT);
    expect(mounted[0]?.props.isHeader).toBe(true);
    // A capped table marks no body row as last, so the final visible row keeps
    // its bottom border and the box bottom closes the table.
    expect(mounted[TABLE_ROW_MOUNT_LIMIT]?.props.isLastRow).toBe(false);
  });
});

describe('MarkdownTable capped reveal control', () => {
  function renderCappedTable(): TestRenderer.ReactTestRenderer {
    const rows = Array.from(
      { length: TABLE_ROW_MOUNT_LIMIT + TABLE_ROW_MOUNT_STEP + 5 },
      (_, index) => [[`Row ${index}`]]
    );
    const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
    act(() => {
      ref.current = TestRenderer.create(
        createElement(MarkdownTable, {
          palette: mockPalette,
          tableKey: 'md-table-0',
          columnCount: 1,
          rowCount: rows.length,
          selectable: true,
          header: [['Column 1']],
          rows,
        })
      );
    });
    const renderer = ref.current;
    if (!renderer) {
      throw new Error('renderer was not created');
    }
    openTable(renderer);
    return renderer;
  }

  it('keeps the Load more control out of the horizontal scroll region', () => {
    const renderer = renderCappedTable();
    const horizontal = renderer.root.findAll(
      node => (node.type as string) === 'ScrollView' && node.props.horizontal === true
    );
    expect(horizontal).toHaveLength(1);
    expect(
      horizontal[0]?.findAll(node => node.props.accessibilityLabel === 'Load more')
    ).toHaveLength(0);
    expect(loadMoreNode(renderer)).toBeTruthy();
  });

  it('reveals one more step of rows per Load more press', () => {
    const renderer = renderCappedTable();
    expect(memoTableRows(renderer)).toHaveLength(1 + TABLE_ROW_MOUNT_LIMIT);

    act(() => {
      (loadMoreNode(renderer).props.onPress as (() => void) | undefined)?.();
    });

    expect(memoTableRows(renderer)).toHaveLength(1 + TABLE_ROW_MOUNT_LIMIT + TABLE_ROW_MOUNT_STEP);
    expect(loadMoreNode(renderer)).toBeTruthy();
  });
});

describe('MarkdownTable close button', () => {
  it('does not render a Close control while closed', () => {
    const renderer = renderTable();
    expect(
      renderer.root.findAll(
        node =>
          typeof node.type === 'string' &&
          (node.type as string) === 'Pressable' &&
          node.props.accessibilityLabel === 'Close table'
      )
    ).toHaveLength(0);
  });
});

describe('MarkdownTable table semantics', () => {
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
      'Name: John and Age: 30'
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

  it('builds the row label from a nested control accessibility label', () => {
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
    const labelElement = findFirst(element, isAccessibleLabelElement);

    expect(labelElement).not.toBeNull();
    expect(accessibilityLabelOf(labelElement)).toBe('Docs: Open docs');
  });

  it('sheet title is a header and takes focus when it lays out', () => {
    vi.mocked(useMarkdown).mockReturnValue([
      createElement('View', { testID: 'body-cells' }, 'cells'),
    ]);
    const renderer = renderTable();
    expect(moveA11yFocus).not.toHaveBeenCalled();
    openTable(renderer);

    expect(titleNode(renderer).props.children).toBe('Table');
    expect(findSheets(renderer.root)).toHaveLength(1);
    expect(moveA11yFocus).not.toHaveBeenCalled();

    layoutTitle(renderer);
    expect(moveA11yFocus).toHaveBeenCalledTimes(1);
    expect(vi.mocked(moveA11yFocus).mock.calls[0]?.[0]?.current).toBeTruthy();
  });
});

describe('MarkdownTable eager body (nested table fallback)', () => {
  it('renders the provided cell trees and never re-parses raw', () => {
    const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
      current: undefined,
    };
    act(() => {
      rendererRef.current = TestRenderer.create(
        createElement(MarkdownTable, {
          palette: mockPalette,
          tableKey: 'md-table-0',
          columnCount: 1,
          rowCount: 1,
          selectable: true,
          header: [['Column 1']],
          rows: [[['Row 1']]],
        })
      );
    });
    const renderer = rendererRef.current;
    if (!renderer) {
      throw new Error('renderer was not created');
    }
    expect(chipNode(renderer)).toBeTruthy();
    expect(useMarkdown).not.toHaveBeenCalled();
    openTable(renderer);
    // The eager path renders TableRow directly; it never calls useMarkdown.
    expect(useMarkdown).not.toHaveBeenCalled();
    expect(renderer.root.findAll(isRenderedTableRow)).toHaveLength(2);
  });
});

function tableMarkdown(rows: string[]): string {
  return rows.map(row => `| Name |\n| --- |\n| ${row} |`).join('\n\n');
}

describe('MarkdownTable streaming and press paths (real parser)', () => {
  // Every other suite mocks useMarkdown and asserts its return value, so a
  // cell link built by a regression to the library Renderer (Linking.openURL,
  // no host confirm) would still pass. This suite un-mocks react-native-marked
  // and re-imports the component graph so the real Parser builds the cell tree
  // through MarkdownTableBodyRenderer, whose link press must run the confirm
  // helper and never Linking.openURL.
  beforeEach(() => {
    vi.doUnmock('react-native-marked');
    vi.resetModules();
  });

  it.each([
    {
      change: 'inserts a preceding table',
      before: ['Earlier', 'Target'],
      after: ['New', 'Earlier', 'Target'],
    },
    { change: 'removes a preceding table', before: ['Earlier', 'Target'], after: ['Target'] },
    {
      change: 'replaces a preceding table',
      before: ['Earlier', 'Target'],
      after: ['New', 'Target'],
    },
    {
      change: 'inserts a table with the same prefix',
      before: ['Earlier', 'Target'],
      after: ['Target |\n| More', 'Earlier', 'Target'],
    },
    {
      change: 'streams rows while inserting a preceding table',
      before: ['Earlier', 'Target'],
      after: ['New', 'Earlier', 'Target |\n| More'],
    },
    {
      change: 'streams rows while removing a preceding table',
      before: ['Earlier', 'Target'],
      after: ['Target |\n| More'],
    },
    {
      change: 'appends a copy after extending the open table',
      before: ['Target'],
      after: ['Target |\n| More', 'Target'],
      afterIndex: 0,
    },
  ])(
    'keeps the same sheet and table when streaming $change',
    async ({ before, after, afterIndex = -1 }) => {
      const { MarkdownText } = await import('./markdown-text');
      const { MarkdownTable: Table } = await import('./markdown-table');
      const renderer = renderTable();
      try {
        act(() => {
          renderer.update(createElement(MarkdownText, { value: tableMarkdown(before) }));
        });
        const table = renderer.root
          .findAllByType(Table)
          .find(
            node => (node.props.raw as string).trimEnd() === tableMarkdown([before.at(-1) ?? ''])
          );
        if (!table) {
          throw new Error('target table missing');
        }
        act(() => {
          (table.findByProps({ testID: table.props.tableKey }).props.onPress as () => void)();
        });
        const sheet = findSheets(table)[0];
        expect(sheet).toBeTruthy();

        for (const [rows, index] of [
          [after, afterIndex],
          [before, -1],
        ] as const) {
          act(() => {
            renderer.update(createElement(MarkdownText, { value: tableMarkdown(rows) }));
          });

          const updated = renderer.root
            .findAllByType(Table)
            .find(
              node => (node.props.raw as string).trimEnd() === tableMarkdown([rows.at(index) ?? ''])
            );
          expect(updated).toBe(table);
          expect(findSheets(updated)[0]).toBe(sheet);
          expect(findSheets(renderer.root)).toHaveLength(1);
        }
      } finally {
        act(() => {
          renderer.unmount();
        });
      }
    }
  );

  it('ignores a foreign value-only split so a streamed table keeps its key', async () => {
    const { MarkdownText } = await import('./markdown-text');
    const { MarkdownTable: Table } = await import('./markdown-table');
    const { markdownTableSegmentsCache } = await import('./markdown-parse-cache');
    const { splitMarkdownTables } = await import('./markdown-table-extract');
    const stale = '| Name |\n| --- |\n| Old |';
    const appended = '| Name |\n| --- |\n| New |';
    const next = `${appended}\n\n${stale}`;
    const renderer = renderTable();
    try {
      act(() => {
        renderer.update(createElement(MarkdownText, { value: stale }));
      });
      const table = renderer.root.findAllByType(Table)[0];
      if (!table) {
        throw new Error('table missing');
      }
      act(() => {
        (table.findByProps({ testID: table.props.tableKey }).props.onPress as () => void)();
      });
      expect(findSheets(table)).toHaveLength(1);

      // Another instance already cached a no-previous split of the next value.
      // Reusing it would give the appended table key `md-table-0`, the key the
      // open `stale` table holds, and reconcile its modal onto the new table.
      markdownTableSegmentsCache.set(next, splitMarkdownTables(next));

      act(() => {
        renderer.update(createElement(MarkdownText, { value: next }));
      });

      const staleTable = renderer.root
        .findAllByType(Table)
        .find(node => (node.props.raw as string).trimEnd() === stale);
      expect(staleTable).toBe(table);
      expect(findSheets(staleTable)).toHaveLength(1);
    } finally {
      act(() => {
        renderer.unmount();
      });
    }
  });

  it('does not move an open sheet to the next table when its table is removed', async () => {
    const { MarkdownText } = await import('./markdown-text');
    const { MarkdownTable: Table } = await import('./markdown-table');
    const remaining = '| Name |\n| --- |\n| Remaining |';
    const renderer = renderTable();
    try {
      act(() => {
        renderer.update(
          createElement(MarkdownText, { value: `| Name |\n| --- |\n| Removed |\n\n${remaining}` })
        );
      });
      const table = renderer.root.findAllByType(Table)[0];
      if (!table) {
        throw new Error('first table missing');
      }
      act(() => {
        (table.findByProps({ testID: table.props.tableKey }).props.onPress as () => void)();
      });
      expect(findSheets(renderer.root)).toHaveLength(1);

      act(() => {
        renderer.update(createElement(MarkdownText, { value: remaining }));
      });

      expect(findSheets(renderer.root)).toHaveLength(0);
    } finally {
      act(() => {
        renderer.unmount();
      });
    }
  });

  it('keeps the cap reveal control out of the horizontal scroll region for a raw table', async () => {
    const { MarkdownText } = await import('./markdown-text');
    const tableModule = await import('./markdown-table');
    const bodyRows = Array.from(
      { length: TABLE_ROW_MOUNT_LIMIT + 5 },
      (_, index) => `| Row ${index} |`
    );
    const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
    await act(async () => {
      await Promise.resolve();
      ref.current = TestRenderer.create(
        createElement(MarkdownText, { value: `| Name |\n| --- |\n${bodyRows.join('\n')}` })
      );
    });
    const renderer = ref.current;
    if (!renderer) {
      throw new Error('renderer was not created');
    }

    try {
      openTable(renderer);

      const mountedRows = renderer.root.findAll(
        node => node.type === tableModule.MemoTableRow || node.type === tableModule.TableRow
      );
      expect(mountedRows).toHaveLength(1 + TABLE_ROW_MOUNT_LIMIT);

      const horizontal = renderer.root.findAll(
        node => (node.type as string) === 'ScrollView' && node.props.horizontal === true
      );
      expect(horizontal).toHaveLength(1);
      expect(
        horizontal[0]?.findAll(node => node.props.accessibilityLabel === 'Load more')
      ).toHaveLength(0);
      expect(
        renderer.root.findAll(node => node.props.accessibilityLabel === 'Load more')
      ).toHaveLength(1);
    } finally {
      act(() => {
        renderer.unmount();
      });
    }
  });

  it('a cell link press runs the confirm handler, never Linking.openURL', async () => {
    const tableModule = await import('./markdown-table');
    const { confirmAndOpenMarkdownLink } = await import('./markdown-link-confirm');
    const confirm = vi.mocked(confirmAndOpenMarkdownLink);
    confirm.mockClear();
    linkingOpenURL.mockClear();

    const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
      current: undefined,
    };
    await act(async () => {
      await Promise.resolve();
      rendererRef.current = TestRenderer.create(
        createElement(tableModule.MarkdownTable, {
          ...defaultProps,
          raw: '| Link |\n| --- |\n| [link](https://example.com) |',
        })
      );
    });
    const renderer = rendererRef.current;
    if (!renderer) {
      throw new Error('renderer was not created');
    }

    openTable(renderer);

    const links = renderer.root.findAll(
      node => node.props.accessibilityRole === 'link' && typeof node.props.onPress === 'function'
    );
    expect(links.length).toBeGreaterThan(0);

    act(() => {
      (links[0]?.props.onPress as (() => void) | undefined)?.();
    });

    expect(confirm).toHaveBeenCalledWith('https://example.com', { label: 'link' });
    expect(linkingOpenURL).not.toHaveBeenCalled();

    await act(async () => {
      await Promise.resolve();
      renderer.unmount();
    });
  });

  it('threads the MarkdownText onCopyCode handler down to the code fence', async () => {
    const { MarkdownText } = await import('./markdown-text');
    const onCopyCode = vi.fn<(code: string) => void>();
    const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
      current: undefined,
    };
    await act(async () => {
      await Promise.resolve();
      rendererRef.current = TestRenderer.create(
        createElement(MarkdownText, { value: '```ts\nconst x = 1;\n```', onCopyCode })
      );
    });
    const renderer = rendererRef.current;
    if (!renderer) {
      throw new Error('renderer was not created');
    }

    const blocks = renderer.root.findAll(node => (node.type as unknown) === 'CodeBlock');
    expect(blocks).toHaveLength(1);
    const copyCode = blocks[0]?.props.onCopyCode as ((code: string) => void) | undefined;
    expect(copyCode).toBeTypeOf('function');
    copyCode?.('const x = 1;');
    expect(onCopyCode).toHaveBeenCalledWith('const x = 1;');

    await act(async () => {
      await Promise.resolve();
      renderer.unmount();
    });
  });

  it('leaves the code fence static without an onCopyCode handler', async () => {
    const { MarkdownText } = await import('./markdown-text');
    const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
      current: undefined,
    };
    await act(async () => {
      await Promise.resolve();
      rendererRef.current = TestRenderer.create(
        createElement(MarkdownText, { value: '```ts\nconst x = 1;\n```' })
      );
    });
    const renderer = rendererRef.current;
    if (!renderer) {
      throw new Error('renderer was not created');
    }

    const blocks = renderer.root.findAll(node => (node.type as unknown) === 'CodeBlock');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.props.onCopyCode).toBeUndefined();

    await act(async () => {
      await Promise.resolve();
      renderer.unmount();
    });
  });

  it('threads the MarkdownText onLongPressCode handler down to the code fence', async () => {
    const { MarkdownText } = await import('./markdown-text');
    const onCopyCode = vi.fn<(code: string) => void>();
    const onLongPressCode = vi.fn<() => void>();
    const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
      current: undefined,
    };
    await act(async () => {
      await Promise.resolve();
      rendererRef.current = TestRenderer.create(
        createElement(MarkdownText, {
          value: '```ts\nconst x = 1;\n```',
          onCopyCode,
          onLongPressCode,
        })
      );
    });
    const renderer = rendererRef.current;
    if (!renderer) {
      throw new Error('renderer was not created');
    }

    const blocks = renderer.root.findAll(node => (node.type as unknown) === 'CodeBlock');
    expect(blocks).toHaveLength(1);
    const longPressCode = blocks[0]?.props.onLongPressCode as (() => void) | undefined;
    expect(longPressCode).toBeTypeOf('function');
    longPressCode?.();
    expect(onLongPressCode).toHaveBeenCalledTimes(1);

    await act(async () => {
      await Promise.resolve();
      renderer.unmount();
    });
  });
});
