// eslint-disable-next-line import/no-nodejs-modules -- patching the CJS loader is the only way to stub react-native for the externalized react-native-marked; the library under test stays real
import Module from 'node:module';
import { type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { type MarkdownPalette } from './markdown-palette';
import { type MarkdownRenderer } from './markdown-renderer';

// react-native-marked is externalized by vitest, so vi.mock('react-native') does
// not intercept its nested requires. Patch Module._load before loading the
// library so the real Renderer (and github-slugger) can construct under node.
const rnStub = {
  Text: 'Text',
  View: 'View',
  ScrollView: 'ScrollView',
  TouchableHighlight: 'TouchableHighlight',
  Image: 'Image',
  StyleSheet: {
    create: (styles: Record<string, unknown>) => styles,
    hairlineWidth: 1,
    flatten: (style: unknown) => style,
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

vi.mock('react-native', () => rnStub);
vi.mock('react-native-svg', () => ({
  default: 'Svg',
  Svg: 'Svg',
  Path: 'Path',
  G: 'G',
  Rect: 'Rect',
  Circle: 'Circle',
}));
vi.mock('./markdown-table', () => ({
  MarkdownTable: 'MarkdownTable',
}));
vi.mock('./markdown-link', () => ({
  getLinkAccessibilityActions: () => [],
  getLinkLongPressHandler: () => undefined,
  LINK_ACCESSIBILITY_HINT: 'hint',
  resolveLinkAccessibilityLabel: () => 'label',
}));
vi.mock('@/lib/external-link', () => ({
  openExternalUrl: vi.fn(),
}));

const palette: MarkdownPalette = {
  textColor: '#111111',
  mutedTextColor: '#666666',
  codeBackground: '#f0f0f0',
  borderColor: '#cccccc',
  surfaceColor: '#ffffff',
};

const emptyStyle = undefined;

async function createRenderer() {
  const { MarkdownRenderer: RendererClass } = await import('./markdown-renderer');
  return new RendererClass(palette, true, {});
}

function keySequence(renderer: { getKey: () => string }, count: number): string[] {
  return Array.from({ length: count }, () => renderer.getKey());
}

function tableHostKey(
  renderer: MarkdownRenderer,
  header: ReactNode[][],
  rows: ReactNode[][][]
): string | null {
  const element = renderer.table(header, rows, emptyStyle, emptyStyle, emptyStyle) as ReactElement;
  return element.key ?? null;
}

describe('MarkdownRenderer key stability', () => {
  it('two fresh instances produce identical getKey() sequences', async () => {
    const a = await createRenderer();
    const b = await createRenderer();
    expect(keySequence(a, 8)).toEqual(keySequence(b, 8));
  });

  it('a reused instance produces different keys across identical call sequences', async () => {
    const renderer = await createRenderer();
    const first = keySequence(renderer, 5);
    const second = keySequence(renderer, 5);
    expect(first).not.toEqual(second);
  });

  it('table hosts are keyed ordinally in call order', async () => {
    const renderer = await createRenderer();
    const header: ReactNode[][] = [['H']];
    const rows: ReactNode[][][] = [[['r1']]];
    expect(tableHostKey(renderer, header, rows)).toBe('md-table-0');
    expect(tableHostKey(renderer, header, rows)).toBe('md-table-1');
    expect(tableHostKey(renderer, header, rows)).toBe('md-table-2');
  });

  it('table host key is independent of preceding getKey() consumption', async () => {
    const a = await createRenderer();
    const b = await createRenderer();
    keySequence(a, 2);
    keySequence(b, 11);
    const header: ReactNode[][] = [['H']];
    const rows: ReactNode[][][] = [[['r1']]];
    expect(tableHostKey(a, header, rows)).toBe('md-table-0');
    expect(tableHostKey(b, header, rows)).toBe('md-table-0');
  });

  it('table host key is independent of row/cell counts', async () => {
    const a = await createRenderer();
    const b = await createRenderer();
    const smallHeader: ReactNode[][] = [['A']];
    const smallRows: ReactNode[][][] = [[['1']]];
    const largeHeader: ReactNode[][] = [['A', 'B', 'C']];
    const largeRows: ReactNode[][][] = [[['1', '2', '3']], [['4', '5', '6']], [['7', '8', '9']]];
    expect(tableHostKey(a, smallHeader, smallRows)).toBe('md-table-0');
    expect(tableHostKey(b, largeHeader, largeRows)).toBe('md-table-0');
  });
});
