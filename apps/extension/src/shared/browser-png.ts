/**
 * Smaller screenshots with the same pixels. Chrome's screencast frames and its
 * canvas encoder deflate a PNG for speed (zlib level 0), which makes a page
 * screenshot about twice the bytes `Page.captureScreenshot` returns for the
 * same image. Re-deflating the image data at the default level keeps every
 * filtered scanline byte for byte, and every other chunk as it was, so only
 * the compression changes.
 */

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
/** A chunk's length and type before its data, and its CRC after. */
const CHUNK_HEADER = 8;
const CHUNK_OVERHEAD = 12;

/**
 * The zlib header's FLEVEL field (RFC 1950): 0 and 1 mark the fastest and fast
 * compressors, 2 the default and 3 the slowest. Chrome writes 0 for its
 * screencast frames and canvas encodes, and 2 for `Page.captureScreenshot`,
 * whose output is already as small as this re-deflate would make it.
 */
const MAX_SPEED_FLEVEL = 1;

const BYTE_MASK = 255;
/** The reflected CRC-32 polynomial PNG chunks use (0xEDB88320), and the all-ones register (0xFFFFFFFF). */
const CRC_POLYNOMIAL = 3_988_292_384;
const CRC_ALL_ONES = 4_294_967_295;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);

  for (let index = 0; index < 256; index += 1) {
    let value = index;

    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? CRC_POLYNOMIAL ^ (value >>> 1) : value >>> 1;
    }

    table[index] = value >>> 0;
  }

  return table;
})();

const crc32 = (bytes: Uint8Array): number => {
  let crc = CRC_ALL_ONES;

  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & BYTE_MASK] ?? 0) ^ (crc >>> 8);
  }

  return (crc ^ CRC_ALL_ONES) >>> 0;
};

const concatBytes = (parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;

  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }

  return joined;
};

const transform = async (
  bytes: Uint8Array<ArrayBuffer>,
  stream: CompressionStream | DecompressionStream
): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());

/** Where a PNG's image data sits: the bytes before its IDAT chunks, the joined IDAT data, and the bytes after. */
interface PngImageData {
  readonly after: Uint8Array;
  readonly before: Uint8Array;
  readonly compressed: Uint8Array<ArrayBuffer>;
}

/**
 * Splits a PNG around its image data. `undefined` for bytes that are not a
 * complete PNG, or whose IDAT chunks are missing or not consecutive (the PNG
 * specification requires them to be).
 */
const readImageData = (png: Uint8Array): PngImageData | undefined => {
  if (png.length < SIGNATURE.length || SIGNATURE.some((byte, index) => png[index] !== byte)) {
    return undefined;
  }

  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const data: Uint8Array[] = [];
  let firstStart = -1;
  let lastEnd = -1;
  let offset: number = SIGNATURE.length;

  while (offset < png.length) {
    if (offset + CHUNK_OVERHEAD > png.length) {
      return undefined;
    }

    const length = view.getUint32(offset);
    const end = offset + CHUNK_OVERHEAD + length;

    if (end > png.length) {
      return undefined;
    }

    if (String.fromCodePoint(...png.subarray(offset + 4, offset + CHUNK_HEADER)) === 'IDAT') {
      if (firstStart !== -1 && lastEnd !== offset) {
        return undefined;
      }

      firstStart = firstStart === -1 ? offset : firstStart;
      lastEnd = end;
      data.push(png.subarray(offset + CHUNK_HEADER, offset + CHUNK_HEADER + length));
    }

    offset = end;
  }

  return data.length === 0
    ? undefined
    : {
        after: png.subarray(lastEnd),
        before: png.subarray(0, firstStart),
        compressed: concatBytes(data),
      };
};

const idatChunk = (data: Uint8Array): Uint8Array<ArrayBuffer> => {
  const chunk = new Uint8Array(data.length + CHUNK_OVERHEAD);
  const view = new DataView(chunk.buffer);

  view.setUint32(0, data.length);
  chunk.set([73, 68, 65, 84], 4);
  chunk.set(data, CHUNK_HEADER);
  view.setUint32(CHUNK_HEADER + data.length, crc32(chunk.subarray(4, CHUNK_HEADER + data.length)));

  return chunk;
};

/**
 * The same PNG in fewer bytes: when its image data was deflated for speed, it
 * is inflated and deflated again at the default level, and the smaller of the
 * two images is kept. Any other input is returned unchanged.
 */
export const recompressPng = async (
  png: Uint8Array<ArrayBuffer>
): Promise<Uint8Array<ArrayBuffer>> => {
  const image = readImageData(png);

  if (image === undefined || (image.compressed[1] ?? 0) >>> 6 > MAX_SPEED_FLEVEL) {
    return png;
  }

  try {
    const scanlines = await transform(image.compressed, new DecompressionStream('deflate'));
    const recompressed = concatBytes([
      image.before,
      idatChunk(await transform(scanlines, new CompressionStream('deflate'))),
      image.after,
    ]);

    return recompressed.length < png.length ? recompressed : png;
  } catch {
    // Image data that does not inflate: keep the bytes as they are.
    return png;
  }
};

const encodeBase64 = (bytes: Uint8Array): string => {
  // Well under String.fromCodePoint's and the engine's spread argument limits.
  const chunkSize = 0x80_00;
  const chunks: string[] = [];

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCodePoint(...bytes.subarray(offset, offset + chunkSize)));
  }

  return btoa(chunks.join(''));
};

const decodeBase64 = (base64: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.codePointAt(index) ?? 0;
  }

  return bytes;
};

/** `recompressPng` for a base64 PNG, the form CDP returns; anything it cannot read comes back unchanged. */
export const recompressPngBase64 = async (base64: string): Promise<string> => {
  try {
    const png = decodeBase64(base64);
    const recompressed = await recompressPng(png);

    return recompressed === png ? base64 : encodeBase64(recompressed);
  } catch {
    // Not base64: there is nothing to re-encode.
    return base64;
  }
};
