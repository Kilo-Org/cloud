import { describe, it, expect } from 'vitest';
import {
  ImageVersionEntrySchema,
  ImageVariantSchema,
  imageVersionKey,
  imageVersionLatestKey,
} from './image-version';

describe('imageVersionKey', () => {
  it('produces the expected key format', () => {
    expect(imageVersionKey('2026.2.9', 'default')).toBe('image-version:2026.2.9:default');
  });

  it('throws when version is "latest"', () => {
    expect(() => imageVersionKey('latest', 'default')).toThrow('Cannot use "latest" as a version');
  });
});

describe('imageVersionLatestKey', () => {
  it('produces the expected key format', () => {
    expect(imageVersionLatestKey('default')).toBe('image-version:latest:default');
  });
});

describe('ImageVariantSchema', () => {
  it('accepts "default"', () => {
    expect(ImageVariantSchema.parse('default')).toBe('default');
  });

  it('rejects unknown variants', () => {
    const result = ImageVariantSchema.safeParse('secure');
    expect(result.success).toBe(false);
  });
});

describe('ImageVersionEntrySchema', () => {
  it('parses a valid entry and applies rolloutPercent / isLatest defaults', () => {
    const entry = {
      openclawVersion: '2026.2.9',
      variant: 'default',
      imageTag: 'dev-123',
      imageDigest: null,
      publishedAt: '2026-02-22T18:00:00Z',
    };
    // rolloutPercent and isLatest both default to 0 / false when omitted.
    expect(ImageVersionEntrySchema.parse(entry)).toEqual({
      ...entry,
      rolloutPercent: 0,
      isLatest: false,
    });
  });

  it('accepts imageDigest as a string', () => {
    const entry = {
      openclawVersion: '2026.2.9',
      variant: 'default',
      imageTag: 'dev-123',
      imageDigest: 'sha256:abc123',
      publishedAt: '2026-02-22T18:00:00Z',
    };
    expect(ImageVersionEntrySchema.parse(entry)).toEqual({
      ...entry,
      rolloutPercent: 0,
      isLatest: false,
    });
  });

  it('rejects invalid variant', () => {
    const entry = {
      openclawVersion: '2026.2.9',
      variant: 'unknown',
      imageTag: 'dev-123',
      imageDigest: null,
      publishedAt: '2026-02-22T18:00:00Z',
    };
    const result = ImageVersionEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  it('rejects missing required fields', () => {
    const result = ImageVersionEntrySchema.safeParse({ openclawVersion: '2026.2.9' });
    expect(result.success).toBe(false);
  });
});
