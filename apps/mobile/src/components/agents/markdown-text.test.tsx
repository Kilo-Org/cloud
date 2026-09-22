/* eslint-disable max-lines -- the HTML routing, sanitization, and interaction tests share one React Native module mock harness */
// eslint-disable-next-line import/no-nodejs-modules -- the real HTML engine needs a React Native stub in the node test environment
import Module from 'node:module';
import { type ComponentType, createElement, type ReactElement } from 'react';
import { type GestureResponderEvent } from 'react-native';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MarkedLexer, useMarkdown } from 'react-native-marked';
import type * as RenderHtmlExports from 'react-native-render-html';
import {
  type CustomTagRendererRecord,
  type DomVisitorCallbacks,
  type RenderersProps,
  type TNode,
} from 'react-native-render-html';

import {
  type MarkdownHtmlSnapshot,
  splitMarkdownHtml,
  splitMarkdownHtmlIncremental,
} from './markdown-html';
import { confirmAndOpenMarkdownLink } from './markdown-link-confirm';
import { MarkdownRenderer } from './markdown-renderer';
import { MarkdownText } from './markdown-text';

const rnStub = vi.hoisted(() => ({
  View: 'View',
  Text: 'Text',
  Image: 'Image',
  TouchableHighlight: 'TouchableHighlight',
  TouchableNativeFeedback: 'TouchableNativeFeedback',
  Dimensions: { get: () => ({ width: 320, height: 640, scale: 2, fontScale: 1 }) },
  I18nManager: { isRTL: false },
  PixelRatio: { get: () => 2 },
  Platform: { OS: 'ios', select: (values: { ios?: unknown; default?: unknown }) => values.ios },
  StyleSheet: {
    create: (styles: Record<string, unknown>) => styles,
    flatten: (style: unknown) => style,
    hairlineWidth: 1,
  },
  useColorScheme: () => 'light',
  useWindowDimensions: () => ({ width: 320, height: 640, scale: 2, fontScale: 1 }),
}));
type CjsLoad = (request: string, parent: NodeJS.Module | null, isMain: boolean) => unknown;
const ModuleWithLoad = Module as unknown as { _load: CjsLoad };
const originalLoad = ModuleWithLoad._load.bind(ModuleWithLoad);
ModuleWithLoad._load = (request, parent, isMain) =>
  request === 'react-native' ? rnStub : originalLoad(request, parent, isMain);

vi.mock('react-native', () => rnStub);
vi.mock('react-native-marked', async () => {
  const [{ marked }, React] = await Promise.all([import('marked'), import('react')]);
  return {
    MarkedLexer: vi.fn((value: string) => marked.lexer(value, { gfm: true })),
    useMarkdown: vi.fn((value: string) => [
      React.createElement('MarkdownOutput', { key: 'output', value }),
    ]),
  };
});
vi.mock('react-native-render-html', () => ({ default: 'RenderHTML' }));
vi.mock('@/lib/hooks/use-theme-colors', () => {
  // One stable object per suite, like the real hook's module-level constants:
  // a fresh object per call would recreate the palette (and the segment
  // renderer) on every render and mask remount regressions.
  const colors = {
    foreground: '#111111',
    mutedForeground: '#666666',
    muted: '#eeeeee',
    border: '#cccccc',
    card: '#ffffff',
    primaryForeground: '#ffffff',
    primary: '#111111',
    accentSoftForeground: '#111111',
    accentSoft: '#eeeeee',
  };
  return { useThemeColors: () => colors };
});
vi.mock('./markdown-renderer', () => ({
  MarkdownRenderer: vi.fn(),
}));
vi.mock('./markdown-table', () => ({ MarkdownTable: 'MarkdownTable' }));
vi.mock('./markdown-image', () => ({ MarkdownImage: 'MarkdownImage' }));
vi.mock('./markdown-link', () => ({
  getLinkAccessibilityActions: (enabled: boolean) =>
    enabled ? [{ name: 'showLinkActions', label: 'Show link actions' }] : undefined,
  resolveLinkAccessibilityLabel: (_children: unknown, _href: string, title?: string) =>
    title ?? 'link',
}));
vi.mock('./markdown-link-confirm', () => ({
  confirmAndOpenMarkdownLink: vi.fn(),
}));

type RenderHtmlHostProps = {
  baseStyle: Record<string, unknown>;
  defaultTextProps: { selectable: boolean };
  domVisitors: DomVisitorCallbacks;
  enableCSSInlineProcessing: boolean;
  ignoredDomTags: string[];
  renderers: CustomTagRendererRecord;
  renderersProps: Partial<RenderersProps>;
  source: { html: string };
  tagsStyles: Record<string, Record<string, unknown>>;
};
const RenderHTMLType = 'RenderHTML' as unknown as ComponentType;
const AnchorType = 'Anchor' as unknown as ComponentType;
const MarkdownImageType = 'MarkdownImage' as unknown as ComponentType;
const MarkdownTableType = 'MarkdownTable' as unknown as ComponentType;
const TextType = 'Text' as unknown as ComponentType;
const ViewType = 'View' as unknown as ComponentType;

async function mount(element: ReactElement): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(element);
  });
  if (!ref.current) {
    throw new Error('renderer was not created');
  }
  return ref.current;
}

function htmlProps(renderer: TestRenderer.ReactTestRenderer): RenderHtmlHostProps {
  return renderer.root.findByType(RenderHTMLType).props as RenderHtmlHostProps;
}

