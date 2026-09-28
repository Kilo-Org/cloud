import { describe, it, expect } from 'vitest';
import { bytesToBase64url, base64urlToBytes } from './base64url';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('bytesToBase64url', () => {
  it('encodes UTF-8 bytes without padding', () => {
    expect(bytesToBase64url(utf8('ab>'))).toBe('YWI-');
    expect(bytesToBase64url(utf8('ab?'))).toBe('YWI_');
    expect(bytesToBase64url(utf8('user_abc123'))).toBe('dXNlcl9hYmMxMjM');
  });

  it('handles non-Latin1 code points', () => {
    const bytes = utf8('你好');
    expect(bytesToBase64url(bytes)).toBe('5L2g5aW9');
  });
});

describe('base64urlToBytes', () => {
  it('roundtrips arbitrary byte sequences', () => {
    for (const s of ['ab>', 'ab?', 'user_abc123', '你好', '']) {
      const encoded = bytesToBase64url(utf8(s));
      const decoded = new TextDecoder().decode(base64urlToBytes(encoded));
      expect(decoded).toBe(s);
    }
  });

  it('accepts unpadded input by restoring padding', () => {
    expect(new TextDecoder().decode(base64urlToBytes('YWI-'))).toBe('ab>');
  });

  it('throws on malformed base64url', () => {
    expect(() => base64urlToBytes('%%%')).toThrow();
  });
});
