import { describe, expect, it } from 'vitest';
import { bytesToHex, sha256Hex } from './sha256.js';

describe('sha256Hex', () => {
  it('produces the lowercase hex SHA-256 digest of the input', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });
});

describe('bytesToHex', () => {
  it('encodes bytes as a lowercase hex string with zero padding', () => {
    expect(bytesToHex(new Uint8Array([0x00, 0x0f, 0xff]))).toBe('000fff');
  });
});
