import { toSafeHttpUrl, toSafeImageSrc } from './safe-http-url';

describe('toSafeHttpUrl', () => {
  it('allows http and https URLs', () => {
    expect(toSafeHttpUrl('https://example.com/path')).toBe('https://example.com/path');
    expect(toSafeHttpUrl('http://example.com')).toBe('http://example.com');
  });

  it('rejects javascript, data, and other protocols', () => {
    expect(toSafeHttpUrl('javascript:alert(1)')).toBeUndefined();
    expect(toSafeHttpUrl('JAVASCRIPT:alert(1)')).toBeUndefined();
    expect(toSafeHttpUrl(' data:text/html,<script>alert(1)</script>')).toBeUndefined();
    expect(toSafeHttpUrl('vbscript:msgbox(1)')).toBeUndefined();
    expect(toSafeHttpUrl('blob:https://example.com/uuid')).toBeUndefined();
  });

  it('rejects relative, protocol-relative, and malformed values', () => {
    expect(toSafeHttpUrl('/local')).toBeUndefined();
    expect(toSafeHttpUrl('//evil.example')).toBeUndefined();
    expect(toSafeHttpUrl('not a url')).toBeUndefined();
    expect(toSafeHttpUrl(undefined)).toBeUndefined();
    expect(toSafeHttpUrl('')).toBeUndefined();
  });
});

describe('toSafeImageSrc', () => {
  it('allows http(s) and raster data URLs', () => {
    expect(toSafeImageSrc('https://cdn.example/a.png')).toBe('https://cdn.example/a.png');
    expect(toSafeImageSrc('data:image/png;base64,abc')).toBe('data:image/png;base64,abc');
    expect(toSafeImageSrc('data:image/jpeg;base64,abc')).toBe('data:image/jpeg;base64,abc');
  });

  it('rejects svg data URLs and javascript', () => {
    expect(toSafeImageSrc('data:image/svg+xml,<svg></svg>')).toBeUndefined();
    expect(toSafeImageSrc('javascript:alert(1)')).toBeUndefined();
    expect(toSafeImageSrc('data:text/html,<script>alert(1)</script>')).toBeUndefined();
  });
});
