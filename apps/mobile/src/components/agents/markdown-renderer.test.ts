/* eslint-disable max-lines -- renderer host-key, image, link interaction, and empty-fence mount suites stay in one cohesive unit test file */
/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount RN trees under vitest (same pattern as code-block.test.ts) */
// eslint-disable-next-line import/no-nodejs-modules -- patching the CJS loader is the only way to stub react-native for the externalized react-native-marked; the library under test stays real
import Module from 'node:module';
import { createElement, type ReactElement, type ReactNode } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { confirmAndOpenMarkdownLink } from './markdown-link-confirm';

import { type MarkdownPalette } from './markdown-palette';
import { type MarkdownRenderer } from './markdown-renderer';

// react-native-marked is externalized by vitest, so vi.mock('react-native') does
// not intercept its nested requires. Patch Module._load before loading the
// library so the real Renderer (and github-slugger) can construct under node.
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
    // Real flatten semantics: merge arrays with later values winning, pass
    // non-array values through unchanged.
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
vi.mock('./code-block', () => ({
  CodeBlock: 'CodeBlock',
}));
// The empty-fence mount suite un-mocks ./code-block to exercise the real
// CodeBlock; these transitive stubs keep that real path mountable under node.
// They are inert for the renderer-props suites above.
vi.mock('react-native-gesture-handler', () => ({ ScrollView: 'ScrollView' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ background: '#FBFAF5', foreground: '#14130F' }),
}));
vi.mock('./mono-scroll-block', () => ({ useMonoScrollSheet: () => undefined }));
vi.mock('./bubble-text-selection-context', () => ({
  useTranscriptTextSelectable: () => true,
}));
vi.mock('./markdown-image', () => ({
  MarkdownImage: 'MarkdownImage',
}));
vi.mock('./markdown-link', () => ({
  getLinkAccessibilityActions: () => [],
  getLinkAccessibilityHint: () => 'hint',
  getLinkLongPressHandler: () => undefined,
  resolveLinkAccessibilityLabel: () => 'label',
}));
vi.mock('./markdown-link-confirm', () => ({
  confirmAndOpenMarkdownLink: vi.fn(),
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

function imageHostKey(renderer: MarkdownRenderer, uri: string): string | null {
  const element = renderer.image(uri) as ReactElement;
  return element.key ?? null;
}
function htmlElement(renderer: MarkdownRenderer, text: string): ReactElement | null {
  return renderer.html(text) as ReactElement | null;
}

function imageEl(
  renderer: MarkdownRenderer,
  uri: string,
  opts?: { alt?: string; title?: string }
): ReactElement | null {
  return renderer.image(uri, opts?.alt, undefined, opts?.title) as ReactElement | null;
}

function propOf(instance: TestRenderer.ReactTestInstance | undefined, key: string): unknown {
  if (!instance) {
    return undefined;
  }
  /* eslint-disable typescript-eslint/no-unsafe-member-access -- react-test-renderer props are an index signature */
  return instance.props[key];
  /* eslint-enable typescript-eslint/no-unsafe-member-access */
}

function flattenStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return Object.assign({}, ...(style.filter(Boolean) as Record<string, unknown>[]));
  }
  return (style ?? {}) as Record<string, unknown>;
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
  it('image() host keys are ordinal in call order', async () => {
    const renderer = await createRenderer();
    expect(imageHostKey(renderer, 'https://a.com/1.png')).toBe('md-image-0');
    expect(imageHostKey(renderer, 'https://a.com/2.png')).toBe('md-image-1');
    expect(imageHostKey(renderer, 'https://a.com/3.png')).toBe('md-image-2');
  });
  it('image() host key is independent of preceding getKey() consumption', async () => {
    const a = await createRenderer();
    const b = await createRenderer();
    keySequence(a, 2);
    keySequence(b, 11);
    expect(imageHostKey(a, 'https://a.com/1.png')).toBe('md-image-0');
    expect(imageHostKey(b, 'https://a.com/1.png')).toBe('md-image-0');
  });
  it('html(<img …>) returns MarkdownImage directly (no View wrapper)', async () => {
    const renderer = await createRenderer();
    const el = htmlElement(renderer, '<img alt="a" src="https://x/a.png">');
    expect(el).not.toBeNull();
    expect(el?.type).toBe('MarkdownImage');
    expect(el?.props).toMatchObject({ uri: 'https://x/a.png', alt: 'a' });
  });
  it('html(comment) returns a Text node (unchanged)', async () => {
    const renderer = await createRenderer();
    const el = htmlElement(renderer, '<!-- a comment -->');
    expect(el).not.toBeNull();
    expect(el?.type).toBe('Text');
  });
  it('image() returns MarkdownImage for https URI', async () => {
    const renderer = await createRenderer();
    const el = imageEl(renderer, 'https://a.com/1.png', { alt: 'alt text' });
    expect(el).not.toBeNull();
    if (!el) {
      throw new Error('expected element');
    }
    expect(el.type).toBe('MarkdownImage');
    expect(el.props).toMatchObject({
      uri: 'https://a.com/1.png',
      alt: 'alt text',
    });
  });
  it('image() returns MarkdownImage for http URI', async () => {
    const renderer = await createRenderer();
    const el = imageEl(renderer, 'http://a.com/1.png', { alt: 'alt text' });
    expect(el?.type).toBe('MarkdownImage');
  });
  it('image() returns MarkdownImage for data:image URI', async () => {
    const renderer = await createRenderer();
    const el = imageEl(renderer, 'data:image/png;base64,abc123', { alt: 'data image' });
    expect(el).not.toBeNull();
    if (!el) {
      throw new Error('expected element');
    }
    expect(el.type).toBe('MarkdownImage');
    expect(el.props).toMatchObject({ uri: 'data:image/png;base64,abc123' });
  });
  it('image() renders alt text for relative URL (no image node)', async () => {
    const renderer = await createRenderer();
    const el = imageEl(renderer, './relative.png', { alt: 'relative' });
    expect(el?.type).toBe('Text');
    expect((el as ReactElement<Record<string, unknown>>).props.children).toBe('relative');
  });
  it('image() renders alt text for file:// URL (no image node)', async () => {
    const renderer = await createRenderer();
    const el = imageEl(renderer, 'file:///tmp/img.png', { alt: 'local' });
    expect(el?.type).toBe('Text');
    expect((el as ReactElement<Record<string, unknown>>).props.children).toBe('local');
  });
  it('image() empty alt uses title for unsupported URL', async () => {
    const renderer = await createRenderer();
    const el = imageEl(renderer, 'file:///tmp/img.png', { alt: '', title: 'Photo' });
    expect(el?.type).toBe('Text');
    expect((el as ReactElement<Record<string, unknown>>).props.children).toBe('Photo');
  });
  it('image() empty alt uses title for supported URL', async () => {
    const renderer = await createRenderer();
    const el = imageEl(renderer, 'https://a.com/1.png', { alt: '', title: 'A Title' });
    expect(el?.type).toBe('MarkdownImage');
    expect((el as ReactElement<Record<string, unknown>>).props.alt).toBe('A Title');
  });
  it('image() missing alt uses title for unsupported URL', async () => {
    const renderer = await createRenderer();
    const el = imageEl(renderer, 'file:///tmp/img.png', { title: 'A Title' });
    expect(el?.type).toBe('Text');
    expect((el as ReactElement<Record<string, unknown>>).props.children).toBe('A Title');
  });
  it('does not wrap HTML images in Text', async () => {
    const renderer = await createRenderer();
    const single: ReactNode[] = [
      renderer.text('before '),
      renderer.html('<img alt="a" src="https://x/a.png">'),
      renderer.text(' after'),
    ];
    const multiImageResult = renderer.html(
      '<img alt="a" src="https://x/a.png"> <img alt="b" src="https://y/b.png">'
    );
    const nested: ReactNode[] = [
      renderer.text('before '),
      multiImageResult,
      renderer.text(' after'),
    ];
    const laterImage: ReactNode[] = [
      renderer.text('before '),
      [renderer.strong('bold')],
      renderer.html('<img alt="a" src="https://x/a.png">'),
      renderer.text(' after'),
    ];
    for (const children of [single, nested, laterImage]) {
      expect(Array.isArray(renderer.text(children))).toBe(true);
    }
  });

  it('wraps text without images in Text', async () => {
    const renderer = await createRenderer();
    const children: ReactNode[] = [renderer.text('hello '), renderer.strong('world')];
    const result = renderer.text(children);
    expect(Array.isArray(result)).toBe(false);
    const element = result as ReactElement<{ children: ReactNode[] }>;
    expect(element.type).toBe('Text');
    expect(element.props.children).toEqual(children);
  });
  it('does not wrap HTML images from inline formatting nodes', async () => {
    const renderer = await createRenderer();
    const children: ReactNode[] = [
      renderer.text('before '),
      renderer.html('<img alt="a" src="https://x/a.png">'),
      renderer.text(' after'),
    ];
    for (const result of [
      renderer.strong(children),
      renderer.em(children),
      renderer.del(children),
    ]) {
      expect(Array.isArray(result)).toBe(true);
      expect((result as ReactNode[])[1]).toMatchObject({ type: 'MarkdownImage' });
    }
    // link() wraps image children in a Pressable with link behavior; the
    // image owns the default action, so the Pressable carries no onPress.
    const linkResult = renderer.link(children, 'https://example.com') as ReactElement<
      Record<string, unknown>
    >;
    expect(linkResult.type).toBe('Pressable');
    expect(linkResult.props.children).toEqual(children);
    expect(linkResult.props.accessibilityRole).toBe('link');
    expect(linkResult.props.onPress).toBeUndefined();
    // Ancestors must not wrap the Pressable in native Text.
    expect(Array.isArray(renderer.text([linkResult]))).toBe(true);
    expect(Array.isArray(renderer.strong([linkResult]))).toBe(true);
    expect(Array.isArray(renderer.em([linkResult]))).toBe(true);
    expect(Array.isArray(renderer.del([linkResult]))).toBe(true);
    // The linked heading carries real text, so it keeps header semantics too.
    const linkedHeading = renderer.heading([linkResult]) as ReactElement<Record<string, unknown>>;
    expect(linkedHeading.props.accessibilityRole).toBe('header');
    // html() with non-string input delegates to textOrChildren
    expect(renderer.html(children)).toMatchObject([
      { type: 'Text' },
      { type: 'MarkdownImage' },
      { type: 'Text' },
    ]);
  });
});

