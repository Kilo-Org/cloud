import { describe, expect, it, vi } from 'vitest';
import {
  MASK_FAILED_ERROR,
  blackOutBoxes,
  maskScreenshotDataUrl,
} from './browser-screenshot-masking';
import type { PixelImage } from './browser-screenshot-masking';

const UNTOUCHED_RED = 0x11;
const UNTOUCHED_GREEN = 0x22;
const UNTOUCHED_BLUE = 0x33;
const UNTOUCHED_ALPHA = 0x44;

const createImage = (width: number, height: number): PixelImage => {
  const data = new Uint8ClampedArray(width * height * 4);

  for (let index = 0; index < data.length; index += 4) {
    data[index] = UNTOUCHED_RED;
    data[index + 1] = UNTOUCHED_GREEN;
    data[index + 2] = UNTOUCHED_BLUE;
    data[index + 3] = UNTOUCHED_ALPHA;
  }

  return { data, height, width };
};

const pixelAt = (
  image: PixelImage,
  column: number,
  row: number
): { alpha: number; blue: number; green: number; red: number } => {
  const index = (row * image.width + column) * 4;

  return {
    alpha: image.data[index + 3] ?? -1,
    blue: image.data[index + 2] ?? -1,
    green: image.data[index + 1] ?? -1,
    red: image.data[index] ?? -1,
  };
};

const BLACK = { alpha: 255, blue: 0, green: 0, red: 0 };
const UNTOUCHED = {
  alpha: UNTOUCHED_ALPHA,
  blue: UNTOUCHED_BLUE,
  green: UNTOUCHED_GREEN,
  red: UNTOUCHED_RED,
};

type Pixel = readonly [column: number, row: number];

const expectPixels = (
  image: PixelImage,
  pixels: readonly Pixel[],
  expected: { alpha: number; blue: number; green: number; red: number }
): void => {
  for (const [column, row] of pixels) {
    expect(pixelAt(image, column, row)).toStrictEqual(expected);
  }
};

describe('opaque box painting', () => {
  it('blacks out exactly the covered pixels and leaves their neighbours untouched', () => {
    const image = createImage(4, 4);

    blackOutBoxes(image, [{ height: 2, left: 1, top: 1, width: 2 }], 1);

    expect(pixelAt(image, 1, 1)).toStrictEqual(BLACK);
    expectPixels(
      image,
      [
        [1, 1],
        [2, 1],
        [1, 2],
        [2, 2],
      ],
      BLACK
    );
    expectPixels(
      image,
      [
        [0, 0],
        [0, 1],
        [1, 0],
        [3, 1],
        [1, 3],
        [3, 3],
      ],
      UNTOUCHED
    );
  });

  it('doubles the covered region at scale 2', () => {
    const image = createImage(4, 4);

    blackOutBoxes(image, [{ height: 1, left: 1, top: 1, width: 1 }], 1);
    expect(pixelAt(image, 1, 1)).toStrictEqual(BLACK);
    expect(pixelAt(image, 2, 2)).toStrictEqual(UNTOUCHED);

    const scaledImage = createImage(4, 4);

    blackOutBoxes(scaledImage, [{ height: 1, left: 1, top: 1, width: 1 }], 2);

    expectPixels(
      scaledImage,
      [
        [2, 2],
        [3, 2],
        [2, 3],
        [3, 3],
      ],
      BLACK
    );
    expectPixels(
      scaledImage,
      [
        [1, 1],
        [1, 2],
        [0, 0],
      ],
      UNTOUCHED
    );
  });

  it('clamps a box that starts outside the image', () => {
    const image = createImage(4, 4);

    blackOutBoxes(image, [{ height: 3, left: -2, top: -2, width: 3 }], 1);

    expect(pixelAt(image, 0, 0)).toStrictEqual(BLACK);
    expect(pixelAt(image, 1, 0)).toStrictEqual(UNTOUCHED);
    expect(pixelAt(image, 0, 1)).toStrictEqual(UNTOUCHED);
    expect(pixelAt(image, 1, 1)).toStrictEqual(UNTOUCHED);
  });

  it('clamps a box that overflows the image and never writes past the buffer', () => {
    const image = createImage(4, 4);
    const byteLength = image.data.length;

    blackOutBoxes(image, [{ height: 10, left: 2, top: 2, width: 10 }], 1);

    expectPixels(
      image,
      [
        [2, 2],
        [3, 2],
        [2, 3],
        [3, 3],
      ],
      BLACK
    );
    expect(pixelAt(image, 1, 1)).toStrictEqual(UNTOUCHED);
    expect(image.data).toHaveLength(byteLength);
  });

  it('ignores a zero-area box', () => {
    const image = createImage(3, 3);

    blackOutBoxes(
      image,
      [
        { height: 0, left: 1, top: 1, width: 0 },
        { height: 2, left: 0, top: 0, width: 0 },
      ],
      1
    );

    const everyPixel = [0, 1, 2].flatMap(column => [0, 1, 2].map((row): Pixel => [column, row]));

    expect(pixelAt(image, 1, 1)).toStrictEqual(UNTOUCHED);
    expectPixels(image, everyPixel, UNTOUCHED);
  });

  it('blacks out the union of overlapping boxes', () => {
    const image = createImage(4, 4);

    blackOutBoxes(
      image,
      [
        { height: 2, left: 0, top: 0, width: 2 },
        { height: 2, left: 1, top: 1, width: 2 },
      ],
      1
    );

    expect(pixelAt(image, 1, 1)).toStrictEqual(BLACK);
    expectPixels(
      image,
      [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
        [2, 1],
        [1, 2],
        [2, 2],
      ],
      BLACK
    );
    expectPixels(
      image,
      [
        [2, 0],
        [0, 2],
        [3, 3],
      ],
      UNTOUCHED
    );
  });
});

