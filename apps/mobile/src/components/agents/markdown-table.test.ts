/* eslint-disable max-lines -- Table semantics and modal tests share the direct-invocation tree-walk harness. */
/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount RN trees under vitest (same pattern as code-block.test.ts) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line import/no-nodejs-modules -- patching the CJS loader is the only way to stub react-native for the externalized react-native-marked; the library under test stays real
import Module from 'node:module';

import { moveA11yFocus } from '@/lib/a11y/announce';

import { MarkdownTable, MarkdownTableBodyRenderer, TableRow } from './markdown-table';

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

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  I18nManager: { isRTL: false },
  Modal: 'Modal',
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
vi.mock('@/components/ui/accessible-status', () => ({
  AccessibleStatus: 'AccessibleStatus',
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

beforeEach(() => {
  vi.mocked(useMarkdown).mockReset();
  vi.mocked(useMarkdown).mockReturnValue([]);
  vi.mocked(moveA11yFocus).mockClear();
});

describe('MarkdownTable closed tree', () => {
  it('renders the chip and no modal chrome when closed', () => {
    const renderer = renderTable();

    expect(chipNode(renderer)).toBeTruthy();
    expect(
      renderer.root.findAll(
        node => typeof node.type === 'string' && (node.type as string) === 'Modal'
      )
    ).toHaveLength(0);
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
  it('opens the modal and renders title, Close, then the parsed cells', () => {
    vi.mocked(useMarkdown).mockReturnValue([
      createElement('View', { testID: 'body-cells' }, 'cells'),
    ]);
    const renderer = renderTable();
    openTable(renderer);

    expect(
      renderer.root.findAll(
        node => typeof node.type === 'string' && (node.type as string) === 'Modal'
      )
    ).toHaveLength(1);
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

  it('keeps the modal open and re-parses when raw changes under the same key', () => {
    vi.mocked(useMarkdown).mockReturnValue([
      createElement('View', { testID: 'body-cells' }, 'cells'),
    ]);
    const renderer = renderTable();
    openTable(renderer);
    expect(
      renderer.root.findAll(
        node => typeof node.type === 'string' && (node.type as string) === 'Modal'
      )
    ).toHaveLength(1);

    act(() => {
      renderer.update(
        createElement(MarkdownTable, {
          ...defaultProps,
          raw: '| Column 2 |\n| --- |\n| Row 2 |',
        })
      );
    });

    expect(
      renderer.root.findAll(
        node => typeof node.type === 'string' && (node.type as string) === 'Modal'
      )
    ).toHaveLength(1);
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
    expect(closeNode(renderer)).toBeTruthy();
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
    expect(
      renderer.root.findAll(
        node => typeof node.type === 'string' && (node.type as string) === 'Modal'
      )
    ).toHaveLength(0);
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

  it('moves focus to the title on modal show', () => {
    vi.mocked(useMarkdown).mockReturnValue([
      createElement('View', { testID: 'body-cells' }, 'cells'),
    ]);
    const renderer = renderTable();
    openTable(renderer);

    const modal = renderer.root.findAll(
      node => typeof node.type === 'string' && (node.type as string) === 'Modal'
    )[0];
    expect(modal).toBeTruthy();
    expect(moveA11yFocus).not.toHaveBeenCalled();
    act(() => {
      (modal?.props.onShow as (() => void) | undefined)?.();
    });
    expect(moveA11yFocus).toHaveBeenCalled();
  });
});

describe('MarkdownTableBodyRenderer table()', () => {
  it('returns null for a header with no rows', () => {
    const renderer = new MarkdownTableBodyRenderer(mockPalette, 200, 1, true, {});
    expect(renderer.table([['A']], [], undefined, undefined, undefined)).toBeNull();
  });

  it('builds the header and body TableRow tree with headerTexts from extractNodeText', () => {
    const renderer = new MarkdownTableBodyRenderer(mockPalette, 200, 1, true, {});
    const element = renderer.table([['Column 1']], [[['Row 1']]], undefined, undefined, undefined);

    const tableRows = findAll(element, node => node.type === TableRow);
    expect(tableRows).toHaveLength(2);
    expect(tableRows[0]?.props.headerTexts).toEqual(['Column 1']);
    expect(tableRows[0]?.props.isHeader).toBe(true);
    expect(tableRows[0]?.props.columnWidth).toBe(200);
    expect(tableRows[1]?.props.isHeader).toBeUndefined();
    expect(tableRows[1]?.props.cells).toEqual([['Row 1']]);
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

  it('modal title is a header and onShow moves focus to it after presentation', () => {
    vi.mocked(useMarkdown).mockReturnValue([
      createElement('View', { testID: 'body-cells' }, 'cells'),
    ]);
    const renderer = renderTable();
    openTable(renderer);

    const title = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Text' &&
        node.props.accessibilityRole === 'header'
    );
    const modal = renderer.root.findAll(
      node => typeof node.type === 'string' && (node.type as string) === 'Modal'
    )[0];
    const onShow = modal?.props.onShow as (() => void) | undefined;

    expect(title[0]?.props.children).toBe('Table');
    expect(modal).toBeTruthy();
    expect(typeof onShow).toBe('function');
    expect(moveA11yFocus).not.toHaveBeenCalled();
    onShow?.();
    expect(moveA11yFocus).toHaveBeenCalled();
  });
});

describe('MarkdownTable cell inline press path (real parser)', () => {
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
});