describe('MarkdownRenderer heading semantics', () => {
  it('heading() renders text with the header accessibility role', async () => {
    const renderer = await createRenderer();
    const element = renderer.heading('Section title') as ReactElement<Record<string, unknown>>;
    expect(element.props.accessibilityRole).toBe('header');
    expect(element.props.children).toBe('Section title');
  });

  it('heading() gives a mixed image-and-text heading the header role', async () => {
    const renderer = await createRenderer();
    const children: ReactNode[] = [
      renderer.text('before '),
      renderer.html('<img alt="a" src="https://x/a.png">'),
    ];
    const result = renderer.heading(children) as ReactElement<Record<string, unknown>>;
    expect(result.props.accessibilityRole).toBe('header');
  });

  it('heading() keeps an image-only heading pass-through', async () => {
    const renderer = await createRenderer();
    const children: ReactNode[] = [renderer.html('<img alt="a" src="https://x/a.png">')];
    const result = renderer.heading(children);
    expect(Array.isArray(result)).toBe(true);
    expect((result as ReactNode[])[0]).toMatchObject({ type: 'MarkdownImage' });
  });

  it('plain text and inline formatting keep no header role', async () => {
    const renderer = await createRenderer();
    const textElement = renderer.text('plain') as ReactElement<Record<string, unknown>>;
    const strongElement = renderer.strong('bold') as ReactElement<Record<string, unknown>>;
    expect(textElement.props.accessibilityRole).toBeUndefined();
    expect(strongElement.props.accessibilityRole).toBeUndefined();
  });
});

