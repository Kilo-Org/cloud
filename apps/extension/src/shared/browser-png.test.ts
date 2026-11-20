import { describe, expect, it } from 'vitest';
import { recompressPng, recompressPngBase64 } from './browser-png';
import {
  pngChunk,
  pngChunksOf,
  pngCompressionLevelOf,
  pngScanlinesOf,
  writeRgbPng,
} from './browser-png-test-images';

/** What decoding reads: every chunk but the image data verbatim, and the inflated scanlines. */
const expectSameImage = (actual: Uint8Array, expected: Uint8Array): void => {
  expect(pngChunksOf(actual).nonImageChunks).toStrictEqual(pngChunksOf(expected).nonImageChunks);
  expect(pngScanlinesOf(actual).equals(pngScanlinesOf(expected))).toBe(true);
};

describe('png re-deflate', () => {
  it('re-deflates a speed-compressed PNG into fewer bytes of the same scanlines', async () => {
    const fast = writeRgbPng({ level: 0 });
    const recompressed = await recompressPng(fast);

    expect(pngCompressionLevelOf(fast)).toBe(0);
    expect(pngCompressionLevelOf(recompressed)).toBe(2);
    expect(recompressed.length).toBeLessThan(fast.length);
    expectSameImage(recompressed, fast);
  });

  it('joins split image data into one chunk and keeps every other chunk in place', async () => {
    const gamma = pngChunk('gAMA', new Uint8Array([0, 0, 177, 143]));
    const fast = writeRgbPng({ extraChunks: [gamma], idatChunks: 3, level: 1 });
    const recompressed = await recompressPng(fast);

    expect(pngChunksOf(fast).types).toStrictEqual(['IHDR', 'gAMA', 'IDAT', 'IDAT', 'IDAT', 'IEND']);
    expect(pngChunksOf(recompressed).types).toStrictEqual(['IHDR', 'gAMA', 'IDAT', 'IEND']);
    expectSameImage(recompressed, fast);
  });

  it('leaves a PNG already compressed for size as it is', async () => {
    const png = writeRgbPng({ level: 6 });

    await expect(recompressPng(png)).resolves.toBe(png);
  });

  it('leaves bytes it cannot read as they are', async () => {
    const fast = writeRgbPng({ level: 0 });
    const truncated = fast.slice(0, -20);
    const notPng = new Uint8Array([1, 2, 3]);
    const corrupt = Uint8Array.from(fast);

    // Garble the deflate stream right after its two-byte zlib header (IDAT data starts at byte 41).
    corrupt.fill(255, 43, 60);

    await expect(recompressPng(truncated)).resolves.toBe(truncated);
    await expect(recompressPng(notPng)).resolves.toBe(notPng);
    await expect(recompressPng(corrupt)).resolves.toBe(corrupt);
  });
});

describe('base64 png re-deflate', () => {
  it('re-deflates a base64 speed-compressed PNG and leaves anything else unchanged', async () => {
    const fast = writeRgbPng({ level: 0 });
    const base64 = Buffer.from(fast).toString('base64');
    const recompressed = await recompressPngBase64(base64);

    expect(recompressed.length).toBeLessThan(base64.length);
    expectSameImage(new Uint8Array(Buffer.from(recompressed, 'base64')), fast);
    await expect(recompressPngBase64('QUJD')).resolves.toBe('QUJD');
    await expect(recompressPngBase64('not base64!')).resolves.toBe('not base64!');
  });
});
