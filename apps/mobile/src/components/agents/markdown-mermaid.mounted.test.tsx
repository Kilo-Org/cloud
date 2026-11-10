import { createElement, forwardRef, useImperativeHandle } from 'react';
import { act } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  containerHeight,
  countOf,
  deliver,
  injected,
  loadPage,
  mount,
  otherPalette,
  rerender,
  webViewInstance,
  WebViewType,
} from './markdown-mermaid.mounted.test-helpers';

const rnStub = vi.hoisted(() => ({
  Platform: { OS: 'android', select: (values: Record<string, unknown>) => values.android },
  View: 'View',
  // Mutable so a case can flip the color scheme under a mounted diagram.
  scheme: { current: 'light' as 'light' | 'dark' },
  useColorScheme: () => rnStub.scheme.current,
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

// The imperative surface the component draws a diagram through. Every call is
// recorded so a case can see how many times the page was asked to render.
const webViewMock = vi.hoisted(() => ({ injectJavaScript: vi.fn() }));

vi.mock('react-native', () => rnStub);
vi.mock('react-native-webview', () => {
  const WebView = forwardRef(function WebViewMock(props: Record<string, unknown>, ref: unknown) {
    useImperativeHandle(
      ref as never,
      () => ({ injectJavaScript: webViewMock.injectJavaScript }),
      []
    );
    return createElement('WebView', props);
  });
  return { WebView };
});
vi.mock('./markdown-code-fence', () => ({ MarkdownCodeFence: 'MarkdownCodeFence' }));
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

beforeEach(() => {
  // The prepared host is module state, so each case starts from a clean module
  // graph; otherwise an earlier case's host would answer this one's load.
  vi.resetModules();
  hostMock.downloadAsync.mockReset();
  hostMock.downloadAsync.mockImplementation(async () => {
    await Promise.resolve();
  });
  webViewMock.injectJavaScript.mockReset();
  rnStub.scheme.current = 'light';
});

describe('MarkdownMermaid page rendering', () => {
  it('draws the diagram once the page has loaded', async () => {
    const renderer = await mount('flowchart TD\n  a --> b');
    expect(countOf(renderer.root, WebViewType)).toBe(1);
    // Nothing is injected into a page that has not loaded: the script the page
    // needs may not be there yet.
    expect(webViewMock.injectJavaScript).not.toHaveBeenCalled();

    await loadPage(renderer);
    expect(injected(webViewMock.injectJavaScript)).toEqual([
      { source: 'flowchart TD\n  a --> b', dark: false, background: '#f4f4f4' },
    ]);

    act(() => {
      renderer.unmount();
    });
  });

  it('redraws in place when the color scheme changes', async () => {
    // Regression: the page was keyed on the diagram source, the resolved dark
    // flag and the palette, so a theme change replaced the WebView and reloaded
    // the page — reading the 2.7 MB vendored script again for every flip.
    const renderer = await mount('flowchart TD\n  a --> b');
    await loadPage(renderer);
    const before = webViewInstance(renderer.root);
    webViewMock.injectJavaScript.mockReset();

    rnStub.scheme.current = 'dark';
    await rerender(renderer, 'flowchart TD\n  a --> b');

    expect(webViewInstance(renderer.root)).toBe(before);
    expect(injected(webViewMock.injectJavaScript)).toEqual([
      { source: 'flowchart TD\n  a --> b', dark: true, background: '#f4f4f4' },
    ]);

    act(() => {
      renderer.unmount();
    });
  });

  it('redraws in place when the palette changes', async () => {
    const renderer = await mount('flowchart TD\n  a --> b');
    await loadPage(renderer);
    const before = webViewInstance(renderer.root);
    webViewMock.injectJavaScript.mockReset();

    await rerender(renderer, 'flowchart TD\n  a --> b', otherPalette);

    expect(webViewInstance(renderer.root)).toBe(before);
    expect(injected(webViewMock.injectJavaScript)).toEqual([
      { source: 'flowchart TD\n  a --> b', dark: false, background: '#101010' },
    ]);

    act(() => {
      renderer.unmount();
    });
  });

  it('reloads the page for a new diagram', async () => {
    const renderer = await mount('flowchart TD\n  a --> b');
    await loadPage(renderer);
    const before = webViewInstance(renderer.root);

    await rerender(renderer, 'flowchart TD\n  c --> d');

    expect(webViewInstance(renderer.root)).not.toBe(before);
    await loadPage(renderer);
    expect(injected(webViewMock.injectJavaScript).at(-1)).toEqual({
      source: 'flowchart TD\n  c --> d',
      dark: false,
      background: '#f4f4f4',
    });

    act(() => {
      renderer.unmount();
    });
  });

  it('draws the current colors when the theme changes during a page load', async () => {
    const renderer = await mount('flowchart TD\n  a --> b');
    rnStub.scheme.current = 'dark';
    await rerender(renderer, 'flowchart TD\n  a --> b');
    // A color change is not injected into a page that has not loaded.
    expect(webViewMock.injectJavaScript).not.toHaveBeenCalled();

    await loadPage(renderer);
    expect(injected(webViewMock.injectJavaScript)).toEqual([
      { source: 'flowchart TD\n  a --> b', dark: true, background: '#f4f4f4' },
    ]);

    act(() => {
      renderer.unmount();
    });
  });

  it('does not inject into a page loading for a source it saw before', async () => {
    // A recycled row can hand the previous diagram back. The page for it is
    // loading, so the loaded-page record must not survive the change.
    const renderer = await mount('flowchart TD\n  a --> b');
    await loadPage(renderer);
    await rerender(renderer, 'flowchart TD\n  c --> d');
    webViewMock.injectJavaScript.mockReset();

    rnStub.scheme.current = 'dark';
    await rerender(renderer, 'flowchart TD\n  a --> b');
    expect(webViewMock.injectJavaScript).not.toHaveBeenCalled();

    await loadPage(renderer);
    expect(injected(webViewMock.injectJavaScript)).toEqual([
      { source: 'flowchart TD\n  a --> b', dark: true, background: '#f4f4f4' },
    ]);

    act(() => {
      renderer.unmount();
    });
  });

  it('ignores a height a superseded diagram reports', async () => {
    const renderer = await mount('flowchart TD\n  a --> b');
    await loadPage(renderer);
    await rerender(renderer, 'flowchart TD\n  c --> d');

    // The page can still deliver the height of the diagram it drew before the
    // app replaced the source; it must not size the new one.
    await deliver(renderer, { kind: 'height', height: 300, source: 'flowchart TD\n  a --> b' });
    expect(containerHeight(renderer.root)).toBe(48);

    await deliver(renderer, { kind: 'height', height: 220, source: 'flowchart TD\n  c --> d' });
    expect(containerHeight(renderer.root)).toBe(220);

    act(() => {
      renderer.unmount();
    });
  });
});
