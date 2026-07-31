import { describe, expect, it } from 'vitest';

import { getFilename } from './tool-card-utils';

/**
 * Replicates the image-attachment label logic from ToolCardImageAttachments.
 * Kept in sync by review when the component changes.
 */
function resolveImageAttachmentLabel(
  tool: string,
  attachmentFilename: string | undefined,
  inputFilePath: unknown
): string {
  const filePath = typeof inputFilePath === 'string' ? inputFilePath : '';
  return attachmentFilename || getFilename(filePath) || tool;
}

describe('resolveImageAttachmentLabel', () => {
  it('prefers the attachment filename over the tool input filePath', () => {
    expect(resolveImageAttachmentLabel('read', 'photo.jpg', '/workspace/screenshot.png')).toBe(
      'photo.jpg'
    );
  });

  it('falls back to the input filePath basename when no attachment filename', () => {
    expect(resolveImageAttachmentLabel('read', undefined, '/workspace/screenshot.png')).toBe(
      'screenshot.png'
    );
  });

  it('falls back to the tool name when both are missing', () => {
    expect(resolveImageAttachmentLabel('read', undefined, undefined)).toBe('read');
  });

  it('ignores a non-string filePath', () => {
    expect(resolveImageAttachmentLabel('read', undefined, { nested: true })).toBe('read');
  });
});