function visibleText(tnode: TNode): string {
  if (tnode.type === 'text') {
    return tnode.data;
  }
  return tnode.children.map(visibleText).join('');
}

async function renderCustom(
  Renderer: CustomTagRendererRecord[string],
  tnode: Record<string, unknown>,
  extra: Record<string, unknown> = {}
): Promise<TestRenderer.ReactTestRenderer> {
  const props = { tnode, ...extra };
  const TestComponent = Renderer as unknown as ComponentType<Record<string, unknown>>;
  const renderer = await mount(createElement(TestComponent, props));
  return renderer;
}

function requiredRenderer(
  renderers: CustomTagRendererRecord,
  tag: string
): CustomTagRendererRecord[string] {
  const Renderer = renderers[tag];
  if (!Renderer) {
    throw new Error(`${tag} renderer was not created`);
  }
  return Renderer;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MarkdownText HTML routing', () => {
  it('renders HTML without Array.prototype.toSorted for Hermes clients', async () => {
    const originalToSorted = Array.prototype.toSorted;
    // eslint-disable-next-line no-extend-native -- the test reproduces the Hermes runtime without toSorted.
    Object.defineProperty(Array.prototype, 'toSorted', {
      configurable: true,
      value: undefined,
      writable: true,
    });

    try {
      const renderer = await mount(<MarkdownText value="Before <span>HTML</span> after" />);

      expect(renderer.root.findAllByType(RenderHTMLType)).toHaveLength(1);
    } finally {
      // eslint-disable-next-line no-extend-native -- restore the runtime after the Hermes simulation.
      Object.defineProperty(Array.prototype, 'toSorted', {
        configurable: true,
        value: originalToSorted,
        writable: true,
      });
    }
  });

  it('keeps an empty value on the Markdown renderer path', async () => {
    const renderer = await mount(<MarkdownText value="" />);

    expect(renderer.root.findAllByType(RenderHTMLType)).toHaveLength(0);
    expect(renderer.root.findAllByType(ViewType)).toHaveLength(2);
    expect(vi.mocked(useMarkdown)).not.toHaveBeenCalled();
  });

  it('keeps plain Markdown and fenced HTML on the existing renderer path', async () => {
    const value = 'Hello **world**\n\n```html\n<div>code only</div>\n```';
    const renderer = await mount(<MarkdownText value={value} />);

    expect(renderer.root.findAllByType(RenderHTMLType)).toHaveLength(0);
    expect(renderer.root.findAllByType(ViewType)).toHaveLength(3);
    expect(vi.mocked(useMarkdown)).toHaveBeenCalledWith(value, expect.any(Object));
    // One lex for the html/value split; the table split is skipped because the
    // fenced-HTML fixture has no GFM delimiter row.
    expect(vi.mocked(MarkedLexer)).toHaveBeenCalledTimes(1);

    await act(async () => {
      await Promise.resolve();
      renderer.update(<MarkdownText value={value} selectable={false} />);
    });
    expect(vi.mocked(MarkedLexer)).toHaveBeenCalledTimes(1);
  });

  it('keeps the markdown prefix mounted when the first HTML token arrives', async () => {
    const renderer = await mount(<MarkdownText value={'Hello\n\n'} />);

    expect(renderer.root.findAllByType(RenderHTMLType)).toHaveLength(0);
    expect(vi.mocked(MarkdownRenderer)).toHaveBeenCalledTimes(1);

    await act(async () => {
      await Promise.resolve();
      renderer.update(<MarkdownText value={'Hello\n\n<img src="https://example.com/a.png">'} />);
    });

    expect(renderer.root.findAllByType(RenderHTMLType)).toHaveLength(1);
    expect(renderer.root.findAllByType(RenderHTMLType)[0]?.props.source).toEqual({
      html: '<img src="https://example.com/a.png">',
    });
    // A root type change would remount the markdown prefix and construct a
    // fresh renderer for the unchanged segment; streaming must keep the
    // original instance so element keys and local state survive.
    expect(vi.mocked(MarkdownRenderer)).toHaveBeenCalledTimes(1);
  });

  it('keeps Markdown blocks on their renderer and keeps inline HTML in one flow', async () => {
    const value =
      '# Heading\n\nBefore <span>HTML</span> and **Markdown**.\n\n- one\n- two\n\n[Docs](https://example.com)\n\n<img src="https://example.com/a.png">';
    const renderer = await mount(<MarkdownText value={value} />);
    const htmlNodes = renderer.root.findAllByType(RenderHTMLType);

    expect(vi.mocked(useMarkdown).mock.calls.map(([source]) => source)).toEqual([
      '# Heading\n\n',
      '\n\n- one\n- two\n\n[Docs](https://example.com)\n\n',
    ]);
    expect(htmlNodes.map(node => node.props.source)).toEqual([
      { html: '<p>Before <span>HTML</span> and <strong>Markdown</strong>.</p>\n' },
      { html: '<img src="https://example.com/a.png">' },
    ]);
    const props = htmlNodes[0]?.props as RenderHtmlHostProps;
    expect(props.baseStyle).toMatchObject({ color: '#111111', fontSize: 16, lineHeight: 24 });
    expect(props.defaultTextProps).toEqual({ selectable: true });

    await act(async () => {
      await Promise.resolve();
      renderer.update(<MarkdownText value={value} selectable={false} />);
    });
    expect(renderer.root.findAllByType(RenderHTMLType)[0]?.props.source).toBe(props.source);
  });

  it('routes inline HTML inside a Markdown heading', async () => {
    const renderer = await mount(<MarkdownText value="# Heading <span>HTML</span>" />);

    expect(vi.mocked(useMarkdown)).not.toHaveBeenCalled();
    expect(renderer.root.findAllByType(RenderHTMLType).map(node => node.props.source)).toEqual([
      { html: '<h1>Heading <span>HTML</span></h1>\n' },
    ]);
    expect(htmlProps(renderer).tagsStyles).toMatchObject({
      h1: { fontSize: 22, fontWeight: '700' },
      h2: { fontSize: 20, fontWeight: '700' },
      h3: { fontSize: 18, fontWeight: '700' },
      h4: { fontSize: 16, fontWeight: '700' },
      h5: { fontSize: 15, fontWeight: '700' },
      h6: { fontSize: 14, fontWeight: '700' },
    });
  });

  it('styles HTML text like equivalent Markdown text', async () => {
    const renderer = await mount(
      <MarkdownText value='<p>Body <strong>bold</strong> <a href="https://example.com">link</a></p><blockquote>quote</blockquote>' />
    );

    expect(htmlProps(renderer).tagsStyles).toMatchObject({
      a: { color: '#111111', textDecorationLine: 'underline' },
      blockquote: { borderLeftColor: '#cccccc', borderLeftWidth: 3, paddingLeft: 12 },
      p: { marginVertical: 2, paddingVertical: 0 },
      strong: { color: '#111111', fontWeight: '700' },
    });
  });

  it('leaves the HTML blockquote start rule to RN physical-edge mirroring in RTL', async () => {
    rnStub.I18nManager.isRTL = true;
    try {
      const renderer = await mount(<MarkdownText value="> <strong>quoted</strong>" />);

      // RN mirrors physical left/right padding, margin, and borders under RTL
      // (`doLeftAndRightSwapInRTL` defaults to true), so the rule stays on the
      // physical left edge and lands on the right edge of an RTL layout.
      // Choosing the side from `I18nManager.isRTL` here would double-mirror it
      // back to the left.
      expect(htmlProps(renderer).tagsStyles.blockquote).toMatchObject({
        borderLeftColor: '#cccccc',
        borderLeftWidth: 3,
        paddingLeft: 12,
      });
      expect(htmlProps(renderer).tagsStyles.blockquote).not.toHaveProperty('borderRightWidth');
      expect(htmlProps(renderer).tagsStyles.blockquote).not.toHaveProperty('paddingRight');
    } finally {
      rnStub.I18nManager.isRTL = false;
    }
  });

  it('does not match raw HTML inside a preceding code span', async () => {
    const renderer = await mount(<MarkdownText value="Before `<span>` <span>HTML</span> after" />);

    expect(vi.mocked(useMarkdown)).not.toHaveBeenCalled();
    expect(renderer.root.findAllByType(RenderHTMLType).map(node => node.props.source)).toEqual([
      { html: '<p>Before <code>&lt;span&gt;</code> <span>HTML</span> after</p>\n' },
    ]);
  });

  it('keeps inline HTML inside a blockquote on the Markdown path', async () => {
    const value = '> <div>quoted</div>';
    const renderer = await mount(<MarkdownText value={value} />);

    expect(vi.mocked(useMarkdown).mock.calls.map(([source]) => source)).toEqual([value]);
    expect(renderer.root.findAllByType(RenderHTMLType)).toHaveLength(0);
  });

  it('routes HTML links and strong text nested in a list item to the styled HTML renderer', async () => {
    const value =
      '- Markdown: [example](https://example.com)\n- HTML: <a href="https://example.com">HTML link</a>\n- <strong>HTML strong</strong>';
    const renderer = await mount(<MarkdownText value={value} />);
    const props = htmlProps(renderer);

    expect(props.source.html).toContain('<ul>');
    expect(props.source.html).toContain('<a href="https://example.com">HTML link</a>');
    expect(props.source.html).toContain('<strong>HTML strong</strong>');
    expect(props.tagsStyles).toMatchObject({
      a: { textDecorationLine: 'underline' },
      strong: { fontWeight: '700' },
    });
    expect(vi.mocked(useMarkdown)).not.toHaveBeenCalled();
  });

  it('routes HTML headings nested in a list item to the styled HTML renderer', async () => {
    const renderer = await mount(<MarkdownText value={'- <h2>HTML heading</h2>\n- text'} />);

    expect(htmlProps(renderer).source.html).toContain('<h2>HTML heading</h2>');
  });

  it('routes styled inline HTML inside a blockquote to the styled HTML renderer', async () => {
    const value = '> <a href="https://example.com">HTML link</a> and <strong>HTML strong</strong>';
    const renderer = await mount(<MarkdownText value={value} />);
    const props = htmlProps(renderer);

    expect(props.source.html).toContain('<blockquote>');
    expect(props.source.html).toContain('<a href="https://example.com">HTML link</a>');
    expect(props.tagsStyles).toMatchObject({ a: { textDecorationLine: 'underline' } });
  });

  it('keeps a list with a fenced code block on the Markdown renderer', async () => {
    const value =
      '- item <a href="https://example.com">HTML link</a>\n\n  ```js\n  const a = 1;\n  ```\n';
    const renderer = await mount(<MarkdownText value={value} />);

    expect(renderer.root.findAllByType(RenderHTMLType)).toHaveLength(0);
    expect(vi.mocked(useMarkdown).mock.calls.map(([source]) => source)).toContain(value);
  });

  it.each([
    ['link', '[<b>bold</b>](https://example.com)'],
    ['emphasis', '*<b>bold</b>*'],
    ['strong', '**<i>bold</i>**'],
  ])('keeps inline HTML inside Markdown %s on the Markdown path', async (_name, value) => {
    const renderer = await mount(<MarkdownText value={value} />);

    expect(vi.mocked(useMarkdown).mock.calls.map(([source]) => source)).toEqual([value]);
    expect(renderer.root.findAllByType(RenderHTMLType)).toHaveLength(0);
  });

  it('keeps a table with inline HTML on the table path', async () => {
    const value = '| Path | Note |\n| ---- | ---- |\n| a/b | line1<br>line2 |';
    const renderer = await mount(<MarkdownText value={value} />);

    expect(renderer.root.findAllByType(MarkdownTableType)).toHaveLength(1);
    expect(renderer.root.findAllByType(RenderHTMLType)).toHaveLength(0);
  });

  it('keeps tables and fenced code around block HTML on the Markdown path', async () => {
    const value =
      '| Name |\n| --- |\n| Kilo |\n\n<section>safe HTML</section>\n\n```ts\nconst answer = 42;\n```';
    const renderer = await mount(<MarkdownText value={value} />);

    expect(renderer.root.findAllByType(MarkdownTableType)).toHaveLength(1);
    expect(renderer.root.findAllByType(RenderHTMLType).map(node => node.props.source)).toEqual([
      { html: '<section>safe HTML</section>' },
    ]);
    expect(vi.mocked(useMarkdown).mock.calls.map(([source]) => source)).toContain(
      '\n\n```ts\nconst answer = 42;\n```'
    );
  });

  it('routes block HTML and removes active, style, form, media, SVG, and metadata nodes', async () => {
    const value =
      '<section onclick="run()">safe</section><script>script text</script><style>style text</style><iframe src="https://x">frame text</iframe><object>object text</object><video>media text</video><form>form text</form><svg>svg text</svg><title>meta text</title>';
    const renderer = await mount(<MarkdownText value={value} />);
    const props = htmlProps(renderer);

    expect(props.source.html).toContain('safe</section>');
    expect(props.enableCSSInlineProcessing).toBe(false);
    expect(props.ignoredDomTags).toEqual(
      expect.arrayContaining(['link', 'frame', 'embed', 'source', 'track', 'input', 'base', 'meta'])
    );
    expect(props.source).not.toHaveProperty('uri');

    const actual = await vi.importActual<typeof RenderHtmlExports>('react-native-render-html');
    const engine = actual.buildTREFromConfig({
      baseStyle: props.baseStyle,
      domVisitors: props.domVisitors,
      enableCSSInlineProcessing: props.enableCSSInlineProcessing,
      ignoredDomTags: props.ignoredDomTags,
    });
    expect(visibleText(engine.buildTTree(props.source.html))).toBe('safe');
  });

  it('keeps a picture fallback image while clearing its removed children', async () => {
    const renderer = await mount(
      <MarkdownText value='<picture><source srcset="https://example.com/a.webp"><script>evil()</script><img src="https://example.com/a.png" alt="shot"></picture>' />
    );
    const props = htmlProps(renderer);
    const actual = await vi.importActual<typeof RenderHtmlExports>('react-native-render-html');
    const engine = actual.buildTREFromConfig({
      baseStyle: props.baseStyle,
      domVisitors: props.domVisitors,
      enableCSSInlineProcessing: props.enableCSSInlineProcessing,
      ignoredDomTags: props.ignoredDomTags,
    });
    const images: TNode[] = [];
    const visit = (node: TNode): void => {
      if (node.tagName === 'img') {
        images.push(node);
      }
      for (const child of node.children) {
        visit(child);
      }
    };
    visit(engine.buildTTree(props.source.html));

    expect(images).toHaveLength(1);
    expect(images[0]?.attributes.src).toBe('https://example.com/a.png');
    expect(visibleText(engine.buildTTree(props.source.html))).toBe('');
  });

  it('renders an active-content-only source as an empty native tree', async () => {
    const renderer = await mount(<MarkdownText value="<script>alert('bad')</script>" />);
    const props = htmlProps(renderer);
    const actual = await vi.importActual<typeof RenderHtmlExports>('react-native-render-html');
    const engine = actual.buildTREFromConfig({
      domVisitors: props.domVisitors,
      ignoredDomTags: props.ignoredDomTags,
    });

    expect(visibleText(engine.buildTTree(props.source.html))).toBe('');
  });
});

