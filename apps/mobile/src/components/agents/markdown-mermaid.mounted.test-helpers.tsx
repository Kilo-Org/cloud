// Shared mount and query harness for the mermaid mounted suites. This module is
// imported by the test files, whose hoisted vi.mock registrations are already in
// place when these imports evaluate; the split keeps each suite under the
// max-lines budget (same pattern as chat-composer-input-row.mounted.test-helpers).

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';

const palette = {
  textColor: '#111111',
  mutedTextColor: '#666666',
  codeBackground: '#f4f4f4',
  borderColor: '#cccccc',
};

export const otherPalette = { ...palette, codeBackground: '#101010' };

type HostProps = {
  onLoadStart?: () => void;
  onLoadEnd?: () => void;
  onMessage?: (event: { nativeEvent: { data: string } }) => void;
  style?: { height: number };
};

export const WebViewType = 'WebView' as never;
export const CodeBlockType = 'CodeBlock' as never;

// Host preparation crosses several awaits, so let the task queue drain before
// asserting what the effect settled on.
async function flush() {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  setTimeout(resolve, 0);
  await promise;
}

/** What `injectJavaScript` was called with, parsed back into render inputs. */
export function injected(injectJavaScript: { mock: { calls: unknown[][] } }): unknown[] {
  return injectJavaScript.mock.calls.map(([script]) => {
    const call = /^window\.kiloRenderDiagram\((.*)\);true;$/s.exec(String(script));
    if (call?.[1] === undefined) {
      throw new Error(`unexpected injected script: ${String(script)}`);
    }
    return JSON.parse(call[1]);
  });
}

// The prepared host promise is module state, so the suites call
// `vi.resetModules()` between cases; a static import would keep the first one.
export async function mount(source: string, theme = palette) {
  const { MarkdownMermaid } = await import('./markdown-mermaid');
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(createElement(MarkdownMermaid, { source, palette: theme }));
    await flush();
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

export async function rerender(
  renderer: TestRenderer.ReactTestRenderer,
  source: string,
  theme = palette
) {
  const { MarkdownMermaid } = await import('./markdown-mermaid');
  await act(async () => {
    renderer.update(createElement(MarkdownMermaid, { source, palette: theme }));
    await flush();
  });
}

export function countOf(root: TestRenderer.ReactTestInstance, type: never) {
  return root.findAll(node => node.type === type).length;
}

/** The rendered WebView element itself, so a case can tell a redraw from a reload. */
export function webViewInstance(root: TestRenderer.ReactTestInstance) {
  const [webView] = root.findAll(node => node.type === WebViewType);
  if (!webView) {
    throw new Error('WebView not rendered');
  }
  return webView;
}

function webViewProps(root: TestRenderer.ReactTestInstance): HostProps {
  return webViewInstance(root).props as HostProps;
}

export function containerHeight(root: TestRenderer.ReactTestInstance): number {
  const [view] = root.findAll(node => node.type === ('View' as never));
  if (!view) {
    throw new Error('container view not rendered');
  }
  return (view.props as HostProps).style?.height ?? -1;
}

/** Run the load the page reports, the point at which the diagram is drawn. */
export async function loadPage(renderer: TestRenderer.ReactTestRenderer) {
  const { onLoadStart, onLoadEnd } = webViewProps(renderer.root);
  if (!onLoadStart || !onLoadEnd) {
    throw new Error('WebView has no load handlers');
  }
  await act(async () => {
    onLoadStart();
    onLoadEnd();
    await Promise.resolve();
  });
}

export async function deliver(renderer: TestRenderer.ReactTestRenderer, data: unknown) {
  const { onMessage } = webViewProps(renderer.root);
  if (!onMessage) {
    throw new Error('WebView has no onMessage');
  }
  await act(async () => {
    onMessage({ nativeEvent: { data: JSON.stringify(data) } });
    await Promise.resolve();
  });
}
