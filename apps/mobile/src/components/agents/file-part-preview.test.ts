import { describe, expect, it } from 'vitest';

import {
  getFilePartAccessibilityLabel,
  getFilePartKind,
  isMarkdownFilePart,
} from './file-part-preview';

describe('isMarkdownFilePart', () => {
  it('is true for .md and .mdx filenames', () => {
    expect(isMarkdownFilePart('README.md')).toBe(true);
    expect(isMarkdownFilePart('docs.mdx')).toBe(true);
    expect(isMarkdownFilePart('README.MD')).toBe(true);
  });

  it('is false for non-markdown filenames', () => {
    expect(isMarkdownFilePart('index.ts')).toBe(false);
    expect(isMarkdownFilePart('notes.markdown')).toBe(false);
    expect(isMarkdownFilePart('')).toBe(false);
  });

  it('is false for undefined', () => {
    expect(isMarkdownFilePart(undefined)).toBe(false);
  });
});

describe('getFilePartKind', () => {
  it('classifies image by mime regardless of filename', () => {
    expect(getFilePartKind({ mime: 'image/png', filename: 'photo.png' })).toBe('image');
    expect(getFilePartKind({ mime: 'image/jpeg' })).toBe('image');
  });

  it('classifies markdown by .md/.mdx filename when mime is not image', () => {
    expect(getFilePartKind({ mime: 'text/markdown', filename: 'README.md' })).toBe('markdown');
    expect(getFilePartKind({ mime: 'application/octet-stream', filename: 'docs.mdx' })).toBe(
      'markdown'
    );
  });

  it('classifies other when neither image nor markdown', () => {
    expect(getFilePartKind({ mime: 'text/plain', filename: 'index.ts' })).toBe('other');
    expect(getFilePartKind({ mime: 'application/pdf' })).toBe('other');
  });

  it('prefers image over markdown when mime is image and filename is markdown', () => {
    expect(getFilePartKind({ mime: 'image/svg+xml', filename: 'diagram.md' })).toBe('image');
  });
});

describe('getFilePartAccessibilityLabel', () => {
  it('labels image with full screen', () => {
    expect(getFilePartAccessibilityLabel('image', 'photo.png')).toBe('Open photo.png full screen');
  });

  it('labels markdown with preview', () => {
    expect(getFilePartAccessibilityLabel('markdown', 'README.md')).toBe('Preview README.md');
  });

  it('labels other with open', () => {
    expect(getFilePartAccessibilityLabel('other', 'index.ts')).toBe('Open index.ts');
  });

  it('falls back to File when filename is undefined', () => {
    expect(getFilePartAccessibilityLabel('image', undefined)).toBe('Open File full screen');
    expect(getFilePartAccessibilityLabel('markdown', undefined)).toBe('Preview File');
    expect(getFilePartAccessibilityLabel('other', undefined)).toBe('Open File');
  });

  it('falls back to File when filename is blank', () => {
    expect(getFilePartAccessibilityLabel('other', '')).toBe('Open File');
    expect(getFilePartAccessibilityLabel('other', '   ')).toBe('Open File');
  });
});
