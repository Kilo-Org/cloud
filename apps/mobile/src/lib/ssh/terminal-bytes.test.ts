import { describe, expect, it } from 'vitest';

import { encodeTerminalInput } from './terminal-bytes';

describe('encodeTerminalInput', () => {
  it('encodes ASCII as UTF-8 base64', () => {
    expect(encodeTerminalInput('ok')).toBe('b2s=');
    expect(encodeTerminalInput('a')).toBe('YQ==');
    expect(encodeTerminalInput('')).toBe('');
    expect(encodeTerminalInput('ab')).toBe('YWI=');
  });

  it('encodes the escape sequences the key bar sends', () => {
    expect(encodeTerminalInput('\u001B[D')).toBe('G1tE');
    expect(encodeTerminalInput('\t')).toBe('CQ==');
    expect(encodeTerminalInput('\u001B')).toBe('Gw==');
    expect(encodeTerminalInput('\r')).toBe('DQ==');
  });

  it('encodes multi-byte text as its UTF-8 bytes', () => {
    // "é" is two bytes, "€" three, and an emoji is a surrogate pair of four.
    expect(encodeTerminalInput('é')).toBe('w6k=');
    expect(encodeTerminalInput('€')).toBe('4oKs');
    expect(encodeTerminalInput('😀')).toBe('8J+YgA==');
  });

  it('pads only the final group', () => {
    expect(encodeTerminalInput('abcd')).toBe('YWJjZA==');
    expect(encodeTerminalInput('abcde')).toBe('YWJjZGU=');
  });
});