describe('MarkdownText HTML links and images', () => {
  it('routes a linked image press with the link accessibility label', async () => {
    const onPressLink = vi.fn(() => true);
    const value = 'Text <img src="https://example.com/a.png" alt="shot">';
    const renderer = await mount(<MarkdownText value={value} />);
    await act(async () => {
      await Promise.resolve();
      renderer.update(<MarkdownText value={value} onPressLink={onPressLink} />);
    });
    const ImageRenderer = requiredRenderer(htmlProps(renderer).renderers, 'img');
    const image = await renderCustom(ImageRenderer, {
      attributes: { src: 'https://example.com/a.png', alt: 'shot' },
      parent: {
        tagName: 'a',
        attributes: { href: 'https://example.com', title: 'Example' },
        parent: null,
      },
    });
    const imageProps = image.root.findByType(MarkdownImageType).props as Record<string, unknown>;

    expect(imageProps.accessibilityLabel).toBe('Example');
    expect(imageProps.onPress).toBeTypeOf('function');
    (imageProps.onPress as () => void)();
    expect(onPressLink).toHaveBeenCalledWith('https://example.com');
    expect(confirmAndOpenMarkdownLink).not.toHaveBeenCalled();
  });

  it('routes anchor press and long press without forwarding executable attributes', async () => {
    const onPressLink = vi.fn(() => true);
    const onLongPressLink = vi.fn<(href: string, event?: GestureResponderEvent) => void>();
    const renderer = await mount(
      <MarkdownText
        value='<a href="https://example.com" onclick="run()">Docs</a>'
        onPressLink={onPressLink}
        onLongPressLink={onLongPressLink}
      />
    );
    const props = htmlProps(renderer);
    const onPress = props.renderersProps.a?.onPress;
    if (!onPress) {
      throw new Error('anchor press handler was not created');
    }
    const event = undefined as never;
    onPress(event, 'https://example.com', { title: 'Docs' }, '_blank');
    expect(onPressLink).toHaveBeenCalledWith('https://example.com');
    expect(confirmAndOpenMarkdownLink).not.toHaveBeenCalled();
    onPressLink.mockReturnValue(false);
    onPress(event, 'https://example.com', { title: 'Docs' }, '_blank');
    expect(confirmAndOpenMarkdownLink).toHaveBeenCalledWith('https://example.com', {
      label: 'Docs',
    });

    const anchor = await renderCustom(
      requiredRenderer(props.renderers, 'a'),
      { attributes: { href: 'https://example.com', onclick: 'run()' } },
      { InternalRenderer: 'Anchor', textProps: {} }
    );
    const textProps = anchor.root.findByType(AnchorType).props.textProps as Record<string, unknown>;
    expect(textProps).not.toHaveProperty('onclick');
    expect(textProps).not.toHaveProperty('onClick');
    (textProps.onLongPress as (event: never) => void)(event);
    expect(onLongPressLink).toHaveBeenCalledWith('https://example.com', undefined);
  });

  it.each([
    ['missing dimensions', { src: 'https://example.com/a.png' }],
    ['unparsable dimensions', { src: 'https://example.com/a.png', width: '400px', height: '900' }],
    ['empty height', { src: 'https://example.com/a.png', width: '400', height: '' }],
    ['zero width', { src: 'https://example.com/a.png', width: '0', height: '900' }],
    ['negative width', { src: 'https://example.com/a.png', width: '-400', height: '900' }],
  ])('leaves the aspect ratio to onLoad measurement: %s', async (_name, attributes) => {
    const renderer = await mount(<MarkdownText value='<img src="https://example.com/a.png">' />);
    const ImageRenderer = requiredRenderer(htmlProps(renderer).renderers, 'img');
    const rendered = await renderCustom(ImageRenderer, { attributes, parent: null });
    expect(rendered.root.findByType(MarkdownImageType).props.aspectRatio).toBeUndefined();
  });

  it('keeps a valid portrait dimension pair on the clamped ratio path', async () => {
    const renderer = await mount(<MarkdownText value='<img src="https://example.com/a.png">' />);
    const ImageRenderer = requiredRenderer(htmlProps(renderer).renderers, 'img');
    const portrait = await renderCustom(ImageRenderer, {
      attributes: { src: 'https://example.com/a.png', width: '1170', height: '2532' },
      parent: null,
    });
    expect(portrait.root.findByType(MarkdownImageType).props.aspectRatio).toBe(0.75);
  });

  it('routes supported images with a fixed ratio and renders unsupported alt text', async () => {
    const renderer = await mount(
      <MarkdownText value='Text <img src="https://example.com/a.png" width="400" height="200">' />
    );
    const ImageRenderer = requiredRenderer(htmlProps(renderer).renderers, 'img');
    const supported = await renderCustom(ImageRenderer, {
      attributes: {
        src: 'https://example.com/a.png',
        alt: 'shot',
        width: '400',
        height: '200',
      },
      parent: null,
    });
    expect(supported.root.findByType(MarkdownImageType).props).toMatchObject({
      uri: 'https://example.com/a.png',
      alt: 'shot',
      aspectRatio: 2,
    });

    const http = await renderCustom(ImageRenderer, {
      attributes: { src: 'http://example.com/a.png' },
      parent: null,
    });
    const data = await renderCustom(ImageRenderer, {
      attributes: { src: 'data:image/png;base64,abc' },
      parent: null,
    });
    expect([
      http.root.findByType(MarkdownImageType).props.uri,
      data.root.findByType(MarkdownImageType).props.uri,
    ]).toEqual(['http://example.com/a.png', 'data:image/png;base64,abc']);

    const unsupported = await renderCustom(ImageRenderer, {
      attributes: { src: 'file:///secret.png', alt: 'diagram' },
      parent: null,
    });
    const textProps = unsupported.root.findByType(TextType).props;
    expect(textProps).toMatchObject({
      children: 'diagram',
      selectable: true,
    });
    expect(textProps).not.toHaveProperty('onPress');
    expect(unsupported.root.findAllByType(MarkdownImageType)).toHaveLength(0);

    const empty = await renderCustom(ImageRenderer, {
      attributes: { src: '' },
      parent: null,
    });
    expect(empty.root.findByType(TextType).props.children).toBe('');
    expect(empty.root.findAllByType(MarkdownImageType)).toHaveLength(0);
  });
});

