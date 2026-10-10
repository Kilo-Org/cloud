import React from 'react';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';
import { createRequire } from 'node:module';

jest.mock('react-markdown', () =>
  process.getBuiltinModule('module').createRequire(__filename)('react-markdown')
);
jest.mock('remark-gfm', () =>
  process.getBuiltinModule('module').createRequire(__filename)('remark-gfm')
);

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  createMarkdownParseCache,
  createMarkdownParseCachePlugin,
  MarkdownParseCacheProvider,
  useMarkdownParseCache,
  type MarkdownParseCache,
  type MarkdownParseTree,
  type MarkdownRemarkPlugin,
} from './markdown-parse-cache';
import { PartRenderer } from './PartRenderer';
import { ToolMarkdown } from './ToolOutput';
import type { TextPart } from './types';

Object.assign(globalThis, { React });

type ParserCalls = { count: number };

function createCountingPlugin(calls: ParserCalls): MarkdownRemarkPlugin {
  return function countingPlugin(this: ThisParameterType<MarkdownRemarkPlugin>) {
    const parser = this.parser;
    if (!parser) return;
    this.parser = (document, file) => {
      calls.count += 1;
      return parser(document, file);
    };
  };
}

function createMutationPlugin(): MarkdownRemarkPlugin {
  return function mutationPlugin(this: ThisParameterType<MarkdownRemarkPlugin>) {
    return function (tree: MarkdownParseTree) {
      tree.data = { mutated: true };
    };
  };
}

function parseNode(type: string): MarkdownParseTree {
  return { type };
}

function cachedRender(
  source: string,
  cache: MarkdownParseCache,
  calls: ParserCalls,
  extra: MarkdownRemarkPlugin[] = []
): string {
  return renderToStaticMarkup(
    React.createElement(
      ReactMarkdown,
      {
        remarkPlugins: [
          remarkGfm,
          createCountingPlugin(calls),
          createMarkdownParseCachePlugin(cache),
          ...extra,
        ],
      },
      source
    )
  );
}

function uncachedRender(source: string): string {
  return renderToStaticMarkup(
    React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, source)
  );
}

describe('createMarkdownParseCache', () => {
  it('evicts the least recently used entry once the count bound is exceeded', () => {
    const cache = createMarkdownParseCache({ maxEntries: 2, maxSourceUnits: 100 });
    cache.set('a', parseNode('a'));
    cache.set('b', parseNode('b'));
    cache.get('a');
    cache.set('c', parseNode('c'));

    expect(cache.get('a')?.type).toBe('a');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')?.type).toBe('c');
    expect(cache.size).toBe(2);
  });

  it('evicts oldest entries until the source budget is satisfied', () => {
    const cache = createMarkdownParseCache({ maxEntries: 10, maxSourceUnits: 10 });
    cache.set('aaaa', parseNode('a'));
    cache.set('bbbb', parseNode('b'));
    expect(cache.sourceUnits).toBe(8);
    cache.set('cccc', parseNode('c'));

    expect(cache.get('aaaa')).toBeUndefined();
    expect(cache.get('bbbb')?.type).toBe('b');
    expect(cache.get('cccc')?.type).toBe('c');
    expect(cache.sourceUnits).toBe(8);
  });

  it('bypasses an oversized source without evicting existing entries', () => {
    const cache = createMarkdownParseCache({ maxEntries: 8, maxSourceUnits: 10 });
    cache.set('small', parseNode('kept'));
    cache.set('this source is far too long', parseNode('oversized'));

    expect(cache.get('this source is far too long')).toBeUndefined();
    expect(cache.get('small')?.type).toBe('kept');
    expect(cache.size).toBe(1);
  });

  it('clears every entry and the tracked source volume', () => {
    const cache = createMarkdownParseCache({ maxEntries: 8, maxSourceUnits: 100 });
    cache.set('a', parseNode('a'));
    cache.set('b', parseNode('b'));
    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.sourceUnits).toBe(0);
  });
});

