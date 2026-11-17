/**
 * Blacks out unreadable regions of a page screenshot before the image leaves
 * the extension, so an agent caller never receives pixels of a cross-origin
 * iframe whose content it may not read.
 *
 * The pixel work is a pure function over RGBA bytes; the browser-only decode
 * and encode steps are injectable so this module runs under Node in tests.
 */

/** A decoded RGBA image: four bytes per pixel, row-major, no padding. */
export type PixelImage = {
  data: Uint8ClampedArray;
  height: number;
  width: number;
};

/** A region to mask, in CSS pixels in document coordinates. */
export type ScreenshotBox = {
  height: number;
  width: number;
  // eslint-disable-next-line id-length -- document coordinates are named x and y
  x: number;
  // eslint-disable-next-line id-length -- document coordinates are named x and y
  y: number;
};

/** Message returned when a screenshot cannot be masked and must not be sent. */
export const MASK_FAILED_ERROR = 'The screenshot could not be masked for this caller.';

/**
 * The browser steps, injectable so tests can supply their own. Both default to
 * OffscreenCanvas, which exists in the background service worker; the default
 * path never touches `document`.
 */
export interface ScreenshotMaskerDeps {
  decode?: (dataUrl: string) => Promise<PixelImage>;
  encodePng?: (image: PixelImage) => Promise<string>;
}

/** What a masker caller supplies: the captured image plus the regions to hide. */
export type ScreenshotMaskInput = {
  boxes: readonly ScreenshotBox[];
  dataUrl: string;
  /**
   * The captured image's media type. The masked result is always PNG because a
   * lossy re-encode would smear the mask edges.
   */
  mediaType: string;
  /** Device pixel ratio the capture was taken at, so CSS boxes map to pixels. */
  scale: number;
};

/** A masked data URL, or the reason no data URL may be returned. */
export type ScreenshotMaskResult = { dataUrl: string; ok: true } | { error: string; ok: false };

const OPAQUE_BLACK_RED = 0;
const OPAQUE_BLACK_GREEN = 0;
const OPAQUE_BLACK_BLUE = 0;
const OPAQUE_BLACK_ALPHA = 255;

/**
 * Paints opaque black over every pixel whose centre falls inside one of the
 * boxes. Box coordinates are CSS pixels, multiplied by `scale` to reach image
 * pixels, so a device-pixel-ratio 2 capture masks twice the span. Boxes may be
 * negative or wider than the image, may overlap, and each is clamped to the
 * image; a box with no area paints nothing.
 */
export const blackOutBoxes = (
  image: PixelImage,
  boxes: readonly ScreenshotBox[],
  scale: number
): void => {
  const { data, height, width } = image;

  if (width <= 0 || height <= 0 || !Number.isFinite(scale) || scale <= 0) {
    return;
  }

  const lastByte = data.length - 4;

  for (const box of boxes) {
    const left = box.x * scale;
    const top = box.y * scale;
    const right = (box.x + box.width) * scale;
    const bottom = (box.y + box.height) * scale;

    if (
      !Number.isFinite(left) ||
      !Number.isFinite(top) ||
      !Number.isFinite(right) ||
      !Number.isFinite(bottom)
    ) {
      continue;
    }

    // A pixel is covered when its centre, at pixel + 0.5, lies in [left, right].
    const startX = Math.max(0, Math.ceil(left - 0.5));
    const endX = Math.min(width - 1, Math.floor(right - 0.5));
    const startY = Math.max(0, Math.ceil(top - 0.5));
    const endY = Math.min(height - 1, Math.floor(bottom - 0.5));

    if (endX < startX || endY < startY) {
      continue;
    }

    for (let y = startY; y <= endY; y += 1) {
      const rowStart = (y * width + startX) * 4;
      const rowEnd = (y * width + endX + 1) * 4;

      for (let index = rowStart; index < rowEnd && index <= lastByte; index += 4) {
        data[index] = OPAQUE_BLACK_RED;
        data[index + 1] = OPAQUE_BLACK_GREEN;
        data[index + 2] = OPAQUE_BLACK_BLUE;
        data[index + 3] = OPAQUE_BLACK_ALPHA;
      }
    }
  }
};

const requireOffscreenCanvas = (): typeof OffscreenCanvas => {
  const { OffscreenCanvas: canvasConstructor } = globalThis;

  if (typeof canvasConstructor !== 'function') {
    throw new Error('OffscreenCanvas is not available in this context.');
  }

  return canvasConstructor;
};

const requireCreateImageBitmap = (): typeof createImageBitmap => {
  const { createImageBitmap: createBitmap } = globalThis;

  if (typeof createBitmap !== 'function') {
    throw new Error('createImageBitmap is not available in this context.');
  }

  return createBitmap;
};

const decodeScreenshotDataUrl = async (dataUrl: string): Promise<PixelImage> => {
  const canvasConstructor = requireOffscreenCanvas();
  const createBitmap = requireCreateImageBitmap();
  const response = await fetch(dataUrl);
  const bitmap = await createBitmap(await response.blob());

  try {
    const canvas = new canvasConstructor(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');

    if (context === null) {
      throw new Error('OffscreenCanvas has no 2d context.');
    }

    context.drawImage(bitmap, 0, 0);

    const imageData = context.getImageData(0, 0, bitmap.width, bitmap.height);

    return { data: imageData.data, height: imageData.height, width: imageData.width };
  } finally {
    bitmap.close();
  }
};

const encodeBase64 = (bytes: Uint8Array): string => {
  const { btoa } = globalThis;

  if (typeof btoa !== 'function') {
    throw new Error('btoa is not available in this context.');
  }

  // Well under the argument-count limit of String.fromCharCode and of the
  // engine's spread, so a full-screen capture encodes in a few dozen chunks.
  const chunkSize = 0x8000;
  const chunks: string[] = [];

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }

  return btoa(chunks.join(''));
};

const encodeScreenshotPng = async (image: PixelImage): Promise<string> => {
  const canvasConstructor = requireOffscreenCanvas();
  const canvas = new canvasConstructor(image.width, image.height);
  const context = canvas.getContext('2d');

  if (context === null) {
    throw new Error('OffscreenCanvas has no 2d context.');
  }

  const imageData = context.createImageData(image.width, image.height);

  imageData.data.set(image.data);
  context.putImageData(imageData, 0, 0);

  const blob = await canvas.convertToBlob({ type: 'image/png' });

  return `data:image/png;base64,${encodeBase64(new Uint8Array(await blob.arrayBuffer()))}`;
};

/**
 * Returns the screenshot with every box blacked out, always as a PNG data URL,
 * or the failure message when the image cannot be decoded or re-encoded. With
 * no boxes the input data URL is returned as is and nothing is decoded, so a
 * caller that may read everything pays no image work.
 */
export const maskScreenshotDataUrl = async (
  input: ScreenshotMaskInput,
  deps: ScreenshotMaskerDeps = {}
): Promise<ScreenshotMaskResult> => {
  if (input.boxes.length === 0) {
    return { dataUrl: input.dataUrl, ok: true };
  }

  const decode = deps.decode ?? decodeScreenshotDataUrl;
  const encodePng = deps.encodePng ?? encodeScreenshotPng;

  let image: PixelImage;

  try {
    image = await decode(input.dataUrl);
  } catch {
    return { error: MASK_FAILED_ERROR, ok: false };
  }

  try {
    blackOutBoxes(image, input.boxes, input.scale);

    return { dataUrl: await encodePng(image), ok: true };
  } catch {
    return { error: MASK_FAILED_ERROR, ok: false };
  }
};