// Paragraphs, headings, lists, blockquotes, a fenced code block holding
// `<div>`, inline `<span>` HTML, a list whose item carries inline HTML, a loose
// list (blank line between items) whose first item carries inline HTML, an
// ordered loose list whose second item arrives as a bare number first, a list
// continuation line, a tab-only separator, a CRLF document, a GFM table, and
// links. Streamed one character at a time to cover every prefix.
const INCREMENTAL_CORPUS = [
  'A plain opening paragraph with ordinary prose.\n\n',
  '# A heading with a plain line\n\n',
  'A paragraph with a [link](https://example.com/page) and **emphasis**.\n\n',
  '- first item\n- second item\n- third item\n\n',
  '> a blockquote line\n> continued on a second line\n\n',
  '```html\n<div>fenced code only</div>\n```\n\n',
  'Inline <span>HTML</span> inside a paragraph.\n\n',
  '| Name | Note |\n| ---- | ---- |\n| Kilo | a/b |\n\n',
  // Duplicate link reference definitions: marked drops the later
  // definition's raw text, so the value's tokens no longer tile the source
  // and a raw-length offset is not a source offset. The head must not be
  // reused for such a value.
  '[ref]: https://example.com\n\n[ref]: https://other.example\n\nSee [ref].\n\n',
  '- a list with an <a href="https://example.com/page">inline HTML link</a>\n- and a plain item\n\n',
  // A loose list is one token whose `loose` flag flips on when the blank line
  // between items arrives; the head must not freeze the list before that.
  '- a loose list starting with an <a href="https://example.com/page">inline HTML link</a>\n\n- and a plain second item\n\n',
  // An ordered loose list whose second item arrives as a bare number first:
  // `1. Click <b>Save</b>\n\n2.` lexes as a list plus a paragraph, and the
  // trailing `.` turns that paragraph into the list's second item, growing the
  // list token retroactively. The head must not have frozen the list.
  '1. Click <b>Save</b>\n\n2. Restart the app\n\n',
  // The same shape without the marker: `2` after a blank line stays a paragraph
  // until a `.` arrives, then joins the list above it.
  '- ordered items follow\n\n2\n\n2. and the second one\n\n',
  // A paragraph lazily continues over a line that does not interrupt it, so a
  // later list line can pull an earlier line back into the paragraph.
  '<b>x</b>\n2. b\n- x\n\n',
  // A paragraph directly abutting a list item: `<b>x</b>\n2. b \n-` lexes as a
  // paragraph, a list, a space, and a list with no stable separator between the
  // paragraph and the first list. Completing the bullet merges `2. b ` back into
  // the paragraph, so the boundary must back up over the paragraph's whole run.
  '<b>x</b>\n2. b \n- i\n\n',
  // A line holding only a tab does not end a paragraph in marked's GFM
  // paragraph tokenizer: `…\n\t\n` lexes as a paragraph plus a `space` token
  // while the next line does not interrupt the paragraph, but as one paragraph
  // once that line becomes a list item. A boundary drawn after that `space`
  // token would freeze a paragraph the next append pulls the tab line back
  // into.
  'Paragraph <b>bold</b> before a tab separator\n\t\n- item after the tab separator\n\n',
  // marked normalizes `\r\n` to `\n` inside token raws, so a raw-length offset
  // is no longer a source offset. A value with a carriage return must never
  // reuse a head.
  'Paragraph <b>bold</b> before a CRLF\r\n\r\n- item after the CRLF\r\n\r\n',
  'Closing paragraph with [Docs](https://example.com/docs).\n\n',
].join('');