describe('markdown parse cache plugin with the real remark parser', () => {
  it('does not clone oversized input or disturb retained entries', () => {
    const cache = createMarkdownParseCache({ maxEntries: 8, maxSourceUnits: 10 });
    const calls: ParserCalls = { count: 0 };
    cachedRender('small', cache, calls);
    const clone = jest.spyOn(globalThis, 'structuredClone');
    try {
      const source = 'this source is too large for the cache';
      expect(cachedRender(source, cache, calls)).toBe(uncachedRender(source));
      expect(clone).not.toHaveBeenCalled();
      expect(cache.get('small')).toBeDefined();
      expect(cache.size).toBe(1);
    } finally {
      clone.mockRestore();
    }
  });

  it('falls back to parsing when a cached tree cannot be cloned', () => {
    const cache = createMarkdownParseCache();
    const calls: ParserCalls = { count: 0 };
    const source = '**clone fallback**';
    const baseline = uncachedRender(source);
    cachedRender(source, cache, calls);
    const clone = jest.spyOn(globalThis, 'structuredClone').mockImplementation(() => {
      throw new Error('Clone unavailable');
    });
    try {
      expect(cachedRender(source, cache, calls)).toBe(baseline);
      expect(calls.count).toBe(2);
      expect(cache.size).toBe(1);
    } finally {
      clone.mockRestore();
    }
  });

  it('reuses the cached parse on a repeat render without touching the original parser', () => {
    const cache = createMarkdownParseCache();
    const calls: ParserCalls = { count: 0 };
    const source =
      '| A | B |\n| - | - |\n| ~~old~~ | new |\n\n- [x] done\n\nA note[^1]\n\n[^1]: note';

    const miss = cachedRender(source, cache, calls);
    expect(calls.count).toBe(1);
    expect(cache.size).toBe(1);

    const hit = cachedRender(source, cache, calls);
    expect(calls.count).toBe(1);
    expect(hit).toBe(miss);
    expect(hit).toBe(uncachedRender(source));
  });

  it.each([
    ['tables', '| A | B |\n| - | - |\n| 1 | 2 |'],
    ['task lists', '- [x] done\n- [ ] todo'],
    ['strikethrough', '~~removed~~ kept'],
    ['footnotes', 'Text with a note[^1]\n\n[^1]: The note.'],
    ['reference links', 'See [docs][ref].\n\n[ref]: https://example.com/docs'],
    ['fenced code', '```sh\nprintf "<tag>"\npwd\n```'],
    ['raw html', '<span>raw</span>\n<img src=x onerror=alert(1)>'],
    ['unsafe urls', '[unsafe](javascript:alert(1))\n\n[safe](https://example.com/docs)'],
  ])('renders %s identically to an uncached parse on miss and hit', (_name, source) => {
    const cache = createMarkdownParseCache();
    const calls: ParserCalls = { count: 0 };

    const miss = cachedRender(source, cache, calls);
    const hit = cachedRender(source, cache, calls);
    const baseline = uncachedRender(source);

    expect(miss).toBe(baseline);
    expect(hit).toBe(baseline);
    expect(calls.count).toBe(1);
  });

  it('snapshots the pristine parse and isolates the cached tree from later mutations', () => {
    const cache = createMarkdownParseCache();
    const calls: ParserCalls = { count: 0 };
    const source = 'pristine markdown body';

    cachedRender(source, cache, calls, [createMutationPlugin()]);
    expect(cache.get(source)?.data).toBeUndefined();

    cachedRender(source, cache, calls, [createMutationPlugin()]);
    expect(cache.get(source)?.data).toBeUndefined();
    expect(calls.count).toBe(1);
  });
});

function textPart(text: string, streaming: boolean): TextPart {
  return {
    id: 'text-1',
    sessionID: 'ses-1',
    messageID: 'msg-1',
    type: 'text',
    text,
    time: streaming ? { start: 1 } : { start: 1, end: 2 },
  };
}

function installDom() {
  const requireFromHere = createRequire(__filename);
  const requireFromNext = createRequire(requireFromHere.resolve('next/package.json'));
  const { window, document } = (
    requireFromNext('linkedom') as {
      parseHTML: (html: string) => { window: Record<string, unknown>; document: Document };
    }
  ).parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  const values = {
    React,
    window,
    document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    getComputedStyle: () => ({ animationName: 'none', display: 'block' }),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    cancelAnimationFrame: () => undefined,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(values).map(name => [name, globals[name]]));
  Object.assign(globals, values);
  const container = document.getElementById('root');
  if (!container) throw new Error('markdown cache test root missing');
  return {
    container,
    cleanup: () => previous.forEach((value, name) => (globals[name] = value)),
  };
}

