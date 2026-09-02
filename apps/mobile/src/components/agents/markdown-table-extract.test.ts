// eslint-disable-next-line import/no-nodejs-modules -- patching the CJS loader is the only way to stub react-native for the externalized react-native-marked; the library under test stays real
import Module from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// react-native-marked is externalized by vitest, so vi.mock('react-native') does
// not intercept its nested requires. Patch Module._load before loading the
// library (the dynamic imports below run after this top-level patch) so the
// real MarkedLexer (and marked) can construct under node.
const rnStub = {
  Text: 'Text',
  View: 'View',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  TouchableHighlight: 'TouchableHighlight',
  Image: 'Image',
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
    return rnStub;
  }
  if (request === 'react-native-svg') {
    return { default: 'Svg', Svg: 'Svg', Path: 'Path', G: 'G', Rect: 'Rect', Circle: 'Circle' };
  }
  return originalLoad(request, parent, isMain);
};

const VALUE = [
  'Some text before.',
  '',
  '| Name | Age |',
  '| --- | --- |',
  '| Alice | 30 |',
  '| Bob | 25 |',
  '',
  'More text.',
  '',
  '| City |',
  '| --- |',
  '| Paris |',
].join('\n');

async function loadSplitter() {
  const { splitMarkdownTables } = await import('./markdown-table-extract');
  return splitMarkdownTables;
}

describe('splitMarkdownTables', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns text and table segments in source order with ordinal keys', async () => {
    const splitMarkdownTables = await loadSplitter();
    const segments = splitMarkdownTables(VALUE);

    expect(segments).toHaveLength(4);
    expect(segments[0]).toMatchObject({
      type: 'markdown',
      raw: expect.stringContaining('Some text before.'),
    });
    expect(segments[1]).toMatchObject({
      type: 'table',
      key: 'md-table-0',
      columnCount: 2,
      rowCount: 2,
    });
    expect(segments[2]).toMatchObject({
      type: 'markdown',
      raw: expect.stringContaining('More text.'),
    });
    expect(segments[3]).toMatchObject({
      type: 'table',
      key: 'md-table-1',
      columnCount: 1,
      rowCount: 1,
    });
  });

  it('keeps no table pipe syntax in the markdown segments', async () => {
    const splitMarkdownTables = await loadSplitter();
    const segments = splitMarkdownTables(VALUE);

    const markdownSegments = segments.filter(segment => segment.type === 'markdown');
    expect(markdownSegments).toHaveLength(2);
    for (const segment of markdownSegments) {
      expect(segment.raw).not.toContain('| --- |');
      expect(segment.raw).not.toContain('| Name');
      expect(segment.raw).not.toContain('| Alice');
    }
    // The two markdown runs reassemble the non-table source.
    expect(markdownSegments.map(segment => segment.raw).join('')).toBe(
      'Some text before.\n\n\n\nMore text.\n\n'
    );
  });

  it('reports the header width as the column count', async () => {
    const splitMarkdownTables = await loadSplitter();
    const value = ['| A | B | C |', '| --- | --- | --- |', '| 1 | 2 | 3 |'].join('\n');
    const segments = splitMarkdownTables(value);

    const table = segments.find(segment => segment.type === 'table');
    expect(table).toMatchObject({ columnCount: 3, rowCount: 1 });
  });

  it('lexes the value exactly once', async () => {
    const splitMarkdownTables = await loadSplitter();
    const markedModule = await import('react-native-marked');
    const spy = vi.spyOn(markedModule, 'MarkedLexer');

    splitMarkdownTables(VALUE);

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it.each(['A', 'B'])(
    'does not transfer an invalidated table key to a new %s table',
    async header => {
      const splitMarkdownTables = await loadSplitter();
      const value = '| A |\n| --- |';
      const previous = { value, segments: splitMarkdownTables(value) };
      const next = splitMarkdownTables(`${value}x\n\n| ${header} |\n| --- |\n| new |`, previous);
      const oldTable = previous.segments.find(segment => segment.type === 'table');
      const newTable = next.find(segment => segment.type === 'table');

      expect(oldTable).toBeDefined();
      expect(newTable).toMatchObject({ columnCount: 1, rowCount: 1 });
      expect(newTable?.key).not.toBe(oldTable?.key);
    }
  );

  it('returns an empty array for table-free markdown', async () => {
    const splitMarkdownTables = await loadSplitter();
    expect(splitMarkdownTables('Just a paragraph.')).toEqual([
      { type: 'markdown', raw: 'Just a paragraph.' },
    ]);
  });
});
