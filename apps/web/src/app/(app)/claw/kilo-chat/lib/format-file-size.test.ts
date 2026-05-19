import { formatFileSize } from './format-file-size';

describe('formatFileSize', () => {
  it('formats bytes', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(1023)).toBe('1023 B');
  });
  it('formats KB', () => {
    expect(formatFileSize(1024)).toBe('1 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
  });
  it('formats MB', () => {
    expect(formatFileSize(1024 * 1024)).toBe('1 MB');
    expect(formatFileSize(5.25 * 1024 * 1024)).toBe('5.25 MB');
  });
  it('rounds to at most 2 decimals', () => {
    expect(formatFileSize(1024 * 1024 + 7777)).toBe('1.01 MB');
  });
});
