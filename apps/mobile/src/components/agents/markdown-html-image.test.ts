import { describe, expect, it } from 'vitest';

import {
  IMAGE_PREVIEW_MAX_ASPECT_RATIO,
  IMAGE_PREVIEW_MIN_ASPECT_RATIO,
} from './tool-card-attachments';

import { resolveHtmlImageAspectRatio } from './markdown-html-image';

describe('resolveHtmlImageAspectRatio', () => {
  it('returns the clamped preview ratio when both attributes parse as positive finite numbers', () => {
    expect(resolveHtmlImageAspectRatio('1600', '900')).toBeCloseTo(1600 / 900);
    expect(resolveHtmlImageAspectRatio('400', '2000')).toBe(IMAGE_PREVIEW_MIN_ASPECT_RATIO);
    expect(resolveHtmlImageAspectRatio('4000', '500')).toBe(IMAGE_PREVIEW_MAX_ASPECT_RATIO);
  });

  it('returns undefined when an attribute is missing, unparsable, or not positive', () => {
    expect(resolveHtmlImageAspectRatio(undefined, '900')).toBeUndefined();
    expect(resolveHtmlImageAspectRatio('1600', undefined)).toBeUndefined();
    expect(resolveHtmlImageAspectRatio('400px', '900')).toBeUndefined();
    expect(resolveHtmlImageAspectRatio('1600', 'auto')).toBeUndefined();
    expect(resolveHtmlImageAspectRatio('', '900')).toBeUndefined();
    expect(resolveHtmlImageAspectRatio('0', '900')).toBeUndefined();
    expect(resolveHtmlImageAspectRatio('1600', '-1')).toBeUndefined();
  });
});