describe('MarkdownRenderer link interaction', () => {
  beforeEach(() => {
    vi.mocked(confirmAndOpenMarkdownLink).mockClear();
  });

  it('text links keep selection, link role, label, hint, and press handler', async () => {
    const renderer = await createRenderer();
    const element = renderer.link('click here', 'https://example.com') as ReactElement<
      Record<string, unknown>
    >;

    expect(element.type).toBe('Text');
    expect(element.props.selectable).toBe(true);
    expect(element.props.accessibilityRole).toBe('link');
    expect(element.props.accessibilityLabel).toBe('label');
    expect(element.props.accessibilityHint).toBe('hint');
    expect(element.props.accessibilityActions).toEqual([]);
    expect(typeof element.props.onPress).toBe('function');
  });

  it('a handled text-link press stays in the caller and does not open the URL', async () => {
    const { MarkdownRenderer: RendererClass } = await import('./markdown-renderer');
    const renderer = new RendererClass(palette, true, { onPressLink: () => true });
    const element = renderer.link('click here', 'https://example.com') as ReactElement<{
      onPress: () => void;
    }>;

    element.props.onPress();

    expect(confirmAndOpenMarkdownLink).not.toHaveBeenCalled();
  });

  it('an unhandled text-link press confirms and opens through the shared helper', async () => {
    const renderer = await createRenderer();
    const element = renderer.link('click here', 'https://example.com') as ReactElement<{
      onPress: () => void;
    }>;

    element.props.onPress();

    expect(confirmAndOpenMarkdownLink).toHaveBeenCalledWith('https://example.com', {
      label: 'label',
    });
  });

  it('a default long-press also confirms through the shared helper', async () => {
    const renderer = await createRenderer();
    const element = renderer.link('click here', 'https://example.com') as ReactElement<{
      onLongPress: () => void;
    }>;

    element.props.onLongPress();

    expect(confirmAndOpenMarkdownLink).toHaveBeenCalledWith('https://example.com', {
      label: 'label',
    });
  });
});

