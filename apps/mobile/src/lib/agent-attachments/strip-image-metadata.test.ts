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

  it('re-encodes with the matching save format and returns the new URI', async () => {
    mocks.manipulateAsync.mockResolvedValue({ uri: 'file:///cache/stripped.png' });

    const result = await stripImageMetadata('file:///cache/original.png', 'png');

    expect(mocks.manipulateAsync).toHaveBeenCalledWith('file:///cache/original.png', [], {
      compress: 1,
      format: 'png',
    });
    expect(result).toBe('file:///cache/stripped.png');
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

  it('falls back to the original URI on failure and reports to Sentry', async () => {
    mocks.manipulateAsync.mockRejectedValue(new Error('re-encode failed'));

    const result = await stripImageMetadata('file:///cache/original.png', 'png');

    expect(result).toBe('file:///cache/original.png');
    expect(mocks.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: {
        'error.subsystem': 'agent-attachments',
        'error.operation': 'strip-image-metadata',
      },
      extra: { outputExtension: 'png' },
      fingerprint: ['agent-attachments-strip-image-metadata'],
    });
  });
});
