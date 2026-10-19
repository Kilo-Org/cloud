import { describe, expect, it } from 'vitest';
import { isPreviewReservedPath, previewReturnPath } from './return-path.js';

describe('previewReturnPath', () => {
  it('keeps a path, its query and its fragment', () => {
    expect(previewReturnPath('/')).toBe('/');
    expect(previewReturnPath('/app/page?tab=2#top')).toBe('/app/page?tab=2#top');
  });

  it('lands on / without a value', () => {
    expect(previewReturnPath(null)).toBe('/');
    expect(previewReturnPath('')).toBe('/');
  });

  it.each([
    ['protocol-relative host', '//evil.example/path'],
    ['backslash host', '/\\evil.example'],
    ['backslash anywhere', '/a\\b'],
    ['absolute URL', 'https://evil.example/'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['relative path', 'app/page'],
    ['tab before a host', '/\t/evil.example'],
    ['newline', '/a\nb'],
    ['null byte', '/a\u0000b'],
    ['delete character', '/a\u007fb'],
    ['over-length path', `/${'a'.repeat(2_048)}`],
    ['preview hop path', '/.kilo-preview/enter?ticket=x'],
    ['preview hop path after dot segments', '/a/../.kilo-preview/enter'],
    ['dot segments resolving to a double-slash path', '/a/..//evil.example'],
    ['single dot resolving to a double-slash path', '/.//evil.example'],
    ['encoded dot resolving to a double-slash path', '/%2e//evil.example'],
  ])('lands on / for a %s', (_name, raw) => {
    expect(previewReturnPath(raw)).toBe('/');
  });

  it('keeps a path at the length limit', () => {
    const path = `/${'a'.repeat(2_047)}`;
    expect(previewReturnPath(path)).toBe(path);
  });

  it('keeps a path whose dot segments normalize inside one slash', () => {
    expect(previewReturnPath('/a/../b')).toBe('/b');
  });
});

describe('isPreviewReservedPath', () => {
  it('matches the prefix and its children only', () => {
    expect(isPreviewReservedPath('/.kilo-preview')).toBe(true);
    expect(isPreviewReservedPath('/.kilo-preview/enter')).toBe(true);
    expect(isPreviewReservedPath('/.kilo-previewer')).toBe(false);
    expect(isPreviewReservedPath('/')).toBe(false);
  });
});
