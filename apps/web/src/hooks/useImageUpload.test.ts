import {
  buildImageUploadPath,
  calculateResizeDimensions,
  isAllowedImageType,
  validateImageFileSize,
} from './useImageUpload';

function createFile(size: number, type = 'image/png') {
  return new File([new Uint8Array(size)], 'image.png', { type });
}

describe('buildImageUploadPath', () => {
  it('uses the message UUID as the image path', () => {
    expect(buildImageUploadPath('message-uuid')).toBe('message-uuid');
  });
});

describe('calculateResizeDimensions', () => {
  it('resizes landscape images to the max longest side', () => {
    expect(calculateResizeDimensions(3000, 1500, 1536)).toEqual({ width: 1536, height: 768 });
  });

  it('resizes portrait images to the max longest side', () => {
    expect(calculateResizeDimensions(1500, 3000, 1536)).toEqual({ width: 768, height: 1536 });
  });

  it('resizes square images to the max longest side', () => {
    expect(calculateResizeDimensions(3000, 3000, 1536)).toEqual({ width: 1536, height: 1536 });
  });

  it('does not upscale smaller images', () => {
    expect(calculateResizeDimensions(800, 600, 1536)).toEqual({ width: 800, height: 600 });
  });
});

describe('image upload validation helpers', () => {
  it('defaults can preserve app-builder 5MB original/final semantics', () => {
    const maxSizeBytes = 5 * 1024 * 1024;
    const file = createFile(maxSizeBytes + 1);

    expect(validateImageFileSize(file, maxSizeBytes, 'Original file')).toContain(
      'Original file too large'
    );
    expect(validateImageFileSize(file, maxSizeBytes, 'Final file')).toContain(
      'Final file too large'
    );
  });

  it('supports cloud-agent 10MB original and 5MB final semantics', () => {
    const originalMaxSizeBytes = 10 * 1024 * 1024;
    const finalMaxSizeBytes = 5 * 1024 * 1024;
    const originalFile = createFile(8 * 1024 * 1024);
    const finalFile = createFile(finalMaxSizeBytes + 1);

    expect(validateImageFileSize(originalFile, originalMaxSizeBytes, 'Original file')).toBeNull();
    expect(validateImageFileSize(finalFile, finalMaxSizeBytes, 'Final file')).toContain(
      'Final file too large'
    );
  });

  it('respects configurable allowed image types', () => {
    expect(isAllowedImageType('image/webp', ['image/png', 'image/webp'])).toBe(true);
    expect(isAllowedImageType('image/jpeg', ['image/png', 'image/webp'])).toBe(false);
  });
});
