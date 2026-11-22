/* eslint-disable require-await, typescript-eslint/require-await -- the fakes resolve at once, as the native image API does */
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

/** One rendered native image: the shape the strip saves and releases. */
type FakeImage = {
  width: number;
  height: number;
  release: Mock;
  saveAsync: Mock;
};

const manipulator = vi.hoisted(() => ({
  renders: [] as FakeImage[],
  sources: [] as unknown[],
  options: [] as (Record<string, number> | undefined)[],
  captureException: vi.fn(),
}));

/** A rendered image whose save resolves to `uri` unless the test overrides it. */
function makeImage(uri: string): FakeImage {
  const image: FakeImage = {
    width: 1568,
    height: 1176,
    release: vi.fn(),
    saveAsync: vi.fn(async () => ({ uri, width: 1568, height: 1176 })),
  };
  manipulator.renders.push(image);
  return image;
}

vi.mock('expo-image-manipulator', () => ({
  SaveFormat: { PNG: 'png', WEBP: 'webp', JPEG: 'jpeg' },
  ImageManipulator: {
    manipulate: (source: unknown, options?: Record<string, number>) => {
      manipulator.sources.push(source);
      manipulator.options.push(options);
      return {
        renderAsync: async () => {
          const next = manipulator.renders.shift();
          if (!next) {
            throw new Error('no rendered image queued');
          }
          return next;
        },
      };
    },
  },
}));

vi.mock('@sentry/react-native', () => ({
  captureException: manipulator.captureException,
}));

const { stripImageMetadata, strippedExtension } = await import('./strip-image-metadata');

describe('strippedExtension', () => {
  it('keeps png and webp in their own format', () => {
    expect(strippedExtension('png')).toBe('png');
    expect(strippedExtension('webp')).toBe('webp');
  });

  it('re-encodes jpg and gif to jpeg', () => {
    expect(strippedExtension('jpg')).toBe('jpg');
    expect(strippedExtension('gif')).toBe('jpg');
  });

  it('re-encodes heic and heif to jpg', () => {
    expect(strippedExtension('heic')).toBe('jpg');
    expect(strippedExtension('heif')).toBe('jpg');
  });
});

