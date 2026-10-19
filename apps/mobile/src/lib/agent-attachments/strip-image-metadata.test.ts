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

  it('reports the caught cause, the input extension, and a per-extension fingerprint when every attempt fails', async () => {
    const firstError = new Error('jpeg encode failed');
    const retryError = new Error('jpeg retry failed');
    mocks.manipulateAsync.mockRejectedValueOnce(firstError).mockRejectedValueOnce(retryError);

    const result = await stripImageMetadata('file:///cache/original.heic', 'heic');

    expect(mocks.manipulateAsync).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ ok: false });
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    const [reported, options] = mocks.captureException.mock.calls[0] as [
      Error,
      { extra: { inputExtension: string }; fingerprint: string[] },
    ];
    expect(reported).toBeInstanceOf(Error);
    expect(reported.message).toBe('Attachment image metadata strip failed');
    expect(reported.cause).toBe(retryError);
    expect(options.extra).toEqual({ inputExtension: 'heic' });
    expect(options.fingerprint).toEqual(['agent-attachments-strip-image-metadata', 'heic']);
  });
});
