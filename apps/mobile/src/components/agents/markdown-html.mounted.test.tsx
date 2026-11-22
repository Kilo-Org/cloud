/* eslint-disable max-classes-per-file, max-lines, typescript-eslint/no-extraneous-class, typescript-eslint/no-unnecessary-condition, eslint/class-methods-use-this, eslint/no-empty-function, eslint-plugin-promise/prefer-await-to-callbacks, eslint-plugin-promise/prefer-await-to-then, typescript-eslint/promise-function-async -- the react-native host stub must mimic the module surface the real @native-html/render engine consumes (classes with no-op methods, promise-returning Linking shims); test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx); one suite covers routing, styling, the image fallback, details, and block direction against one engine harness */
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { MarkdownHtml, splitMarkdownHtml } from './markdown-html';
import { type MarkdownPalette } from './markdown-palette';

// A host-element stub is the only way to run the real @native-html/render
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
  // (vi.hoisted factories run above hoisted ESM imports); @native-html/render
  // requires react-native outside the ESM graph.
  const NodeModule = process.getBuiltinModule('module') as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = NodeModule._load.bind(NodeModule);
  NodeModule._load = (request, parent, isMain) =>
    request === 'react-native' ? stub : originalLoad(request, parent, isMain);
  return stub;
});

vi.mock('react-native', () => rnStub);
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/components/ui/directional-icons', () => ({
  DirectionalChevronRight: 'DirectionalChevronRight',
}));
vi.mock('@/components/ui/icons', () => ({
  ChevronDown: 'ChevronDown',
  ChevronUp: 'ChevronUp',
}));
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
  codeSurface: '#eeeeee',
  diagramSurface: '#eeeeee',
  borderColor: '#cccccc',
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

/** One merged style object from the entries the engine passed to a host node. */
function mergedStyle(style: unknown): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const entry of flattenStyle(style)) {
    Object.assign(merged, entry);
  }
  return merged;
}

