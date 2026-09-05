/* eslint-disable max-lines, typescript-eslint/no-deprecated -- the HTML routing, sanitization, and interaction tests share one React Native module mock harness */
// eslint-disable-next-line import/no-nodejs-modules -- the real HTML engine needs a React Native stub in the node test environment
import Module from 'node:module';
import { type ComponentType, createElement, type ReactElement } from 'react';
import { type GestureResponderEvent } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MarkedLexer, useMarkdown } from 'react-native-marked';
import type * as RenderHtmlExports from 'react-native-render-html';
import {
  type CustomTagRendererRecord,
  type DomVisitorCallbacks,
  type RenderersProps,
  type TNode,
} from 'react-native-render-html';

import { confirmAndOpenMarkdownLink } from './markdown-link-confirm';
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
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    foreground: '#111111',
    mutedForeground: '#666666',
    muted: '#eeeeee',
    border: '#cccccc',
    card: '#ffffff',
    primaryForeground: '#ffffff',
    primary: '#111111',
    accentSoftForeground: '#111111',
    accentSoft: '#eeeeee',
  }),
}));
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
    expect(renderer.root.findAllByType(ViewType)).toHaveLength(1);
    expect(vi.mocked(useMarkdown)).not.toHaveBeenCalled();
  });

  it('keeps plain Markdown and fenced HTML on the existing renderer path', async () => {
    const value = 'Hello **world**\n\n```html\n<div>code only</div>\n```';
    const renderer = await mount(<MarkdownText value={value} />);

    expect(renderer.root.findAllByType(RenderHTMLType)).toHaveLength(0);
    expect(renderer.root.findAllByType(ViewType)).toHaveLength(2);
    expect(vi.mocked(useMarkdown)).toHaveBeenCalledWith(value, expect.any(Object));
    expect(vi.mocked(MarkedLexer)).toHaveBeenCalledTimes(2);

    await act(async () => {
      await Promise.resolve();
      renderer.update(<MarkdownText value={value} selectable={false} />);
    });
    expect(vi.mocked(MarkedLexer)).toHaveBeenCalledTimes(2);
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
      blockquote: { borderStartColor: '#cccccc', borderStartWidth: 3, paddingStart: 12 },
      p: { marginVertical: 2, paddingVertical: 0 },
      strong: { color: '#111111', fontWeight: '700' },
    });
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