let capturedCache: MarkdownParseCache | null = null;

function CacheProbe() {
  capturedCache = useMarkdownParseCache();
  return null;
}

describe('markdown parse cache lifecycle', () => {
  let root: Root;
  let cleanup: () => void;
  let disposed = false;

  beforeEach(() => {
    const dom = installDom();
    cleanup = dom.cleanup;
    root = createRoot(dom.container);
    capturedCache = null;
    disposed = false;
  });

  afterEach(() => {
    if (!disposed) act(() => root.unmount());
    cleanup();
    capturedCache = null;
  });

  it.each(['text', 'tool'])('reuses a completed %s parse across child remounts', kind => {
    const source = '**remounted markdown**';
    const element = (key: string) =>
      React.createElement(
        MarkdownParseCacheProvider,
        null,
        React.createElement(CacheProbe),
        kind === 'text'
          ? React.createElement(PartRenderer, {
              key,
              part: textPart(source, false),
              isStreaming: false,
            })
          : React.createElement(ToolMarkdown, { key, content: source })
      );

    act(() => root.render(element('first')));
    const cache = capturedCache;
    if (!cache) throw new Error('Markdown cache missing');
    const read = jest.spyOn(cache, 'get');
    const admit = jest.spyOn(cache, 'set');
    try {
      act(() => root.render(element('second')));
      expect(capturedCache).toBe(cache);
      expect(read).toHaveBeenCalledWith(source);
      expect(admit).not.toHaveBeenCalled();
      expect(cache.size).toBe(1);
    } finally {
      read.mockRestore();
      admit.mockRestore();
    }
  });

  it('does not retain streamed text but admits the same text once streaming completes', () => {
    const text = 'streaming **markdown** body';
    const element = (streaming: boolean) =>
      React.createElement(
        MarkdownParseCacheProvider,
        null,
        React.createElement(CacheProbe),
        React.createElement(PartRenderer, {
          part: textPart(text, streaming),
          isStreaming: streaming,
        })
      );

    act(() => root.render(element(true)));
    const cache = capturedCache;
    expect(cache).not.toBeNull();
    expect(cache?.size).toBe(0);

    act(() => root.render(element(false)));
    expect(capturedCache).toBe(cache);
    expect(cache?.size).toBe(1);

    act(() => root.render(element(false)));
    expect(cache?.size).toBe(1);
  });

  it('does not retain streaming tool markdown but admits it once streaming completes', () => {
    const content = '```sh\npnpm test\n```\n\nresult';
    const element = (streaming: boolean) =>
      React.createElement(
        MarkdownParseCacheProvider,
        null,
        React.createElement(CacheProbe),
        React.createElement(ToolMarkdown, { content, streaming })
      );

    act(() => root.render(element(true)));
    const cache = capturedCache;
    expect(cache?.size).toBe(0);

    act(() => root.render(element(false)));
    expect(cache?.size).toBe(1);

    act(() => root.render(element(false)));
    expect(cache?.size).toBe(1);
  });

  it('gives each provider instance its own cache and clears it on disposal', () => {
    const element = (key: string, text: string) =>
      React.createElement(MarkdownParseCacheProvider, {
        key,
        children: [
          React.createElement(CacheProbe, { key: 'probe' }),
          React.createElement(PartRenderer, {
            key: 'part',
            part: textPart(text, false),
            isStreaming: false,
          }),
        ],
      });

    act(() => root.render(element('first', 'first body')));
    const first = capturedCache;
    expect(first?.size).toBe(1);

    act(() => root.render(element('second', 'second body')));
    const second = capturedCache;
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(first?.size).toBe(0);
    expect(second?.size).toBe(1);

    const retained = second;
    act(() => root.unmount());
    disposed = true;
    expect(retained?.size).toBe(0);
  });
});
