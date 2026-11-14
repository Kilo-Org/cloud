import { beforeEach, describe, expect, it, vi } from 'vitest';

import { stripImageMetadata, strippedExtension } from './strip-image-metadata';

const mocks = vi.hoisted(() => ({
  manipulateAsync: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('expo-image-manipulator', () => ({
  SaveFormat: { PNG: 'png', WEBP: 'webp', JPEG: 'jpeg' },
  manipulateAsync: mocks.manipulateAsync,
}));

vi.mock('@sentry/react-native', () => ({
  captureException: mocks.captureException,
}));

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
    const call = mocks.captureException.mock.calls[index] as [Error, CaptureOptions] | undefined;
    if (call === undefined) {
      throw new Error(`no capture at index ${index}`);
    }
    return call[1];
  }

  beforeEach(() => {
    mocks.manipulateAsync.mockReset();
    mocks.captureException.mockReset();
  });

  it('re-encodes with the matching save format and returns the new URI and extension', async () => {
    mocks.manipulateAsync.mockResolvedValue({ uri: 'file:///cache/stripped.png' });

    const result = await stripImageMetadata('file:///cache/original.png', 'png');

    expect(mocks.manipulateAsync).toHaveBeenCalledWith('file:///cache/original.png', [], {
      compress: 1,
      format: 'png',
    });
    expect(result).toEqual({
      ok: true,
      uri: 'file:///cache/stripped.png',
      extension: 'png',
    });
  });

  it('re-encodes heic and heif with the JPEG save format', async () => {
    mocks.manipulateAsync.mockResolvedValue({ uri: 'file:///cache/stripped.jpg' });

    await stripImageMetadata('file:///cache/original.heic', 'heic');
    expect(mocks.manipulateAsync).toHaveBeenCalledWith('file:///cache/original.heic', [], {
      compress: 1,
      format: 'jpeg',
    });

    await stripImageMetadata('file:///cache/original.heif', 'heif');
    expect(mocks.manipulateAsync).toHaveBeenCalledWith('file:///cache/original.heif', [], {
      compress: 1,
      format: 'jpeg',
    });
  });

  it('retries once with a forced JPEG output when the format-matched re-encode fails', async () => {
    mocks.manipulateAsync
      .mockRejectedValueOnce(new Error('webp encode failed'))
      .mockResolvedValueOnce({ uri: 'file:///cache/stripped.jpg' });

    const result = await stripImageMetadata('file:///cache/original.webp', 'webp');

    expect(mocks.manipulateAsync).toHaveBeenCalledTimes(2);
    expect(mocks.manipulateAsync).toHaveBeenLastCalledWith('file:///cache/original.webp', [], {
      compress: 1,
      format: 'jpeg',
    });
    expect(result).toEqual({ ok: true, uri: 'file:///cache/stripped.jpg', extension: 'jpg' });
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it('reports the caught cause and names the encoder failure in the fingerprint', async () => {
    const firstError = new Error('webp encode failed');
    const retryError = new Error('jpeg retry failed');
    mocks.manipulateAsync.mockRejectedValueOnce(firstError).mockRejectedValueOnce(retryError);

    const result = await stripImageMetadata('file:///cache/original.webp', 'webp');

    expect(mocks.manipulateAsync).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ ok: false });
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    const [reported] = mocks.captureException.mock.calls[0] as [Error, CaptureOptions];
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
    mocks.manipulateAsync.mockRejectedValue(new Error('jpeg encode failed'));

    const result = await stripImageMetadata('file:///cache/original.heic', 'heic');

    expect(mocks.manipulateAsync).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: false });
    const [reported] = mocks.captureException.mock.calls[0] as [Error];
    expect(reported.cause).toMatchObject({ message: 'jpeg encode failed' });
  });

  it('treats a re-encode that resolves to the input URI as a failure', async () => {
    mocks.manipulateAsync.mockResolvedValue({ uri: 'file:///cache/original.png' });

    const result = await stripImageMetadata('file:///cache/original.png', 'png');

    expect(result).toEqual({ ok: false });
    const [reported] = mocks.captureException.mock.calls[0] as [Error];
    expect(reported.cause).toMatchObject({ message: 'Re-encode resolved to the input URI' });
    expect(captureOptions(0).fingerprint).toEqual([
      'agent-attachments-strip-image-metadata',
      'png',
      'input-uri',
    ]);
  });

  it('keeps the input-uri cause and an encoder failure for one extension in separate issues', async () => {
    mocks.manipulateAsync.mockResolvedValue({ uri: 'file:///cache/original.png' });
    await stripImageMetadata('file:///cache/original.png', 'png');
    mocks.manipulateAsync.mockReset();
    mocks.manipulateAsync.mockRejectedValue(
      Object.assign(new Error('Could not load the image: file:///cache/original.png'), {
        code: 'ERR_IMAGE_MANIPULATOR_IMAGE_LOADING_FAILED',
      })
    );
    await stripImageMetadata('file:///cache/original.png', 'png');

    expect(captureOptions(0).fingerprint).toEqual([
      'agent-attachments-strip-image-metadata',
      'png',
      'input-uri',
    ]);
    expect(captureOptions(1).fingerprint).toEqual([
      'agent-attachments-strip-image-metadata',
      'png',
      'encoder',
      'ERR_IMAGE_MANIPULATOR_IMAGE_LOADING_FAILED',
    ]);
  });

  it('keeps two encoder error codes for one extension in separate issues without a file URI', async () => {
    mocks.manipulateAsync.mockRejectedValueOnce(
      Object.assign(new Error('Could not load the image: file:///cache/original.heic'), {
        code: 'ERR_IMAGE_MANIPULATOR_IMAGE_LOADING_FAILED',
      })
    );
    await stripImageMetadata('file:///cache/original.heic', 'heic');
    mocks.manipulateAsync.mockRejectedValueOnce(
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
    mocks.manipulateAsync.mockRejectedValue(
      new TypeError('cannot read file:///cache/original.heic')
    );

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
    mocks.manipulateAsync.mockRejectedValue(Object.assign(new Error('encode failed'), { code }));

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
