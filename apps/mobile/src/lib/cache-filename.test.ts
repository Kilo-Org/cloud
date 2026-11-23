import { describe, expect, it } from 'vitest';

import { boundFilenameSegment, getExtension, MAX_CACHE_FILENAME_BYTES } from './cache-filename';
import { utf8ByteLength } from './utf8-utils';

describe('boundFilenameSegment', () => {
  it('leaves a name already inside the budget unchanged', () => {
    expect(boundFilenameSegment('holiday-photo.jpg', MAX_CACHE_FILENAME_BYTES)).toBe(
      'holiday-photo.jpg'
    );
  });

  it('keeps the extension of a long multi-byte name and never splits a code point', () => {
    // 1333 × 3 bytes + 4 bytes for '.pdf' = 4003 bytes.
    const longName = `${'写'.repeat(1333)}.pdf`;

    const result = boundFilenameSegment(longName, MAX_CACHE_FILENAME_BYTES);

    expect(utf8ByteLength(result)).toBeLessThanOrEqual(MAX_CACHE_FILENAME_BYTES);
    expect(result.endsWith('.pdf')).toBe(true);
    // A cut through a code point re-encodes longer than the count the helper
    // measures, so an equal byte length proves every character survived whole.
    expect(new TextEncoder().encode(result).byteLength).toBe(utf8ByteLength(result));
    expect(result).toBe(`${'写'.repeat(83)}.pdf`);
  });

  it('cuts a name with no extension to the byte budget', () => {
    const result = boundFilenameSegment('a'.repeat(400), 100);

    expect(result).toBe('a'.repeat(100));
    expect(utf8ByteLength(result)).toBe(100);
  });

  it('truncates the whole name when the extension alone exceeds the budget', () => {
    const result = boundFilenameSegment(`a.${'x'.repeat(300)}`, 50);

    expect(utf8ByteLength(result)).toBeLessThanOrEqual(50);
    expect(result).toBe(`a.${'x'.repeat(48)}`);
  });

  it('returns the empty string for a non-positive budget', () => {
    expect(boundFilenameSegment('a.txt', 0)).toBe('');
    expect(boundFilenameSegment('a.txt', -10)).toBe('');
  });
});

describe('getExtension', () => {
  it('reads the last extension of a name with several dots', () => {
    expect(getExtension('a.b.pdf')).toBe('.pdf');
  });

  it('ignores a leading dot', () => {
    expect(getExtension('.env')).toBe('');
  });

  it('ignores a name without a dot', () => {
    expect(getExtension('noext')).toBe('');
  });

  it('ignores a trailing dot', () => {
    expect(getExtension('trailing.')).toBe('');
  });
});
