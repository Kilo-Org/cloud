/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React trees under vitest (same pattern as src/components/agents/attachment-preview-strip.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  __resetFilePartCacheForTests,
  cacheFilePart,
  getFilePartCacheEntry,
  isUsableFilePartUrl,
  useFilePartCache,
} from '@/components/agents/file-part-cache';

beforeEach(() => {
  __resetFilePartCacheForTests();
});

describe('cacheFilePart', () => {
  it('records url, mime, and filename for a part id', () => {
    cacheFilePart('part-1', {
      url: 'https://example.com/report.pdf',
      mime: 'application/pdf',
      filename: 'report.pdf',
    });

    expect(getFilePartCacheEntry('part-1')).toEqual({
      url: 'https://example.com/report.pdf',
      mime: 'application/pdf',
      filename: 'report.pdf',
    });
  });

  it('omits filename when the payload has none', () => {
    cacheFilePart('part-img', { url: 'https://example.com/a.png', mime: 'image/png' });

    expect(getFilePartCacheEntry('part-img')).toEqual({
      url: 'https://example.com/a.png',
      mime: 'image/png',
    });
  });

  it('first write wins for a duplicate part id', () => {
    cacheFilePart('part-dup', { url: 'https://example.com/a.png', mime: 'image/png' });
    cacheFilePart('part-dup', { url: 'https://example.com/b.png', mime: 'image/png' });

    expect(getFilePartCacheEntry('part-dup')).toEqual({
      url: 'https://example.com/a.png',
      mime: 'image/png',
    });
  });
});

describe('isUsableFilePartUrl', () => {
  it('accepts http, https, and data schemes', () => {
    expect(isUsableFilePartUrl('http://example.com/a.png')).toBe(true);
    expect(isUsableFilePartUrl('https://example.com/a.png')).toBe(true);
    expect(isUsableFilePartUrl('data:image/png;base64,AAA')).toBe(true);
  });

  it('rejects file and other schemes', () => {
    expect(isUsableFilePartUrl('file:///cache/a.png')).toBe(false);
    expect(isUsableFilePartUrl('ftp://example.com/a.png')).toBe(false);
    expect(isUsableFilePartUrl('')).toBe(false);
  });
});

function Probe({ partId }: { partId: string }) {
  const entry = useFilePartCache(partId);
  return createElement('Text', null, entry?.url ?? 'none');
}

function textOf(renderer: TestRenderer.ReactTestRenderer): string | undefined {
  const node = renderer.root.find(n => typeof n.type === 'string' && n.type === 'Text');
  return node.props.children as string | undefined;
}

describe('useFilePartCache', () => {
  it('re-renders a subscriber when a new part is cached', async () => {
    const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
    await act(async () => {
      await Promise.resolve();
      ref.current = TestRenderer.create(createElement(Probe, { partId: 'p1' }));
    });
    const renderer = ref.current;
    if (!renderer) {
      throw new Error('renderer was not created');
    }

    expect(textOf(renderer)).toBe('none');

    await act(async () => {
      await Promise.resolve();
      cacheFilePart('p1', { url: 'https://example.com/a.png', mime: 'image/png' });
    });

    expect(textOf(renderer)).toBe('https://example.com/a.png');

    renderer.unmount();
  });

  it('reads the same store as getFilePartCacheEntry', () => {
    expect(typeof useFilePartCache).toBe('function');
    expect(getFilePartCacheEntry('missing')).toBeUndefined();
    cacheFilePart('part-hook', { url: 'https://example.com/a.png', mime: 'image/png' });
    expect(getFilePartCacheEntry('part-hook')?.url).toBe('https://example.com/a.png');
  });
});