const DATA_URL = 'data:image/png;base64,AAAA';

describe('masked screenshot data URLs', () => {
  it('returns the input data URL without decoding when there are no boxes', async () => {
    const decode = vi.fn(() => Promise.reject(new Error('decode must not run')));

    const result = await maskScreenshotDataUrl(
      { boxes: [], dataUrl: DATA_URL, mediaType: 'image/png', scale: 2 },
      { decode }
    );

    expect(result).toStrictEqual({ dataUrl: DATA_URL, ok: true });
    expect(decode).toHaveBeenCalledTimes(0);
  });

  it('reports a decode failure without returning a data URL', async () => {
    const result = await maskScreenshotDataUrl(
      {
        boxes: [{ height: 10, left: 0, top: 0, width: 10 }],
        dataUrl: DATA_URL,
        mediaType: 'image/png',
        scale: 1,
      },
      {
        decode: () => Promise.reject(new Error('broken image')),
      }
    );

    expect(result).toStrictEqual({ error: MASK_FAILED_ERROR, ok: false });
    expect(result).not.toHaveProperty('dataUrl');
  });

  it('reports an encode failure without returning a data URL', async () => {
    const result = await maskScreenshotDataUrl(
      {
        boxes: [{ height: 1, left: 0, top: 0, width: 1 }],
        dataUrl: DATA_URL,
        mediaType: 'image/png',
        scale: 1,
      },
      {
        decode: () => Promise.resolve(createImage(2, 2)),
        encodePng: () => Promise.reject(new Error('cannot encode')),
      }
    );

    expect(result).toStrictEqual({ error: MASK_FAILED_ERROR, ok: false });
    expect(result).not.toHaveProperty('dataUrl');
  });

  it('round trips through injected decode and encode with the outside pixel intact', async () => {
    const image = createImage(4, 4);
    let encoded: PixelImage | null = null;

    const result = await maskScreenshotDataUrl(
      {
        boxes: [{ height: 2, left: 1, top: 1, width: 2 }],
        dataUrl: DATA_URL,
        mediaType: 'image/jpeg',
        scale: 1,
      },
      {
        decode: () => Promise.resolve(image),
        encodePng: (masked: PixelImage) => {
          encoded = masked;

          return Promise.resolve('data:image/png;base64,bWFza2Vk');
        },
      }
    );

    expect(result).toStrictEqual({ dataUrl: 'data:image/png;base64,bWFza2Vk', ok: true });
    expect(encoded).toBe(image);
    expect(pixelAt(image, 1, 1)).toStrictEqual(BLACK);
    expect(pixelAt(image, 0, 0)).toStrictEqual(UNTOUCHED);
  });
});
