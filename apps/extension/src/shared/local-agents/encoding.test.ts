import { describe, expect, it } from 'vitest';
import {
  base64UrlDecode,
  base64UrlEncode,
  computeExtensionMac,
  computeHubMac,
  decodePairingKey,
  extensionMacMessage,
  hubMacMessage,
  verifyHubMac,
} from './encoding';

/*
 * Shared pairing test vectors. Both sides of the bridge must reproduce these
 * exact strings; the CLI agent uses the same table.
 *
 * key    = bytes 0x00..0x1f          -> AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8
 * nonceH = bytes 0x10..0x1f          -> EBESExQVFhcYGRobHB0eHw
 * nonceE = bytes 0x20..0x2f          -> ICEiIyQlJicoKSorLC0uLw
 * ext mac = HMAC-SHA256(key, "ext|EBESExQVFhcYGRobHB0eHw|ICEiIyQlJicoKSorLC0uLw")
 *         = 2F0Ic96ZqylMDceVCIIU8w7UgD-Mo42QPn07tUR5G4w
 * hub mac = HMAC-SHA256(key, "hub|ICEiIyQlJicoKSorLC0uLw|EBESExQVFhcYGRobHB0eHw")
 *         = Rutq0LWEFMhUyqwi_OA4ZbhSrpLeS6cfN-Dtbc5tq-o
 *
 * Second vector uses ASCII nonces on the same key:
 * nonceH = MDEyMzQ1Njc4OWFiY2RlZg (bytes of "0123456789abcdef")
 * nonceE = ZmVkY2JhOTg3NjU0MzIxMA (bytes of "fedcba9876543210")
 * ext mac = TvXSk7uanamo4vc1DhOV4r7es8RjUKMe5ryD83R_qKA
 * hub mac = pLDJm50ReDYzbhpbkSXtA60C0mbbMJpe0vm2QEjJd1o
 */

const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const NONCE_H = 'EBESExQVFhcYGRobHB0eHw';
const NONCE_E = 'ICEiIyQlJicoKSorLC0uLw';
const ASCII_NONCE_H = 'MDEyMzQ1Njc4OWFiY2RlZg';
const ASCII_NONCE_E = 'ZmVkY2JhOTg3NjU0MzIxMA';

describe('base64url', () => {
  it('round-trips bytes without padding', () => {
    const bytes = new Uint8Array([0, 255, 16, 127]);

    expect(base64UrlEncode(bytes)).toBe('AP8Qfw');
    expect(base64UrlDecode('AP8Qfw')).toStrictEqual(bytes);
  });

  it('rejects padded, foreign, and impossible-length values', () => {
    expect(base64UrlDecode('AP8Qfw==')).toBeNull();
    expect(base64UrlDecode('AP8Q+w')).toBeNull();
    expect(base64UrlDecode('A')).toBeNull();
  });

  it('accepts only a 32-byte pairing key', () => {
    expect(decodePairingKey(KEY)?.length).toBe(32);
    expect(decodePairingKey(base64UrlEncode(new Uint8Array(31)))).toBeNull();
    expect(decodePairingKey(base64UrlEncode(new Uint8Array(33)))).toBeNull();
  });
});

describe('pairing MACs', () => {
  const sharedSecret = decodePairingKey(KEY);

  if (sharedSecret === null) {
    throw new Error('test vector key must decode');
  }

  it('builds the exact MAC input strings', () => {
    expect(extensionMacMessage(NONCE_H, NONCE_E)).toBe(`ext|${NONCE_H}|${NONCE_E}`);
    expect(hubMacMessage(NONCE_E, NONCE_H)).toBe(`hub|${NONCE_E}|${NONCE_H}`);
  });

  it('matches the shared vector', async () => {
    await expect(computeExtensionMac(sharedSecret, NONCE_H, NONCE_E)).resolves.toBe(
      '2F0Ic96ZqylMDceVCIIU8w7UgD-Mo42QPn07tUR5G4w'
    );
    await expect(computeHubMac(sharedSecret, NONCE_E, NONCE_H)).resolves.toBe(
      'Rutq0LWEFMhUyqwi_OA4ZbhSrpLeS6cfN-Dtbc5tq-o'
    );
  });

  it('matches the ASCII-nonce vector', async () => {
    await expect(computeExtensionMac(sharedSecret, ASCII_NONCE_H, ASCII_NONCE_E)).resolves.toBe(
      'TvXSk7uanamo4vc1DhOV4r7es8RjUKMe5ryD83R_qKA'
    );
    await expect(computeHubMac(sharedSecret, ASCII_NONCE_E, ASCII_NONCE_H)).resolves.toBe(
      'pLDJm50ReDYzbhpbkSXtA60C0mbbMJpe0vm2QEjJd1o'
    );
  });

  it('verifies only the matching hub MAC', async () => {
    const key = sharedSecret;
    const accept = (mac: string) => verifyHubMac({ key, mac, nonceE: NONCE_E, nonceH: NONCE_H });

    await expect(accept('Rutq0LWEFMhUyqwi_OA4ZbhSrpLeS6cfN-Dtbc5tq-o')).resolves.toBe(true);
    await expect(accept('2F0Ic96ZqylMDceVCIIU8w7UgD-Mo42QPn07tUR5G4w')).resolves.toBe(false);
    await expect(accept('not base64url padding==')).resolves.toBe(false);
  });
});
