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

  it('falls back to the original URI on failure and reports to Sentry', async () => {
    mocks.manipulateAsync.mockRejectedValue(new Error('re-encode failed'));

    const result = await stripImageMetadata('file:///cache/original.png', 'png');

    expect(result).toBe('file:///cache/original.png');
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
  });
});
