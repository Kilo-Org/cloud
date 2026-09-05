/* eslint-disable max-classes-per-file, typescript-eslint/no-deprecated, typescript-eslint/no-extraneous-class, typescript-eslint/no-unnecessary-condition, eslint/class-methods-use-this, eslint/no-empty-function, eslint-plugin-promise/prefer-await-to-callbacks, eslint-plugin-promise/prefer-await-to-then, typescript-eslint/promise-function-async -- the react-native host stub must mimic the module surface the real react-native-render-html engine consumes (classes with no-op methods, promise-returning Linking shims); react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { MarkdownHtml, splitMarkdownHtml } from './markdown-html';
import { type MarkdownPalette } from './markdown-palette';

// A host-element stub is the only way to run the real react-native-render-html
// engine in the DOM-free node test env.
const rnStub = vi.hoisted(() => {
  const dim = { width: 375, height: 800, scale: 2, fontScale: 1 };
  const AnimatedValue = class {
    setValue() {}
    addListener() {
      return '1';
    }
    removeListener() {}
    interpolate(opts: unknown) {
      return opts;
    }
  };
  const stub = {
    View: 'View',
    Text: 'Text',
    Image: 'Image',
    Pressable: 'Pressable',
    TouchableHighlight: 'TouchableHighlight',
    TouchableNativeFeedback: {
      selectable: true,
      SelectableRipple: 'SelectableRipple',
    },
    ActivityIndicator: 'ActivityIndicator',
    Animated: {
      View: 'Animated.View',
      Text: 'Animated.Text',
      Value: AnimatedValue,
      timing: () => ({
        start: (cb?: unknown) => void (cb as { onFinish?: () => void })?.onFinish?.(),
      }),
      createAnimatedComponent: (C: unknown) => C,
    },
    Dimensions: { get: () => dim, addEventListener: () => ({ remove: () => {} }) },
    I18nManager: { isRTL: false },
    PixelRatio: {
      get: () => 2,
      getFontScale: () => 1,
      roundToNearestPixel: (n: number) => n,
      getPixelSizeForLayoutSize: (n: number) => n * 2,
    },
    Platform: {
      OS: 'ios',
      select: (values: { ios?: unknown; default?: unknown }) => values.ios ?? values.default,
    },
    StyleSheet: {
      create: (styles: Record<string, unknown>) => styles,
      flatten: (style: unknown) => style,
      hairlineWidth: 1,
      absoluteFill: { position: 'absolute' },
      absoluteFillObject: { position: 'absolute' },
      compose: (a: unknown, b: unknown) => [a, b],
    },
    Linking: { openURL: () => Promise.resolve(), canOpenURL: () => Promise.resolve(true) },
    Alert: { alert: () => {} },
    Touchable: { Mixin: {} },
    findNodeHandle: (c: unknown) => c,
    NativeModules: {},
    UIManager: {
      getViewManagerConfig: () => null,
      hasViewManagerConfig: () => false,
    },
    useColorScheme: () => 'light',
    useWindowDimensions: () => dim,
    processColor: (c: unknown) => c,
  };
  // Install the CJS require hook before any import in this file is evaluated
  // (vi.hoisted factories run above hoisted ESM imports); react-native-
  // render-html requires react-native outside the ESM graph.
  const NodeModule = process.getBuiltinModule('module') as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = NodeModule._load.bind(NodeModule);
  NodeModule._load = (request, parent, isMain) =>
    request === 'react-native' ? stub : originalLoad(request, parent, isMain);
  return stub;
});

vi.mock('react-native', () => rnStub);
// The library's index pulls react-native-svg; its lexer export is literally
// marked.lexer (see dist/commonjs/index.js), so this mock is behavior-identical.
vi.mock('react-native-marked', async () => {
  const { marked } = await import('marked');
  return {
    MarkedLexer: (value: string) => marked.lexer(value, { gfm: true }),
    useMarkdown: () => [],
    Renderer: class {},
  };
});
vi.mock('./markdown-image', () => ({ MarkdownImage: 'MarkdownImage' }));
vi.mock('./markdown-link-confirm', () => ({
  confirmAndOpenMarkdownLink: vi.fn(),
  formatLinkHost: (h: string) => h,
}));
vi.mock('./tool-card-attachments', () => ({
  resolveImagePreviewAspectRatio: () => 1,
}));

const palette: MarkdownPalette = {
  textColor: '#111111',
  mutedTextColor: '#666666',
  codeBackground: '#eeeeee',
  borderColor: '#cccccc',
  surfaceColor: '#ffffff',
};

function flattenStyle(style: unknown): Record<string, unknown>[] {
  if (style === null || style === undefined) {
    return [];
  }
  if (Array.isArray(style)) {
    return style.flatMap(entry => flattenStyle(entry));
  }
  return [style as Record<string, unknown>];
}

async function mountHtml(html: string): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(
      createElement(MarkdownHtml, { html, palette, selectable: true })
    );
  });
  if (!ref.current) {
    throw new Error('renderer was not created');
  }
  return ref.current;
}

function styledTexts(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAll(node => typeof node.type === 'string' && (node.type as string) === 'Text')
    .map(node => ({
      text: node.children.map(child => (typeof child === 'string' ? child : '')).join(''),
      style: flattenStyle(node.props.style),
    }));
}

describe('splitMarkdownHtml nested HTML routing', () => {
  it('routes a list whose items contain styled inline HTML to the HTML engine', () => {
    const segments = splitMarkdownHtml(
      '- Markdown: [example](https://example.com)\n- HTML: <a href="https://example.com">HTML link</a>'
    );

    expect(segments).toHaveLength(1);
    expect(segments[0]?.type).toBe('html');
    expect(segments[0]?.raw).toContain('<a href="https://example.com">HTML link</a>');
  });

  it('keeps a list without HTML and a list whose HTML is only unstyled tags on the Markdown path', () => {
    expect(splitMarkdownHtml('- one\n- two')).toEqual([{ type: 'markdown', raw: '- one\n- two' }]);
    expect(splitMarkdownHtml('- <div>plain</div>')).toEqual([
      { type: 'markdown', raw: '- <div>plain</div>' },
    ]);
  });

  it('keeps containers that hold fenced code or tables on the Markdown path', () => {
    const codeList =
      '- item <a href="https://example.com">HTML link</a>\n\n  ```js\n  const a = 1;\n  ```\n';
    expect(splitMarkdownHtml(codeList).every(segment => segment.type === 'markdown')).toBe(true);
    const quoteWithTable = '> | a |\n> | --- |\n> | <a href="https://example.com">HTML link</a> |';
    expect(splitMarkdownHtml(quoteWithTable).every(segment => segment.type === 'markdown')).toBe(
      true
    );
  });
});

describe('MarkdownHtml nested-list styling (real HTML engine)', () => {
  it('styles links, headings, and strong text inside a parsed list like their Markdown equivalents', async () => {
    const renderer = await mountHtml(
      '<ul>\n<li>Markdown: <a href="https://example.com">example</a></li>\n' +
        '<li>HTML: <a href="https://example.com">HTML link</a></li>\n' +
        '<li><strong>HTML strong</strong></li>\n</ul>'
    );
    const dump = styledTexts(renderer);

    const link = dump.find(entry => entry.text === 'HTML link');
    expect(link).toBeDefined();
    expect(link?.style.some(s => s.textDecorationLine === 'underline')).toBe(true);
    const strong = dump.find(entry => entry.text === 'HTML strong');
    expect(strong).toBeDefined();
    expect(strong?.style.some(s => s.fontWeight === '700')).toBe(true);
    // The tags themselves must not leak into the rendered text.
    expect(dump.some(entry => entry.text.includes('<a ') || entry.text.includes('<strong'))).toBe(
      false
    );
  });

  it('styles a heading nested in a parsed list', async () => {
    const renderer = await mountHtml('<ul>\n<li><h2>HTML heading</h2></li>\n</ul>');
    const heading = styledTexts(renderer).find(entry => entry.text === 'HTML heading');

    expect(heading).toBeDefined();
    expect(heading?.style.some(s => s.fontSize === 20 && s.fontWeight === '700')).toBe(true);
  });
});