const STREAM_STEPS = 40;

// Block fragments whose token boundaries move when an append arrives: an item
// marker that only becomes a list item once its dot lands (`2.`), a loose list
// that flips tight→loose, a paragraph a later line can interrupt or extend, a
// fence that swallows the rest, and a table whose delimiter row has not
// arrived. Every ordered pair is streamed prefix by prefix, adjacent and after
// a blank line, so the adjacency that froze a streamed ordered list is always
// generated. The corpus above is hand-picked; the boundary bug that froze that
// list was found by a fuzz, not by a corpus.
const FUZZ_FRAGMENTS = [
  'plain paragraph text',
  '- plain list item',
  '1. Click <b>Save</b>',
  '2. Restart the app',
  '3. <b>third</b>',
  '2.',
  '2',
  '1. first',
  '<b>bold</b> text',
  '- item with <b>html</b>',
  '- <a href="https://example.com/page">link item</a>',
  '- a loose list with <b>html</b>',
  '> quoted',
  '> more quote',
  '# heading',
  '---',
  '```',
  '<div>code</div>',
  '```',
  '<span>inline HTML</span>',
  '| a | b |',
  '| --- | --- |',
  ':-',
  'continuation line',
  '  inset continuation',
  'a | b',
  '[ref]: https://example.com',
  '[ref]: https://other.example',
];