describe('MarkdownRenderer code override', () => {
  const containerStyle: Record<string, unknown> = { backgroundColor: '#f0f0f0' };

  function inner(
    element: ReactElement<Record<string, unknown>>
  ): ReactElement<Record<string, unknown>> {
    return element.props.children as ReactElement<Record<string, unknown>>;
  }

  it('wraps CodeBlock in a View that keeps the container style', async () => {
    const renderer = await createRenderer();
    const element = renderer.code('const x = 1;', 'ts', containerStyle, undefined) as ReactElement<
      Record<string, unknown>
    >;

    expect(element.type).toBe('View');
    expect((element.props as { style?: unknown }).style).toBe(containerStyle);
    expect(inner(element).type).toBe('CodeBlock');
  });

  it('normalizes the fence language before passing it to CodeBlock', async () => {
    const renderer = await createRenderer();
    const element = renderer.code(
      'const x = 1;',
      'TS extra',
      containerStyle,
      undefined
    ) as ReactElement<Record<string, unknown>>;

    expect((inner(element).props as { language?: unknown }).language).toBe('ts');
  });

  it('passes an undefined language through as null', async () => {
    const renderer = await createRenderer();
    const element = renderer.code(
      'const x = 1;',
      undefined,
      containerStyle,
      undefined
    ) as ReactElement<Record<string, unknown>>;

    expect((inner(element).props as { language?: unknown }).language).toBeNull();
  });

  it('passes the renderer selectable flag through to CodeBlock', async () => {
    const { MarkdownRenderer: RendererClass } = await import('./markdown-renderer');
    const selectable = new RendererClass(palette, true, {});
    const element = selectable.code('x', 'ts', containerStyle, undefined) as ReactElement<
      Record<string, unknown>
    >;
    expect((inner(element).props as { selectable?: unknown }).selectable).toBe(true);

    const nonSelectable = new RendererClass(palette, false, {});
    const element2 = nonSelectable.code('x', 'ts', containerStyle, undefined) as ReactElement<
      Record<string, unknown>
    >;
    expect((inner(element2).props as { selectable?: unknown }).selectable).toBe(false);
  });

  it('passes baseColor === palette.textColor for assistant and user palettes', async () => {
    const { MarkdownRenderer: RendererClass } = await import('./markdown-renderer');
    const assistant = new RendererClass(palette, true, {});
    const assistantElement = assistant.code('x', 'ts', containerStyle, undefined) as ReactElement<
      Record<string, unknown>
    >;
    expect((inner(assistantElement).props as { baseColor?: unknown }).baseColor).toBe(
      palette.textColor
    );

    const userPalette: MarkdownPalette = {
      ...palette,
      textColor: '#1A1A10',
    };
    const user = new RendererClass(userPalette, true, {});
    const userElement = user.code('x', 'ts', containerStyle, undefined) as ReactElement<
      Record<string, unknown>
    >;
    expect((inner(userElement).props as { baseColor?: unknown }).baseColor).toBe('#1A1A10');
  });

  it('passes MARKDOWN_CODE_CHARACTER_CAP as the maxLength', async () => {
    const { MARKDOWN_CODE_CHARACTER_CAP: cap } = await import('./markdown-renderer');
    const renderer = await createRenderer();
    const element = renderer.code('x', 'ts', containerStyle, undefined) as ReactElement<
      Record<string, unknown>
    >;
    expect((inner(element).props as { maxLength?: unknown }).maxLength).toBe(cap);
  });
});