async function mountHtml(
  html: string,
  documentDirection?: 'ltr'
): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(
      createElement(MarkdownHtml, { html, palette, documentDirection, selectable: true })
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

/** Every host node of one type, with its merged style and the tag it came from. */
function hostStyles(renderer: TestRenderer.ReactTestRenderer, type: 'View' | 'Text') {
  return renderer.root
    .findAll(node => typeof node.type === 'string' && (node.type as string) === type)
    .map(node => ({
      tag: typeof node.props.testID === 'string' ? node.props.testID : undefined,
      style: mergedStyle(node.props.style),
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

describe('MarkdownHtml unsupported-image fallback', () => {
  it('renders the alt text through the raw Text with the palette base style', async () => {
    const renderer = await mountHtml('<img src="ftp://example.com/photo.png" alt="A photo">');
    const fallback = styledTexts(renderer).find(entry => entry.text === 'A photo');

    expect(fallback).toBeDefined();
    const style: Record<string, unknown> = Object.assign({}, ...(fallback?.style ?? []));
    expect(style).toMatchObject({ color: '#111111', fontSize: 16, lineHeight: 24 });
  });

  it('gives the fallback its own direction from the alt text, not the interface', async () => {
    const isRtl = rnStub.I18nManager;
    isRtl.isRTL = true;
    try {
      const latin = await mountHtml('<img src="ftp://example.com/a.png" alt="A photo">');
      const latinStyle = styledTexts(latin).find(entry => entry.text === 'A photo');
      expect(latinStyle).toBeDefined();
      // Interface stays right to left; the English alt keeps its own left edge.
      expect(mergedStyle(latinStyle?.style)).toMatchObject({
        direction: 'ltr',
        writingDirection: 'ltr',
      });

      const arabic = await mountHtml('<img src="ftp://example.com/a.png" alt="صورة">');
      const arabicStyle = styledTexts(arabic).find(entry => entry.text === 'صورة');
      expect(arabicStyle).toBeDefined();
      expect(mergedStyle(arabicStyle?.style)).toMatchObject({
        direction: 'rtl',
        writingDirection: 'rtl',
      });

      // A document body keeps its one direction whatever the alt says.
      const document = await mountHtml('<img src="ftp://example.com/a.png" alt="صورة">', 'ltr');
      const documentStyle = styledTexts(document).find(entry => entry.text === 'صورة');
      expect(mergedStyle(documentStyle?.style)).toMatchObject({
        direction: 'ltr',
        writingDirection: 'ltr',
      });
    } finally {
      isRtl.isRTL = false;
    }
  });
});

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return styledTexts(renderer)
    .map(entry => entry.text)
    .join('');
}

describe('MarkdownHtml details', () => {
  /** Republishes one HTML source through the mounted renderer, settled. */
  async function republish(renderer: TestRenderer.ReactTestRenderer, html: string): Promise<void> {
    await act(async () => {
      renderer.update(createElement(MarkdownHtml, { html, palette, selectable: true }));
      await Promise.resolve();
    });
  }

  it('starts collapsed and expands its body when the summary row is pressed', async () => {
    const renderer = await mountHtml(
      '<details><summary>More <b>info</b></summary><p>Hidden body</p></details>'
    );
    const row = renderer.root.findByType('Pressable' as never);

    expect(row.props.accessibilityRole).toBe('button');
    expect(row.props.accessibilityState).toEqual({ expanded: false });
    expect(renderer.root.findAllByType('ChevronDown' as never)).toHaveLength(1);
    expect(allText(renderer)).toContain('More info');
    expect(allText(renderer)).not.toContain('Hidden body');

    await act(async () => {
      (row.props.onPress as () => void)();
      await Promise.resolve();
    });

    expect(renderer.root.findByType('Pressable' as never).props.accessibilityState).toEqual({
      expanded: true,
    });
    expect(renderer.root.findAllByType('ChevronUp' as never)).toHaveLength(1);
    expect(allText(renderer)).toContain('Hidden body');
  });

  it('starts open with the open attribute and labels a details element with no summary', async () => {
    const renderer = await mountHtml('<details open><p>Visible body</p></details>');

    expect(allText(renderer)).toContain('common.details');
    expect(allText(renderer)).toContain('Visible body');
  });

  it('re-syncs the expanded state when the node\u2019s open attribute arrives in a streaming publish', async () => {
    const renderer = await mountHtml(
      '<details><summary>More</summary><p>Hidden body</p></details>'
    );
    const row = renderer.root.findByType('Pressable' as never);

    expect(row.props.accessibilityState).toEqual({ expanded: false });
    expect(allText(renderer)).not.toContain('Hidden body');

    await republish(renderer, '<details open><summary>More</summary><p>Hidden body</p></details>');

    expect(renderer.root.findByType('Pressable' as never).props.accessibilityState).toEqual({
      expanded: true,
    });
    expect(allText(renderer)).toContain('Hidden body');
  });

  it('keeps a reader expansion across streaming publishes of the same source', async () => {
    const renderer = await mountHtml(
      '<details><summary>More</summary><p>Hidden body</p></details>'
    );
    const row = renderer.root.findByType('Pressable' as never);
    await act(async () => {
      (row.props.onPress as () => void)();
      await Promise.resolve();
    });

    expect(row.props.accessibilityState).toEqual({ expanded: true });

    // A later publish re-parses the same source into a new node without the
    // `open` attribute; the reader's own expansion is not the attribute's
    // state, so it must survive.
    await republish(renderer, '<details><summary>More</summary><p>Hidden body</p></details>');

    expect(renderer.root.findByType('Pressable' as never).props.accessibilityState).toEqual({
      expanded: true,
    });
    expect(allText(renderer)).toContain('Hidden body');
  });
});

describe('MarkdownHtml unknown tags', () => {
  it('renders an unknown tag as inline text, as a browser does', async () => {
    const renderer = await mountHtml(
      '<p>An unknown tag: <custom-note>stays HTML</custom-note>.</p>'
    );

    expect(allText(renderer)).toContain('An unknown tag: stays HTML.');
  });

  it('drops a direction class the content wrote on an unknown tag it renames', async () => {
    const renderer = await mountHtml(
      '<p>Latin text <custom-note class="kilo-block-rtl">and more</custom-note> here.</p>'
    );
    const texts = hostStyles(renderer, 'Text');

    // The visitor renames the unknown tag to `span` and returns early, so the
    // strip that drops content-written direction classes runs before that
    // branch: the paragraph keeps the direction its own text names and no run
    // inside it is flipped by a class the content wrote.
    expect(texts.some(entry => entry.style.writingDirection === 'rtl')).toBe(false);
    expect(texts.every(entry => entry.style.direction !== 'rtl')).toBe(true);
  });
});

// These elements reach the HTML renderer only when markdown cannot express
// them (the converter turns plain keys and script text into markdown first).
describe('MarkdownHtml inline keys, subscripts, and superscripts', () => {
  it('draws kbd as code-colored text on the line', async () => {
    const renderer = await mountHtml('<p>Press <kbd>Ctrl</kbd>+<kbd>C</kbd></p>');
    const keys = styledTexts(renderer).filter(entry => entry.text === 'Ctrl' || entry.text === 'C');

    expect(keys).toHaveLength(2);
    expect(
      keys.every(entry => entry.style.some(style => style.backgroundColor === '#eeeeee'))
    ).toBe(true);
  });

  it('draws sub and sup smaller than the text around them', async () => {
    const renderer = await mountHtml('<p>H<sub>2</sub>O and x<sup>2</sup></p>');
    const two = styledTexts(renderer).filter(entry => entry.text === '2');
    expect(two).toHaveLength(2);
    expect(two.every(entry => entry.style.some(style => style.fontSize === 11))).toBe(true);
  });
});

describe('MarkdownHtml block direction', () => {
  it('gives each block the direction of its own first strong character', async () => {
    const isRtl = rnStub.I18nManager;
    isRtl.isRTL = true;
    try {
      const renderer = await mountHtml(
        '<p><del>struck</del> and <sub>low</sub> <sup>high</sup></p><p>مرحبا</p>'
      );
      const paragraphs = hostStyles(renderer, 'View').filter(entry => entry.tag === 'p');
      const texts = hostStyles(renderer, 'Text');

      expect(paragraphs).toHaveLength(2);
      // The Latin block names left to right, so its paragraph resolves to its
      // own left edge inside a right-to-left interface instead of the
      // interface's start edge.
      expect(paragraphs[0]?.style).toMatchObject({ direction: 'ltr' });
      expect(texts.find(entry => entry.style.fontSize === 16)?.style).toMatchObject({
        direction: 'ltr',
        writingDirection: 'ltr',
      });
      // The Arabic block names right to left, in the same body and the same
      // interface.
      expect(paragraphs[1]?.style).toMatchObject({ direction: 'rtl' });
      expect(texts.find(entry => entry.style.writingDirection === 'rtl')?.style).toMatchObject({
        direction: 'rtl',
      });
      expect(texts.some(entry => entry.style.writingDirection === 'ltr')).toBe(true);
    } finally {
      isRtl.isRTL = false;
    }
  });

  it('replaces a content-written direction class with the computed one', async () => {
    const renderer = await mountHtml(
      '<p class="kilo-block-rtl">Alpha beta</p>' +
        '<blockquote class="kilo-block-ltr"><p>بيتا</p></blockquote>'
    );
    const blocks = hostStyles(renderer, 'View');
    const paragraphs = blocks.filter(entry => entry.tag === 'p');

    // The content's own class names the wrong direction for both elements: a
    // block's class is recomputed from its own text, a container's is dropped.
    expect(paragraphs.map(entry => entry.style.direction)).toEqual(['ltr', 'rtl']);
    expect(blocks.find(entry => entry.tag === 'blockquote')?.style).not.toHaveProperty('direction');
  });

  it('gives one block per element, not one direction for a merged input', async () => {
    const renderer = await mountHtml('<p>alpha</p><p>بيتا</p><h2>gamma</h2>');
    const blocks = hostStyles(renderer, 'View').filter(entry =>
      ['p', 'h2'].includes(entry.tag ?? '')
    );

    expect(blocks.map(entry => entry.style.direction)).toEqual(['ltr', 'rtl', 'ltr']);
    const texts = hostStyles(renderer, 'Text');
    expect(texts.some(entry => entry.style.direction === 'rtl')).toBe(true);
    expect(texts.some(entry => entry.style.direction === 'ltr')).toBe(true);
  });

  it('names nothing for a block whose text has no letter', async () => {
    const renderer = await mountHtml('<p>42 — 7</p>');
    const paragraph = hostStyles(renderer, 'View').find(entry => entry.tag === 'p');

    expect(paragraph).toBeDefined();
    expect(paragraph?.style).not.toHaveProperty('direction');
    const text = hostStyles(renderer, 'Text').find(entry => entry.style.fontSize === 16);
    expect(text?.style).not.toHaveProperty('direction');
    expect(text?.style).not.toHaveProperty('writingDirection');
  });

  it('keeps one direction for a document body', async () => {
    const renderer = await mountHtml('<p>alpha</p><p>بيتا</p>', 'ltr');
    const paragraphs = hostStyles(renderer, 'View').filter(entry => entry.tag === 'p');

    expect(paragraphs).toHaveLength(2);
    for (const paragraph of paragraphs) {
      expect(paragraph.style).toMatchObject({ direction: 'ltr' });
    }
  });

  it('leaves a container of blocks unset and lets the blocks name their own', async () => {
    const renderer = await mountHtml(
      '<blockquote><p>quote</p><p>اقتباس</p></blockquote><details open>' +
        '<summary>More</summary><p>بيتا</p></details>'
    );
    const blocks = hostStyles(renderer, 'View');

    // A container draws no text of its own, so it names no direction: a
    // direction on its view would reorder the blocks inside it instead.
    expect(blocks.find(entry => entry.tag === 'blockquote')?.style).not.toHaveProperty('direction');
    const row = renderer.root.findByType('Pressable' as never);
    const wrapperStyle = mergedStyle(row.parent?.props.style);
    expect(wrapperStyle).not.toHaveProperty('direction');

    const directions = blocks
      .filter(entry => entry.tag === 'p')
      .map(entry => entry.style.direction);
    expect(directions).toEqual(['ltr', 'rtl', 'rtl']);
    const summaryText = styledTexts(renderer).find(entry => entry.text === 'More');
    expect(mergedStyle(summaryText?.style)).toMatchObject({ direction: 'ltr' });
  });
});
