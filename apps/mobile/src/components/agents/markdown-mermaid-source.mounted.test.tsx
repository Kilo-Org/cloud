import { createElement, forwardRef, useImperativeHandle } from 'react';
import { act } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CodeBlockType,
  containerHeight,
  countOf,
  deliver,
  injected,
  loadPage,
  mount,
  rerender,
  WebViewType,
} from './markdown-mermaid.mounted.test-helpers';

// The host-preparation step a case makes fail or succeed; see
// `markdown-mermaid.mounted.test.tsx` for the same harness and why `exists` is
// false everywhere.
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

const webViewMock = vi.hoisted(() => ({ injectJavaScript: vi.fn() }));

vi.mock('react-native', () => ({
  Platform: { OS: 'android', select: (values: Record<string, unknown>) => values.android },
  View: 'View',
  useColorScheme: () => 'light',
}));
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

beforeEach(() => {
  vi.resetModules();
  hostMock.downloadAsync.mockReset();
  hostMock.downloadAsync.mockImplementation(async () => {
    await Promise.resolve();
  });
  webViewMock.injectJavaScript.mockReset();
});

describe('MarkdownMermaid source changes', () => {
  it('renders the new source again after the previous diagram failed', async () => {
    const renderer = await mount('flowchart TD\n  a --> b');
    expect(countOf(renderer.root, WebViewType)).toBe(1);
    expect(countOf(renderer.root, CodeBlockType)).toBe(0);
    await loadPage(renderer);

    await deliver(renderer, { kind: 'error', source: 'flowchart TD\n  a --> b' });
    expect(countOf(renderer.root, WebViewType)).toBe(0);
    expect(countOf(renderer.root, CodeBlockType)).toBe(1);

    await rerender(renderer, 'flowchart TD\n  c --> d');
    expect(countOf(renderer.root, CodeBlockType)).toBe(0);
    expect(countOf(renderer.root, WebViewType)).toBe(1);
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

  it('drops the failed diagram height when the source changes', async () => {
    const renderer = await mount('flowchart TD\n  a --> b');
    await loadPage(renderer);
    await deliver(renderer, { kind: 'height', height: 320, source: 'flowchart TD\n  a --> b' });
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
    await loadPage(renderer);

    await rerender(renderer, 'flowchart TD\n  c --> d');
    // The page can still deliver a failure from the diagram the app replaced;
    // it must not hide the diagram that is now wanted.
    await deliver(renderer, { kind: 'error', source: 'flowchart TD\n  a --> b' });

    expect(countOf(renderer.root, WebViewType)).toBe(1);
    expect(countOf(renderer.root, CodeBlockType)).toBe(0);

    act(() => {
      renderer.unmount();
    });
  });

  it('renders a source again after an intermediate source replaced it', async () => {
    const renderer = await mount('flowchart TD\n  a --> b');
    await loadPage(renderer);
    await deliver(renderer, { kind: 'error', source: 'flowchart TD\n  a --> b' });
    expect(countOf(renderer.root, CodeBlockType)).toBe(1);

    await rerender(renderer, 'flowchart TD\n  c --> d');
    await rerender(renderer, 'flowchart TD\n  a --> b');

    expect(countOf(renderer.root, CodeBlockType)).toBe(0);
    expect(countOf(renderer.root, WebViewType)).toBe(1);
    await loadPage(renderer);
    expect(injected(webViewMock.injectJavaScript).at(-1)).toEqual({
      source: 'flowchart TD\n  a --> b',
      dark: false,
      background: '#f4f4f4',
    });

    act(() => {
      renderer.unmount();
    });
  });
});