describe('stripImageMetadata', () => {
  type CaptureOptions = { extra: { inputExtension: string }; fingerprint: string[] };

  function captureOptions(index: number): CaptureOptions {
    const call = manipulator.captureException.mock.calls[index] as
      | [Error, CaptureOptions]
      | undefined;
    if (call === undefined) {
      throw new Error(`no capture at index ${index}`);
    }
    return call[1];
  }

  /** The bounded decode both attempts ask for: never a full-resolution photo. */
  const BOUNDED_OPTIONS = { maxWidth: 1568, maxHeight: 1568 };

  beforeEach(() => {
    manipulator.renders.length = 0;
    manipulator.sources.length = 0;
    manipulator.options.length = 0;
    manipulator.captureException.mockReset();
  });

  it('re-encodes with the matching save format and returns the new URI and extension', async () => {
    const image = makeImage('file:///cache/stripped.png');

    const result = await stripImageMetadata('file:///cache/original.png', 'png');

    expect(manipulator.sources).toEqual(['file:///cache/original.png']);
    expect(manipulator.options).toEqual([BOUNDED_OPTIONS]);
    expect(image.saveAsync).toHaveBeenCalledWith({ compress: 1, format: 'png' });
    expect(image.release).toHaveBeenCalledOnce();
    expect(result).toEqual({
      ok: true,
      uri: 'file:///cache/stripped.png',
      extension: 'png',
    });
  });

  it('re-encodes heic and heif with the JPEG save format', async () => {
    const heic = makeImage('file:///cache/stripped.jpg');

    await stripImageMetadata('file:///cache/original.heic', 'heic');
    expect(manipulator.sources).toEqual(['file:///cache/original.heic']);
    expect(heic.saveAsync).toHaveBeenCalledWith({ compress: 1, format: 'jpeg' });
    expect(heic.release).toHaveBeenCalledOnce();

    const heif = makeImage('file:///cache/stripped.jpg');

    await stripImageMetadata('file:///cache/original.heif', 'heif');
    expect(manipulator.sources).toEqual([
      'file:///cache/original.heic',
      'file:///cache/original.heif',
    ]);
    expect(heif.saveAsync).toHaveBeenCalledWith({ compress: 1, format: 'jpeg' });
    expect(heif.release).toHaveBeenCalledOnce();
  });

  it('retries once with a forced JPEG output when the format-matched re-encode fails', async () => {
    const first = makeImage('file:///cache/unused.webp');
    first.saveAsync.mockRejectedValue(new Error('webp encode failed'));
    const retried = makeImage('file:///cache/stripped.jpg');

    const result = await stripImageMetadata('file:///cache/original.webp', 'webp');

    expect(manipulator.sources).toEqual([
      'file:///cache/original.webp',
      'file:///cache/original.webp',
    ]);
    // Both attempts decode through the same bounded loader, so the retry does
    // not fall back to a full-resolution decode.
    expect(manipulator.options).toEqual([BOUNDED_OPTIONS, BOUNDED_OPTIONS]);
    expect(retried.saveAsync).toHaveBeenCalledWith({ compress: 1, format: 'jpeg' });
    // A failed save releases its own decode, and so does the retry.
    expect(first.release).toHaveBeenCalledOnce();
    expect(retried.release).toHaveBeenCalledOnce();
    expect(result).toEqual({ ok: true, uri: 'file:///cache/stripped.jpg', extension: 'jpg' });
    expect(manipulator.captureException).not.toHaveBeenCalled();
  });

  it('reports the caught cause and names the encoder failure in the fingerprint', async () => {
    const firstError = new Error('webp encode failed');
    const retryError = new Error('jpeg retry failed');
    const first = makeImage('file:///cache/unused.webp');
    first.saveAsync.mockRejectedValue(firstError);
    const retried = makeImage('file:///cache/unused.jpg');
    retried.saveAsync.mockRejectedValue(retryError);

    const result = await stripImageMetadata('file:///cache/original.webp', 'webp');

    expect(manipulator.sources).toHaveLength(2);
    expect(result).toEqual({ ok: false });
    expect(manipulator.captureException).toHaveBeenCalledTimes(1);
    const [reported] = manipulator.captureException.mock.calls[0] as [Error, CaptureOptions];
    expect(reported).toBeInstanceOf(Error);
    expect(reported.message).toBe('Attachment image metadata strip failed');
    expect(reported.cause).toBe(retryError);
    expect(captureOptions(0).extra).toEqual({ inputExtension: 'webp' });
    expect(captureOptions(0).fingerprint).toEqual([
      'agent-attachments-strip-image-metadata',
      'webp',
      'encoder',
      'Error',
    ]);
  });

  it('skips the retry for JPEG-family inputs whose only format already is JPEG', async () => {
    const image = makeImage('file:///cache/unused.jpg');
    image.saveAsync.mockRejectedValue(new Error('jpeg encode failed'));

    const result = await stripImageMetadata('file:///cache/original.heic', 'heic');

    expect(manipulator.sources).toEqual(['file:///cache/original.heic']);
    expect(image.saveAsync).toHaveBeenCalledTimes(1);
    expect(image.release).toHaveBeenCalledOnce();
    expect(result).toEqual({ ok: false });
    const [reported] = manipulator.captureException.mock.calls[0] as [Error];
    expect(reported.cause).toMatchObject({ message: 'jpeg encode failed' });
  });

  it('releases the decode and reports when the encoder cannot even load the image', async () => {
    const image = makeImage('file:///cache/unused.heic');
    image.saveAsync.mockRejectedValue(
      Object.assign(new Error('Could not load the image: file:///cache/original.heic'), {
        code: 'ERR_IMAGE_MANIPULATOR_IMAGE_LOADING_FAILED',
      })
    );

    const result = await stripImageMetadata('file:///cache/original.heic', 'heic');

    expect(result).toEqual({ ok: false });
    expect(image.release).toHaveBeenCalledOnce();
    expect(captureOptions(0).fingerprint).toEqual([
      'agent-attachments-strip-image-metadata',
      'heic',
      'encoder',
      'ERR_IMAGE_MANIPULATOR_IMAGE_LOADING_FAILED',
    ]);
  });

  it('keeps two encoder error codes for one extension in separate issues without a file URI', async () => {
    const loadFailed = makeImage('file:///cache/unused.heic');
    loadFailed.saveAsync.mockRejectedValue(
      Object.assign(new Error('Could not load the image: file:///cache/original.heic'), {
        code: 'ERR_IMAGE_MANIPULATOR_IMAGE_LOADING_FAILED',
      })
    );
    await stripImageMetadata('file:///cache/original.heic', 'heic');
    const writeFailed = makeImage('file:///cache/unused.jpg');
    writeFailed.saveAsync.mockRejectedValue(
      Object.assign(new Error('Writing image data to the file has failed: /data/cache/x.jpg'), {
        code: 'ERR_IMAGE_MANIPULATOR_IMAGE_WRITE_FAILED',
      })
    );
    await stripImageMetadata('file:///cache/original.heic', 'heic');

    expect(captureOptions(0).fingerprint).toEqual([
      'agent-attachments-strip-image-metadata',
      'heic',
      'encoder',
      'ERR_IMAGE_MANIPULATOR_IMAGE_LOADING_FAILED',
    ]);
    expect(captureOptions(1).fingerprint).toEqual([
      'agent-attachments-strip-image-metadata',
      'heic',
      'encoder',
      'ERR_IMAGE_MANIPULATOR_IMAGE_WRITE_FAILED',
    ]);
    for (const part of [...captureOptions(0).fingerprint, ...captureOptions(1).fingerprint]) {
      expect(part).not.toContain('file://');
      expect(part).not.toContain('/data/cache');
    }
  });

  it('falls back to the error name when the error carries no code', async () => {
    const image = makeImage('file:///cache/unused.heic');
    image.saveAsync.mockRejectedValue(new TypeError('cannot read file:///cache/original.heic'));

    await stripImageMetadata('file:///cache/original.heic', 'heic');

    expect(captureOptions(0).fingerprint).toEqual([
      'agent-attachments-strip-image-metadata',
      'heic',
      'encoder',
      'TypeError',
    ]);
  });

  it('bounds a long error code to the fingerprint part limit', async () => {
    const code = `ERR_${'A'.repeat(200)}`;
    const image = makeImage('file:///cache/unused.heic');
    image.saveAsync.mockRejectedValue(Object.assign(new Error('encode failed'), { code }));

    await stripImageMetadata('file:///cache/original.heic', 'heic');

    const fingerprint = captureOptions(0).fingerprint;
    expect(fingerprint.slice(0, 3)).toEqual([
      'agent-attachments-strip-image-metadata',
      'heic',
      'encoder',
    ]);
    expect(fingerprint[3]).toBe(code.slice(0, 120));
  });
});
