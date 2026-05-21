import { describe, expect, it } from 'vitest';

import { formatFileSize } from '../src';

describe('formatFileSize', () => {
  it('formats bytes without decimal places', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(1023)).toBe('1023 B');
  });

  it('formats kilobytes with up to two decimal places', () => {
    expect(formatFileSize(1024)).toBe('1 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
  });

  it('formats megabytes with up to two decimal places', () => {
    expect(formatFileSize(1024 * 1024)).toBe('1 MB');
    expect(formatFileSize(5.25 * 1024 * 1024)).toBe('5.25 MB');
    expect(formatFileSize(1024 * 1024 + 7777)).toBe('1.01 MB');
  });
});
