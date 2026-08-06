/* eslint-disable max-lines -- the renderer suite keeps key-stability, image pass-through, heading semantics, and link interaction together */
// eslint-disable-next-line import/no-nodejs-modules -- patching the CJS loader is the only way to stub react-native for the externalized react-native-marked; the library under test stays real
import Module from 'node:module';
import { type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { openExternalUrl } from '@/lib/external-link';

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
vi.mock('./markdown-image', () => ({
  MarkdownImage: 'MarkdownImage',
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
    // A mixed image-and-text heading keeps header semantics without wrapping
    // the image in native Text.
    const mixedHeading = renderer.heading(children) as ReactElement<Record<string, unknown>>;
    expect(mixedHeading.type).toBe('View');
    expect(mixedHeading.props.accessibilityRole).toBe('header');
    expect(mixedHeading.props.children).toEqual(children);
    // link() wraps image children in a Pressable with link behavior
    const linkResult = renderer.link(children, 'https://example.com') as ReactElement<
      Record<string, unknown>
    >;
    expect(linkResult.type).toBe('Pressable');
    expect(linkResult.props.children).toEqual(children);
    expect(linkResult.props.accessibilityRole).toBe('link');
    expect(typeof linkResult.props.onPress).toBe('function');
    // Ancestors must not wrap the Pressable in native Text.
    expect(Array.isArray(renderer.text([linkResult]))).toBe(true);
    expect(Array.isArray(renderer.strong([linkResult]))).toBe(true);
    expect(Array.isArray(renderer.em([linkResult]))).toBe(true);
    expect(Array.isArray(renderer.del([linkResult]))).toBe(true);
    // The linked heading carries real text, so it keeps header semantics too.
    const linkedHeading = renderer.heading([linkResult]) as ReactElement<Record<string, unknown>>;
    expect(linkedHeading.type).toBe('View');
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
    expect(element.type).toBe('Text');
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
    expect(result.type).toBe('View');
    expect(result.props.accessibilityRole).toBe('header');
    // The image stays inside the header-role wrapper (not wrapped in Text).
    expect(result.props.children).toEqual(children);
  });

  it('heading() keeps an image-only heading pass-through', async () => {
    const renderer = await createRenderer();
    const children: ReactNode[] = [renderer.html('<img alt="a" src="https://x/a.png">')];
    const result = renderer.heading(children);
    expect(Array.isArray(result)).toBe(true);
    expect((result as ReactNode[])[0]).toMatchObject({ type: 'MarkdownImage' });
  });

  it('heading() keeps a linked image-only heading pass-through', async () => {
    const renderer = await createRenderer();
    const imageChildren: ReactNode[] = [renderer.html('<img alt="a" src="https://x/a.png">')];
    const linkResult = renderer.link(imageChildren, 'https://example.com');
    const result = renderer.heading([linkResult]);
    expect(Array.isArray(result)).toBe(true);
    expect((result as ReactNode[])[0]).toMatchObject({ type: 'Pressable' });
  });

  it('heading() treats whitespace-only text around an image as image-only', async () => {
    const renderer = await createRenderer();
    const children: ReactNode[] = [
      renderer.text(' '),
      renderer.html('<img alt="a" src="https://x/a.png">'),
    ];
    const result = renderer.heading(children);
    expect(Array.isArray(result)).toBe(true);
    expect((result as ReactNode[])[1]).toMatchObject({ type: 'MarkdownImage' });
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
    vi.mocked(openExternalUrl).mockClear();
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

    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it('an unhandled text-link press opens the external URL with the resolved label', async () => {
    const renderer = await createRenderer();
    const element = renderer.link('click here', 'https://example.com') as ReactElement<{
      onPress: () => void;
    }>;

    element.props.onPress();

    expect(openExternalUrl).toHaveBeenCalledWith('https://example.com', { label: 'label' });
  });
});
