/* eslint-disable import/no-nodejs-modules -- test-only images: Node's zlib writes the speed-compressed PNGs Chrome's screencast returns, and reads them back */
import { crc32, deflateSync, inflateSync } from 'node:zlib';

const DEFAULT_SIZE = { height: 48, width: 64 } as const;

/** One pixel's level: a white band, a gradient band, then sparse dark "glyphs" on a light ground. */
const levelAt = (column: number, row: number, height: number): number => {
  if (row < height / 3) {
    return 255;
  }

  if (row < (height * 2) / 3) {
    return (column * 4) % 256;
  }

  return (column * 7 + row * 13) % 29 === 0 ? 20 : 240;
};

export const pngChunk = (type: string, data: Uint8Array): Buffer => {
  const header = Buffer.alloc(8);

  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, 'latin1');

  const crc = Buffer.alloc(4);

  crc.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])), 0);

  return Buffer.concat([header, data, crc]);
};

/**
 * A screenshot-like RGB PNG written the way Chrome's screencast writes one:
 * every row Up-filtered, deflated at the zlib level given and split into
 * `idatChunks` IDAT chunks, with any extra chunks before the image data.
 */
export const writeRgbPng = (options: {
  readonly extraChunks?: readonly Buffer[];
  readonly idatChunks?: number;
  readonly level: number;
  readonly size?: { readonly height: number; readonly width: number };
}): Uint8Array<ArrayBuffer> => {
  const { height, width } = options.size ?? DEFAULT_SIZE;
  const stride = width * 3 + 1;
  const rows = Buffer.alloc(stride * height);
  const pixel = (column: number, row: number): readonly number[] => {
    const level = levelAt(column, row, height);

    return [level, (level + row) % 256, (level + column) % 256];
  };

  for (let row = 0; row < height; row += 1) {
    rows[row * stride] = 2;

    for (let column = 0; column < width; column += 1) {
      const current = pixel(column, row);
      const above = row === 0 ? [0, 0, 0] : pixel(column, row - 1);

      for (let channel = 0; channel < 3; channel += 1) {
        // Up filter: each byte minus the byte above it.
        rows[row * stride + 1 + column * 3 + channel] =
          ((current[channel] ?? 0) - (above[channel] ?? 0)) & 255;
      }
    }
  }

  const header = Buffer.alloc(13);

  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;

  const compressed = deflateSync(rows, { level: options.level });
  const parts = options.idatChunks ?? 1;
  const partLength = Math.ceil(compressed.length / parts);

  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk('IHDR', header),
      ...(options.extraChunks ?? []),
      ...Array.from({ length: parts }, (_unused, part) =>
        pngChunk('IDAT', compressed.subarray(part * partLength, (part + 1) * partLength))
      ),
      pngChunk('IEND', Buffer.alloc(0)),
    ])
  );
};

/** A PNG's chunks in order: every chunk's type, and every non-IDAT chunk's bytes as hex. */
export interface PngChunks {
  readonly nonImageChunks: readonly string[];
  readonly types: readonly string[];
}

export const pngChunksOf = (png: Uint8Array): PngChunks => {
  const bytes = Buffer.from(png);
  const types: string[] = [];
  const nonImageChunks: string[] = [];

  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);

    types.push(type);

    if (type !== 'IDAT') {
      nonImageChunks.push(bytes.toString('hex', offset, offset + 12 + length));
    }

    offset += 12 + length;
  }

  return { nonImageChunks, types };
};

/** A PNG's filtered scanlines: its IDAT data joined and inflated, the bytes every pixel is decoded from. */
export const pngScanlinesOf = (png: Uint8Array): Buffer => {
  const bytes = Buffer.from(png);
  const data: Buffer[] = [];

  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);

    if (bytes.toString('latin1', offset + 4, offset + 8) === 'IDAT') {
      data.push(bytes.subarray(offset + 8, offset + 8 + length));
    }

    offset += 12 + length;
  }

  return inflateSync(Buffer.concat(data));
};

/** The zlib FLEVEL of a PNG's image data (0 fastest … 3 slowest): the second byte after the first IDAT type. */
export const pngCompressionLevelOf = (png: Uint8Array): number => {
  const idatType = Buffer.from(png).indexOf('IDAT', 8, 'latin1');

  return (png[idatType + 5] ?? 0) >>> 6;
};
