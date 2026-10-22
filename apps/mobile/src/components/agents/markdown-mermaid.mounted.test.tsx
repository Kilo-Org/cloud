import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rnStub = vi.hoisted(() => ({
  Platform: { OS: 'android', select: (values: Record<string, unknown>) => values.android },
  View: 'View',
  useColorScheme: () => 'light',
}));

// The only awaited host-preparation step is the vendored script's asset
// download, so this is what a case makes fail or succeed. `exists` is false, so
// the copy path runs on every preparation.
const hostMock = vi.hoisted(() => {
  const downloadAsync = vi.fn(async () => {
    await Promise.resolve();
  });
  const Directory = vi.fn(function DirectoryMock(_cache: unknown, name: string) {
    return { uri: `file:///cache/${name}`, create: vi.fn() };
  });
  const File = vi.fn(function FileMock(parent: unknown, name: string) {
    const base = typeof parent === 'string' ? parent : 'file:///cache';
    return {
      uri: `${base}/${name}`,
      exists: false,
      write: vi.fn(),
      copy: vi.fn(async () => {
        await Promise.resolve();
      }),
    };
  });
  return { downloadAsync, Directory, File };
});

vi.mock('react-native', () => rnStub);
vi.mock('react-native-webview', () => ({ WebView: 'WebView' }));
vi.mock('./code-block', () => ({ CodeBlock: 'CodeBlock' }));
vi.mock('expo-asset', () => ({
  Asset: {
    fromModule: () => ({
      downloadAsync: hostMock.downloadAsync,
      uri: 'asset://mermaid.js',
      localUri: 'asset://mermaid.js',
    }),
  },
}));
vi.mock('expo-file-system', () => ({
  Directory: hostMock.Directory,
  File: hostMock.File,
  Paths: { cache: 'file:///cache' },
}));

const palette = {
  textColor: '#111111',
  mutedTextColor: '#666666',
  codeBackground: '#f4f4f4',
  borderColor: '#cccccc',
};

type HostProps = {
  injectedJavaScript?: string;
  onMessage?: (event: { nativeEvent: { data: string } }) => void;
  style?: { height: number };
};

const WebViewType = 'WebView' as never;
const CodeBlockType = 'CodeBlock' as never;
const ViewType = 'View' as never;

// Host preparation crosses several awaits, so let the task queue drain before
// asserting what the effect settled on.
async function flush() {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  setTimeout(resolve, 0);
  await promise;
}

// The prepared host promise is module state, so `vi.resetModules()` must give
// each case a fresh module graph; a static import would keep the first one.
async function mount(source: string) {
  const { MarkdownMermaid } = await import('./markdown-mermaid');
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(createElement(MarkdownMermaid, { source, palette }));
    await flush();
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function countOf(root: TestRenderer.ReactTestInstance, type: never) {
  return root.findAll(node => node.type === type).length;
}

function webViewProps(root: TestRenderer.ReactTestInstance): HostProps {
  const [webView] = root.findAll(node => node.type === WebViewType);
  if (!webView) {
    throw new Error('WebView not rendered');
  }
  return webView.props as HostProps;
}

function containerHeight(root: TestRenderer.ReactTestInstance): number {
  const [view] = root.findAll(node => node.type === ViewType);
  if (!view) {
    throw new Error('container view not rendered');
  }
  return (view.props as HostProps).style?.height ?? -1;
}

async function deliver(renderer: TestRenderer.ReactTestRenderer, data: unknown) {
  const { onMessage } = webViewProps(renderer.root);
  if (!onMessage) {
    throw new Error('WebView has no onMessage');
  }
  await act(async () => {
    onMessage({ nativeEvent: { data: JSON.stringify(data) } });
    await Promise.resolve();
  });
}

async function rerender(renderer: TestRenderer.ReactTestRenderer, source: string) {
  const { MarkdownMermaid } = await import('./markdown-mermaid');
  await act(async () => {
    renderer.update(createElement(MarkdownMermaid, { source, palette }));
    await flush();
  });
}

beforeEach(() => {
  // The prepared host is module state, so each case starts from a clean module
  // graph; otherwise an earlier case's host would answer this one's load.
  vi.resetModules();
  hostMock.downloadAsync.mockReset();
  hostMock.downloadAsync.mockImplementation(async () => {
    await Promise.resolve();
  });
});

describe('MarkdownMermaid source changes', () => {
  it('renders the new source again after the previous diagram failed', async () => {
    const renderer = await mount('flowchart TD\n  a --> b');
    expect(countOf(renderer.root, WebViewType)).toBe(1);
    expect(countOf(renderer.root, CodeBlockType)).toBe(0);

    await deliver(renderer, { kind: 'error' });
    expect(countOf(renderer.root, WebViewType)).toBe(0);
    expect(countOf(renderer.root, CodeBlockType)).toBe(1);

    await rerender(renderer, 'flowchart TD\n  c --> d');
    expect(countOf(renderer.root, CodeBlockType)).toBe(0);
    expect(countOf(renderer.root, WebViewType)).toBe(1);
    expect(webViewProps(renderer.root).injectedJavaScript).toContain('c --> d');
    expect(webViewProps(renderer.root).injectedJavaScript).not.toContain('a --> b');

    act(() => {
      renderer.unmount();
    });
  });

  it('drops the failed diagram height when the source changes', async () => {
    const renderer = await mount('flowchart TD\n  a --> b');
    await deliver(renderer, { kind: 'height', height: 320 });
    expect(containerHeight(renderer.root)).toBe(320);

    await rerender(renderer, 'flowchart TD\n  c --> d');
    expect(containerHeight(renderer.root)).toBe(48);

    act(() => {
      renderer.unmount();
    });
  });

  it('retries a failed host copy for the new source', async () => {
    hostMock.downloadAsync.mockRejectedValueOnce(new Error('copy failed'));
    const renderer = await mount('flowchart TD\n  a --> b');
    expect(countOf(renderer.root, CodeBlockType)).toBe(1);
    expect(countOf(renderer.root, WebViewType)).toBe(0);

    await rerender(renderer, 'flowchart TD\n  c --> d');
    expect(countOf(renderer.root, WebViewType)).toBe(1);
    expect(countOf(renderer.root, CodeBlockType)).toBe(0);
    expect(hostMock.downloadAsync).toHaveBeenCalledTimes(2);

    act(() => {
      renderer.unmount();
    });
  });

  it('ignores a page failure the superseded diagram reports late', async () => {
    const renderer = await mount('flowchart TD\n  a --> b');
    const { onMessage } = webViewProps(renderer.root);
    if (!onMessage) {
      throw new Error('WebView has no onMessage');
    }

    await rerender(renderer, 'flowchart TD\n  c --> d');
    // The unmounted page can still deliver a message it sent before the new
    // source replaced it; it must not hide the diagram that is now mounted.
    await act(async () => {
      onMessage({ nativeEvent: { data: JSON.stringify({ kind: 'error' }) } });
      await Promise.resolve();
    });

    expect(countOf(renderer.root, WebViewType)).toBe(1);
    expect(countOf(renderer.root, CodeBlockType)).toBe(0);

    act(() => {
      renderer.unmount();
    });
  });
});
