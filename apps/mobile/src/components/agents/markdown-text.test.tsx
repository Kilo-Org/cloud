/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used by the mobile test harness */
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
};
const RenderHTMLType = 'RenderHTML' as unknown as ComponentType;
const AnchorType = 'Anchor' as unknown as ComponentType;
const MarkdownImageType = 'MarkdownImage' as unknown as ComponentType;

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
  it('keeps plain Markdown and fenced HTML on the existing renderer path', async () => {
    const value = 'Hello **world**\n\n```html\n<div>code only</div>\n```';
    const renderer = await mount(<MarkdownText value={value} />);

    expect(renderer.root.findAllByType(RenderHTMLType)).toHaveLength(0);
    expect(vi.mocked(useMarkdown)).toHaveBeenCalledWith(value, expect.any(Object));
    expect(vi.mocked(MarkedLexer)).toHaveBeenCalledTimes(2);

    await act(async () => {
      await Promise.resolve();
      renderer.update(<MarkdownText value={value} selectable={false} />);
    });
    expect(vi.mocked(MarkedLexer)).toHaveBeenCalledTimes(2);
  });

  it('converts the complete mixed source and keeps native output order', async () => {
    const value =
      '# Heading\n\nBefore <span>HTML</span> and **Markdown**.\n\n- one\n- two\n\n[Docs](https://example.com)\n\n<img src="https://example.com/a.png">';
    const renderer = await mount(<MarkdownText value={value} />);
    const props = htmlProps(renderer);

    expect(vi.mocked(useMarkdown)).not.toHaveBeenCalled();
    expect(props.source).toEqual({
      html: expect.stringMatching(
        /^<h1>Heading<\/h1>[\s\S]*<span>HTML<\/span>[\s\S]*<strong>Markdown<\/strong>[\s\S]*<ul>[\s\S]*<a href="https:\/\/example.com">Docs<\/a>[\s\S]*<img src="https:\/\/example.com\/a.png">/
      ),
    });
    expect(props.baseStyle).toMatchObject({ color: '#111111', fontSize: 16, lineHeight: 24 });
    expect(props.defaultTextProps).toEqual({ selectable: true });

    const firstSource = props.source;
    await act(async () => {
      await Promise.resolve();
      renderer.update(<MarkdownText value={value} selectable={false} />);
    });
    expect(htmlProps(renderer).source).toBe(firstSource);
    expect(vi.mocked(MarkedLexer)).toHaveBeenCalledTimes(1);
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

  it('routes supported images with a fixed ratio and drops unsupported sources', async () => {
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

    const allowedSources = ['http://example.com/a.png', 'data:image/png;base64,abc'];
    const allowed = await Promise.all(
      allowedSources.map(async src => {
        const allowedRenderer = await renderCustom(ImageRenderer, {
          attributes: { src },
          parent: null,
        });
        return allowedRenderer;
      })
    );
    expect(allowed.map(item => item.root.findByType(MarkdownImageType).props.uri)).toEqual(
      allowedSources
    );

    const unsupported = await renderCustom(ImageRenderer, {
      attributes: { src: 'file:///secret.png' },
      parent: null,
    });
    expect(unsupported.toJSON()).toBeNull();
  });
});