function lexedCharacterCount(): number {
  return vi.mocked(MarkedLexer).mock.calls.reduce((total, [source]) => total + source.length, 0);
}

/** The first prefix of `value` whose incremental split differs from the whole-value split. */
function firstDivergence(value: string): string {
  let snapshot: MarkdownHtmlSnapshot | undefined = undefined;
  for (let index = 1; index <= value.length; index += 1) {
    const prefix = value.slice(0, index);
    const incremental = splitMarkdownHtmlIncremental(prefix, snapshot);
    snapshot = incremental.snapshot;
    const whole = splitMarkdownHtml(prefix);
    if (JSON.stringify(incremental.segments) !== JSON.stringify(whole)) {
      return `${JSON.stringify(value)} at ${index}: ${JSON.stringify(incremental.segments)} != ${JSON.stringify(whole)}`;
    }
  }
  return '';
}

describe('splitMarkdownHtmlIncremental', () => {
  it('matches the whole-value split for every prefix of the corpus', () => {
    let snapshot: MarkdownHtmlSnapshot | undefined = undefined;
    for (let index = 1; index <= INCREMENTAL_CORPUS.length; index += 1) {
      const value = INCREMENTAL_CORPUS.slice(0, index);
      const incremental = splitMarkdownHtmlIncremental(value, snapshot);
      snapshot = incremental.snapshot;
      expect(incremental.segments, `prefix ${index} (${JSON.stringify(value.slice(-20))})`).toEqual(
        splitMarkdownHtml(value)
      );
    }
  });

  it('keeps a streamed loose list with an inline-HTML first item in one html segment', () => {
    // A trailing blank line does not close the list: the new item joins it and
    // flips it from tight to loose, so the frozen head must not hold the list.
    const opening = '- <a href="https://example.com/page">inline HTML link</a>\n\n';
    const completed = `${opening}- a plain second item`;

    const first = splitMarkdownHtmlIncremental(opening);
    const second = splitMarkdownHtmlIncremental(completed, first.snapshot);

    expect(second.segments).toEqual(splitMarkdownHtml(completed));
    expect(second.segments).toHaveLength(1);
    expect(second.segments[0]?.type).toBe('html');
    // The loose list wraps each item in a paragraph; a frozen tight head would
    // render `<li>inline HTML link</li>` plus a separate second list.
    expect(second.segments[0]?.raw).toContain('<li><p>');
    expect(second.segments[0]?.raw).toContain('a plain second item');
  });

  it('keeps a streamed ordered loose list in one html segment when the next item starts as a bare number', () => {
    // `1. Click <b>Save</b>\n\n2.` lexes as a list plus a paragraph; the next
    // `.` turns that paragraph into the list's second item, so the list token
    // grows retroactively. A head that froze the tight one-item list would
    // render `<li>Click <b>Save</b></li>` plus a separate `\n\n2.` markdown
    // segment instead of the loose two-item list a whole-value lex produces.
    const opening = '1. Click <b>Save</b>\n\n';
    let snapshot: MarkdownHtmlSnapshot | undefined = undefined;
    for (const value of [opening, `${opening}2.`, `${opening}2. Restart the app`]) {
      const result = splitMarkdownHtmlIncremental(value, snapshot);
      snapshot = result.snapshot;
      expect(result.segments, value).toEqual(splitMarkdownHtml(value));
    }

    const segments = splitMarkdownHtml(`${opening}2. Restart the app`);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.type).toBe('html');
    expect(segments[0]?.raw).toContain('<li><p>Click <b>Save</b></p>');
    expect(segments[0]?.raw).toContain('Restart the app');
  });

  it('keeps a paragraph a later list item merges into out of the frozen head', () => {
    // `<b>x</b>\n2. b \n-` lexes as a paragraph, a list, a space, and a list; the
    // paragraph directly abuts the first list with no stable separator between
    // them, so the paragraph's whole run is still in play. Completing the bullet
    // (`- i`) merges `2. b ` back into the paragraph: a boundary that stopped on
    // the list would freeze the truncated paragraph and the stream would keep
    // the wrong split for the rest of the message.
    const value = '<b>x</b>\n2. b \n- i';
    let snapshot: MarkdownHtmlSnapshot | undefined = undefined;
    for (let index = 1; index <= value.length; index += 1) {
      const prefix = value.slice(0, index);
      const incremental = splitMarkdownHtmlIncremental(prefix, snapshot);
      snapshot = incremental.snapshot;
      expect(incremental.segments, `prefix ${index} (${JSON.stringify(prefix)})`).toEqual(
        splitMarkdownHtml(prefix)
      );
    }

    const segments = splitMarkdownHtml(value);
    expect(segments).toHaveLength(2);
    expect(segments[0]?.type).toBe('html');
    expect(segments[0]?.raw).toContain('2. b ');
    expect(segments[1]).toEqual({ type: 'markdown', raw: '- i' });
  });

  it('re-lexes the streaming tail, far less than the full prefix length', () => {
    let snapshot: MarkdownHtmlSnapshot | undefined = undefined;
    let value = '<span>start</span>\n\n';
    let fullPrefixCharacters = 0;
    for (let index = 1; index <= STREAM_STEPS; index += 1) {
      value += `## Heading ${index}\n\nParagraph body ${index} with a few words.\n\n- item ${index}\n- item ${index} again\n\n`;
      snapshot = splitMarkdownHtmlIncremental(value, snapshot).snapshot;
      fullPrefixCharacters += value.length;
    }
    const lexedCharacters = lexedCharacterCount();

    // eslint-disable-next-line no-console -- the request asks the PR to quote these totals
    console.log(
      `splitMarkdownHtmlIncremental lexed ${lexedCharacters} chars in ${vi.mocked(MarkedLexer).mock.calls.length} lexes; the full prefixes total ${fullPrefixCharacters} chars`
    );
    expect(lexedCharacters).toBeLessThan(fullPrefixCharacters / 4);
  });

  it('never lexes a `<`-free stream (whole-value fast path)', () => {
    let snapshot: MarkdownHtmlSnapshot | undefined = undefined;
    let value = '';
    let fullPrefixCharacters = 0;
    for (let index = 1; index <= STREAM_STEPS; index += 1) {
      value += `Paragraph ${index} with a few words.\n\n`;
      snapshot = splitMarkdownHtmlIncremental(value, snapshot).snapshot;
      fullPrefixCharacters += value.length;
    }

    // eslint-disable-next-line no-console -- the request asks the PR to quote these totals
    console.log(
      `splitMarkdownHtmlIncremental lexed ${lexedCharacterCount()} chars for a ${fullPrefixCharacters}-char \`<\`-free stream`
    );
    expect(vi.mocked(MarkedLexer)).not.toHaveBeenCalled();
    expect(lexedCharacterCount()).toBe(0);
  });

  it('extracts a table chip when the body has a GFM delimiter row', async () => {
    const renderer = await mount(<MarkdownText value={'| Name |\n| --- |\n| Kilo |'} />);

    expect(renderer.root.findAllByType(MarkdownTableType)).toHaveLength(1);
    // No `<` in the value, so only the table extraction lexes.
    expect(vi.mocked(MarkedLexer)).toHaveBeenCalledTimes(1);
  });

  it('skips the table lex when a stray pipe has no delimiter row', async () => {
    const renderer = await mount(
      <MarkdownText value={'a | b\n\n```\n<div>code only</div>\n```'} />
    );

    expect(renderer.root.findAllByType(MarkdownTableType)).toHaveLength(0);
    // One lex for the html/value split; the table split is skipped.
    expect(vi.mocked(MarkedLexer)).toHaveBeenCalledTimes(1);
  });

  it('keeps a pipe-less single-column table on the table path', async () => {
    // marked lexes `a\n:-\nb` as a table with no pipe in either row, so the
    // delimiter-row test must accept a colon without a pipe.
    const renderer = await mount(<MarkdownText value={'a\n:-\nb'} />);

    expect(renderer.root.findAllByType(MarkdownTableType)).toHaveLength(1);
    // No `<` in the value, so only the table extraction lexes.
    expect(vi.mocked(MarkedLexer)).toHaveBeenCalledTimes(1);
  });

  it('skips the table lex for a thematic break or a stray pipe without a delimiter row', async () => {
    const renderer = await mount(<MarkdownText value={'before\n\n---\n\na | b\n\nafter'} />);

    expect(renderer.root.findAllByType(MarkdownTableType)).toHaveLength(0);
    // `---` underlines nothing (the blank line makes it a thematic break) and
    // `a | b` is prose, so neither the `html`/value split (no `<`) nor the
    // table split lexes the value.
    expect(vi.mocked(MarkedLexer)).not.toHaveBeenCalled();
  });

  it('matches the whole-value split for every ordered pair of block fragments', () => {
    const documents = FUZZ_FRAGMENTS.flatMap(first =>
      FUZZ_FRAGMENTS.flatMap(second =>
        (['\n', '\n\n'] as const).map(separator => `${first}${separator}${second}\n`)
      )
    );
    let mismatch = '';
    for (const document of documents) {
      mismatch = firstDivergence(document);
      if (mismatch !== '') {
        break;
      }
    }

    expect(mismatch).toBe('');
  });

  it('matches the whole-value split across separators marked treats as provisional', () => {
    // A seeded walk over the same fragments, joined with separators whose
    // stability differs: a single newline (no separator token), a blank line,
    // a tab-only line (marked keeps the preceding paragraph open for it), and
    // CRLF (marked strips the carriage return out of token raws). Every prefix
    // is checked against the whole-value split, so a boundary drawn after a
    // provisional separator or a CRLF offset drift shows up here. The LCG is
    // hand-rolled to keep the walk deterministic without a dependency.
    const separators = ['\n', '\n\n', '\n\t\n', '\r\n'];
    let state = 20_260_922;
    const next = () => {
      state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      return state / 4_294_967_296;
    };
    for (let iteration = 0; iteration < 1200; iteration += 1) {
      const parts = 2 + Math.floor(next() * 3);
      let document = '';
      for (let part = 0; part < parts; part += 1) {
        document += FUZZ_FRAGMENTS[Math.floor(next() * FUZZ_FRAGMENTS.length)] ?? '';
        document += separators[Math.floor(next() * separators.length)] ?? '\n';
      }
      expect(firstDivergence(document), document).toBe('');
    }
  });

  it('matches the whole-value split for duplicate link reference definitions', () => {
    // marked drops a duplicate definition's raw text, so its block tokens do
    // not tile the source and a raw-length offset is not a source offset. The
    // head must not be reused for a value whose definitions can collide, and
    // the value still has to segment exactly like the whole-value split.
    const documents = [
      '[ref]: https://a.example\n\n[ref]: https://b.example\n\n- <a href="https://x.example">item</a>',
      '[ref]: https://a.example\n\n- <a href="https://x.example">item</a>\n\n[ref]: https://b.example',
      'text\n\n[ref]: https://a.example\n\n[ref]: https://b.example\n\n> <a href="https://x.example">quote</a>',
      '[ref]: https://a.example\n\n[ref]: https://b.example\n\n[ref]: https://c.example\n\n| a | b |\n| --- | --- |\n| <a href="https://x.example">c</a> | d |',
    ];
    for (const document of documents) {
      expect(firstDivergence(document), document).toBe('');
    }
  });
});