describe('MarkdownRenderer empty fence mounting', () => {
  const containerStyle: Record<string, unknown> = { backgroundColor: '#f0f0f0' };

  it('mounts the real CodeBlock path for an empty fence', async () => {
    // The renderer-props suites above stub ./code-block; here the real
    // CodeBlock must render so an empty fence provably mounts end to end.
    vi.doUnmock('./code-block');
    vi.resetModules();
    const { MarkdownRenderer: RendererClass } = await import('./markdown-renderer');
    const renderer = new RendererClass(palette, true, {});
    const element = renderer.code('', 'ts', containerStyle, undefined) as ReactElement<
      Record<string, unknown>
    >;
    expect(element.type).toBe('View');

    const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
      current: undefined,
    };
    await act(async () => {
      await Promise.resolve();
      rendererRef.current = TestRenderer.create(element);
    });
    const mounted = rendererRef.current;
    if (!mounted) {
      throw new Error('renderer was not created');
    }
    // The real CodeBlock renders its mono Text with no token runs; the mount
    // itself is the regression guard for an empty fence.
    const codeTexts = mounted.root.findAll(
      node => {
        const className = propOf(node, 'className');
        return (
          typeof node.type === 'string' &&
          typeof className === 'string' &&
          className.includes('font-mono text-xs')
        );
      },
      { deep: true }
    );
    expect(codeTexts).toHaveLength(1);

    await act(async () => {
      await Promise.resolve();
      mounted.unmount();
    });
    // Restore the stubbed module graph for any dynamic import that follows.
    vi.resetModules();
  });
});

