import * as ImageManipulator from 'expo-image-manipulator';

/** An image that stays on the device: its bytes, base64, and their media type. */
export type LocalImage = { readonly media: string; readonly data: string };

/**
 * The longest edge sent. Larger images cost more tokens and gain nothing: the
 * major vision models scale an image down to about this size before they read it.
 */
const MAX_EDGE = 1568;
const QUALITY = 0.8;
/**
 * The largest encoded image sent. Providers refuse a base64 image over 5 MB,
 * and base64 is four bytes for every three.
 */
const MAX_ENCODED_LENGTH = 5 * 1024 * 1024;

export type LocalImageFailure = 'unreadable' | 'tooLarge';

export class LocalImageError extends Error {
  readonly reason: LocalImageFailure;

  constructor(reason: LocalImageFailure) {
    super(reason);
    this.reason = reason;
  }
}

/**
 * Reads a picked or pasted image as a bounded JPEG. The image is scaled so its
 * longest edge is at most `MAX_EDGE`, and the re-encode drops its metadata.
 */
export async function encodeLocalImage(uri: string): Promise<LocalImage> {
  let data: string | undefined = undefined;
  // The live native image is released however this ends, including a failed
  // read or a failed save: it holds the decoded pixels, and nothing else does.
  let live: ImageManipulator.ImageRef | undefined = undefined;
  try {
    live = await ImageManipulator.ImageManipulator.manipulate(uri).renderAsync();
    const { width, height } = live;
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    if (scale < 1) {
      const source = live;
      live = await ImageManipulator.ImageManipulator.manipulate(uri)
        .resize({ width: Math.round(width * scale), height: Math.round(height * scale) })
        .renderAsync();
      source.release();
    }
    const saved = await live.saveAsync({
      format: ImageManipulator.SaveFormat.JPEG,
      compress: QUALITY,
      base64: true,
    });
    ({ base64: data } = saved);
  } catch {
    throw new LocalImageError('unreadable');
  } finally {
    live?.release();
  }
  if (data === undefined || data === '') {
    throw new LocalImageError('unreadable');
  }
  if (data.length > MAX_ENCODED_LENGTH) {
    throw new LocalImageError('tooLarge');
  }
  return { media: 'image/jpeg', data };
}
