import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildMarkdownImageHeaders,
  clearMarkdownImageSrcMemory,
  MEDIA_SOURCE_HEADER,
  refreshMarkdownImageSrc,
  resolveMarkdownImageSrc,
} from './markdown-image-src';

vi.mock('@/lib/config', () => ({ API_BASE_URL: 'https://api.test' }));

beforeEach(() => {
  clearMarkdownImageSrcMemory();
});

describe('resolveMarkdownImageSrc', () => {
  it('points at the media proxy on the API base', () => {
    expect(resolveMarkdownImageSrc('https://cdn.example.com/a.png')).toBe(
      'https://api.test/api/media/proxy?id=m0'
    );
  });

  it('keeps the source URL out of the proxy URL', () => {
    const uri = 'https://cdn.example.com/a.png?signature=secret';
    expect(resolveMarkdownImageSrc(uri)).not.toContain('cdn.example.com');
    expect(resolveMarkdownImageSrc(uri)).not.toContain('secret');
  });

  it('returns a stable URI for the same source', () => {
    const uri = 'https://cdn.example.com/a.png';
    expect(resolveMarkdownImageSrc(uri)).toBe(resolveMarkdownImageSrc(uri));
  });

  it('returns a different URI for a different source', () => {
    expect(resolveMarkdownImageSrc('https://cdn.example.com/a.png')).not.toBe(
      resolveMarkdownImageSrc('https://cdn.example.com/b.png')
    );
  });

  it('issues a fresh URI after a refresh so a cached failure is not replayed', () => {
    const uri = 'https://cdn.example.com/a.png';
    const first = resolveMarkdownImageSrc(uri);
    refreshMarkdownImageSrc(uri);
    expect(resolveMarkdownImageSrc(uri)).not.toBe(first);
  });
});

describe('buildMarkdownImageHeaders', () => {
  it('carries the bearer token and the source URL', () => {
    expect(buildMarkdownImageHeaders('abc', 'https://cdn.example.com/a.png')).toEqual({
      Authorization: 'Bearer abc',
      [MEDIA_SOURCE_HEADER]: 'https://cdn.example.com/a.png',
    });
  });
});