describe('MarkdownRenderer list marker alignment', () => {
  function viewChildren(node: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance[] {
    return node.children.filter(
      (child): child is TestRenderer.ReactTestInstance =>
        typeof child === 'object' && (child.type as unknown) === 'View'
    );
  }

  async function mountMarkdown(value: string) {
    const { useMarkdown } = await import('react-native-marked');
    const { getMarkdownStyles } = await import('./markdown-palette');
    const { MarkdownRenderer: RendererClass } = await import('./markdown-renderer');
    const { View: StubView } = await import('react-native');
    const renderer = new RendererClass(palette, true, {});
    const styles = getMarkdownStyles(palette);
    function Host() {
      const elements = useMarkdown(value, { styles, renderer, colorScheme: 'light' });
      return createElement(StubView, null, elements);
    }
    const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
      current: undefined,
    };
    await act(async () => {
      await Promise.resolve();
      rendererRef.current = TestRenderer.create(createElement(Host));
    });
    const mounted = rendererRef.current;
    if (!mounted) {
      throw new Error('renderer was not created');
    }
    return mounted;
  }

  async function unmountMarkdown(mounted: TestRenderer.ReactTestRenderer) {
    await act(async () => {
      await Promise.resolve();
      mounted.unmount();
    });
  }

  function assertAlignedList(mounted: TestRenderer.ReactTestRenderer, expectedItems: number) {
    const rows = mounted.root.findAll(node => propOf(node, 'testID') === 'marked-list-item');
    expect(rows).toHaveLength(expectedItems);
    for (const row of rows) {
      // Criterion 3 mechanism: the row lays the fixed-width marker box beside
      // a shrinking content View, so wrapped text indents under the text and
      // does not overlap the marker.
      expect(flattenStyle(propOf(row, 'style')).flexDirection).toBe('row');
      const contentViews = viewChildren(row);
      expect(contentViews).toHaveLength(1);
      const contentView = contentViews[0];
      if (!contentView) {
        throw new Error('list item content View missing');
      }
      expect(flattenStyle(propOf(contentView, 'style')).flexShrink).toBe(1);
    }
    const markers = mounted.root.findAll(node => propOf(node, 'testID') === 'marker-box');
    expect(markers).toHaveLength(expectedItems);
    for (const marker of markers) {
      const box = marker.parent;
      if (!box) {
        throw new Error('marker box View missing');
      }
      // No top margin on the marker box: the marker shares the row top with
      // the first text line.
      expect(flattenStyle(propOf(box, 'style'))).toEqual({ marginBottom: 4 });
      const markerStyle = flattenStyle(propOf(marker, 'style'));
      expect(markerStyle.fontSize).toBe(16);
      expect(markerStyle.lineHeight).toBe(24);
    }
  }

  function assertItemTextMetrics(mounted: TestRenderer.ReactTestRenderer, words: string[]) {
    const itemTexts = mounted.root.findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as unknown) === 'Text' &&
        Array.isArray(node.children) &&
        node.children.some(
          child => typeof child === 'string' && words.some(word => child.includes(word))
        )
    );
    expect(itemTexts).toHaveLength(words.length);
    for (const item of itemTexts) {
      const style = flattenStyle(propOf(item, 'style'));
      expect(style.fontSize).toBe(16);
      expect(style.lineHeight).toBe(24);
    }
  }

  function assertLooseParagraphMargins(mounted: TestRenderer.ReactTestRenderer) {
    const rows = mounted.root.findAll(node => propOf(node, 'testID') === 'marked-list-item');
    for (const row of rows) {
      const contentViews = viewChildren(row);
      const contentView = contentViews[0];
      if (!contentView) {
        throw new Error('list item content View missing');
      }
      const paragraphs = viewChildren(contentView);
      expect(paragraphs).toHaveLength(1);
      const paragraphStyle = flattenStyle(propOf(paragraphs[0], 'style'));
      expect(paragraphStyle.marginTop).toBe(0);
      expect(paragraphStyle.marginVertical).toBeUndefined();
      expect(paragraphStyle.marginBottom).toBe(2);
    }
  }

  it('aligns tight unordered list markers with the first line of item text', async () => {
    const mounted = await mountMarkdown('- one\n- two');
    assertAlignedList(mounted, 2);
    assertItemTextMetrics(mounted, ['one', 'two']);
    await unmountMarkdown(mounted);
  });

  it('aligns tight ordered list markers with the first line of item text', async () => {
    const mounted = await mountMarkdown('1. one\n2. two');
    assertAlignedList(mounted, 2);
    assertItemTextMetrics(mounted, ['one', 'two']);
    await unmountMarkdown(mounted);
  });

  it('aligns loose unordered list markers with the first line of item text', async () => {
    const mounted = await mountMarkdown('- one\n\n- two');
    assertAlignedList(mounted, 2);
    assertLooseParagraphMargins(mounted);
    assertItemTextMetrics(mounted, ['one', 'two']);
    await unmountMarkdown(mounted);
  });

  it('aligns loose ordered list markers with the first line of item text', async () => {
    const mounted = await mountMarkdown('1. one\n\n2. two');
    assertAlignedList(mounted, 2);
    assertLooseParagraphMargins(mounted);
    assertItemTextMetrics(mounted, ['one', 'two']);
    await unmountMarkdown(mounted);
  });

  it('keeps a leading blockquote margin in a list item', async () => {
    const mounted = await mountMarkdown('- > quoted text');
    const rows = mounted.root.findAll(node => propOf(node, 'testID') === 'marked-list-item');
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) {
      throw new Error('list item row missing');
    }
    const contentViews = viewChildren(row);
    expect(contentViews).toHaveLength(1);
    const contentView = contentViews[0];
    if (!contentView) {
      throw new Error('list item content View missing');
    }
    const blockquotes = viewChildren(contentView);
    expect(blockquotes).toHaveLength(1);
    const blockquote = blockquotes[0];
    if (!blockquote) {
      throw new Error('blockquote View missing');
    }
    const blockquoteStyle = flattenStyle(propOf(blockquote, 'style'));
    expect(blockquoteStyle.marginVertical).toBe(4);
    expect(blockquoteStyle.marginTop).toBeUndefined();
    await unmountMarkdown(mounted);
  });
});
